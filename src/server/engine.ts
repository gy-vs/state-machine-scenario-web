import { deepFreeze, evalGuard, guardError, parseGuard } from '../shared/expr';
import { diffJson } from '../shared/diff';
import type {
  ActionDef,
  Cancellation,
  DiffEntry,
  GuardNode,
  JsonObject,
  MachineDef,
  QueueEntryView,
  ScenarioDef,
  ScenarioEvent,
  Step,
  StepKind,
  StructuredError,
  TransitionDef,
} from '../shared/types';
import { ActionRegistry } from './actionRegistry';

interface QEntry {
  id: string;
  type: string;
  at: number;
  /** 同刻批道：初始/未来事件为 0；动作在当前时刻派发的进入 currentLane+1，保证不插队 */
  lane: number;
  priority: number;
  /** 入队序号：同刻同 lane 决胜的最后兜底（先入先出） */
  seq: number;
  origin: 'scenario' | 'action' | 'external';
  payload?: JsonObject;
  cancelRef?: string;
  cancelMode?: 'id' | 'type';
}

export interface EngineSnapshot {
  currentTime: number;
  state: string;
  context: JsonObject;
  steps: Step[];
  queue: QueueEntryView[];
  status: 'idle' | 'running' | 'completed' | 'terminated' | 'boundary';
  failures: StructuredError[];
}

export class DeterminismError extends Error {
  structured: StructuredError;
  constructor(s: StructuredError) {
    super(s.message);
    this.structured = s;
  }
}

interface ActionRuntime {
  assign: (path: string, value: JsonObject | JSONLike) => void;
  raise: (event: string, payload?: JsonObject, at?: number) => void;
  cancel: (ref: string, mode?: 'id' | 'type') => void;
  fail: (code: string, message: string) => never;
}

type JSONLike = import('../shared/types').JSONValue;

/**
 * 确定性虚拟时钟引擎（单线程、同步微步）。
 *
 * 同刻决胜键（从小到大）：time → lane → priority（大者先）→ 入队 seq（先入先出）。
 * 关键不变量：动作派发的新事件一律进入“后批道”（当前 lane+1），
 * 因此同刻批处理中产生的事件不可能排到当前批次之前。
 */
export class Engine {
  private machine: MachineDef;
  private registry: ActionRegistry;
  private queue: QEntry[] = [];
  private state: string;
  private context: JsonObject;
  private currentTime = 0;
  private currentLane = 0;
  private enqueueSeq = 0;
  private raiseCounter = 0;
  private steps: Step[] = [];
  private failures: StructuredError[] = [];
  private status: EngineSnapshot['status'] = 'idle';
  private maxSteps: number;
  private knownIds = new Set<string>();

  constructor(machine: MachineDef, scenario: ScenarioDef, registry: ActionRegistry) {
    validateMachine(machine, registry);
    this.machine = structuredClone(machine);
    this.registry = registry;
    this.state = this.machine.initial;
    this.context = structuredClone(this.machine.context ?? {});
    this.maxSteps = scenario.maxSteps ?? 1000;
    for (const ev of [...scenario.events].sort(
      (a, b) => a.at - b.at || (b.priority ?? 0) - (a.priority ?? 0),
    )) {
      this.enqueueInitial(ev);
    }
    this.status = this.queue.length ? 'idle' : 'completed';
  }

  get currentState(): string {
    return this.state;
  }

  get time(): number {
    return this.currentTime;
  }

  get engineStatus(): EngineSnapshot['status'] {
    return this.status;
  }

  /** 已确认（应用/跳过/取消/失败）的最后事件步骤序号 */
  get lastAppliedSeq(): number {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const k = this.steps[i].kind;
      if (k !== 'expired' && k !== 'boundary') return this.steps[i].seq;
    }
    return 0;
  }

  hasProcessed(id: string): boolean {
    return this.knownIds.has(id);
  }

  /** 外部追加激励；不允许注入过去时刻 */
  enqueueExternal(ev: ScenarioEvent): void {
    if (this.knownIds.has(ev.id)) {
      throw new DeterminismError({
        code: 'EVENT_DUP_ID',
        message: `事件 id 已存在: ${ev.id}`,
        phase: 'session',
        at: ev.at,
        eventId: ev.id,
      });
    }
    if (this.status === 'terminated' || this.status === 'boundary') {
      throw new DeterminismError({
        code: 'SESSION_NOT_RUNNING',
        message: `情景已${this.status === 'terminated' ? '终止' : '到达执行边界'}，无法追加事件`,
        phase: 'session',
        at: this.currentTime,
      });
    }
    if (ev.at < this.currentTime) {
      throw new DeterminismError({
        code: 'EVENT_IN_PAST',
        message: `不能向过去时刻注入事件：at=${ev.at} < currentTime=${this.currentTime}`,
        phase: 'session',
        at: this.currentTime,
        eventId: ev.id,
        detail: { requestedAt: ev.at },
      });
    }
    // 与当前时刻相等时进入后批道，保证不抢占当前批次
    const lane = ev.at === this.currentTime ? this.currentLane + 1 : 0;
    this.push({
      id: ev.id,
      type: ev.type,
      at: ev.at,
      lane,
      priority: ev.priority ?? 0,
      seq: ++this.enqueueSeq,
      origin: 'external',
      payload: ev.payload ? structuredClone(ev.payload) : undefined,
      cancelRef: ev.cancelRef,
      cancelMode: ev.cancelMode,
    });
    this.knownIds.add(ev.id);
    if (this.status === 'completed') this.status = 'idle';
  }

  private enqueueInitial(ev: ScenarioEvent): void {
    if (this.knownIds.has(ev.id)) {
      throw new DeterminismError({
        code: 'EVENT_DUP_ID',
        message: `情景事件 id 重复: ${ev.id}`,
        phase: 'machine',
        at: ev.at,
        eventId: ev.id,
      });
    }
    this.push({
      id: ev.id,
      type: ev.type,
      at: ev.at,
      lane: 0,
      priority: ev.priority ?? 0,
      seq: ++this.enqueueSeq,
      origin: 'scenario',
      payload: ev.payload ? structuredClone(ev.payload) : undefined,
      cancelRef: ev.cancelRef,
      cancelMode: ev.cancelMode,
    });
    this.knownIds.add(ev.id);
  }

  private push(e: QEntry): void {
    this.queue.push(e);
    this.queue.sort(compareEntry);
  }

  /**
   * 执行一个微步：出队排序键最小的事件。
   * 取消信号会先移除全部匹配的待处理事件（每个产生一条 canceled 步骤），
   * 随后才应用信号自身；返回数组末元素始终是信号事件自己的步骤。
   */
  advanceOne(): Step[] {
    if (this.status === 'terminated' || this.status === 'boundary') return [];
    if (this.steps.length >= this.maxSteps) {
      const s = this.recordBoundary();
      this.steps.push(s);
      return [s];
    }

    const entry = this.queue.shift();
    if (!entry) {
      if (this.status !== 'completed') {
        this.status = 'completed';
        const s = this.recordExpired();
        this.steps.push(s);
        return [s];
      }
      return [];
    }

    if (entry.at !== this.currentTime) {
      this.currentTime = entry.at;
      this.currentLane = entry.lane;
    } else if (entry.lane > this.currentLane) {
      this.currentLane = entry.lane;
    }

    const out: Step[] = [];
    let seqBase = this.steps.length;

    // 取消与后续转移共用同一支草稿：转移失败整笔回滚时，被取消事件一并恢复
    const queueDraft = [...this.queue];
    const cancellations: Cancellation[] = [];
    let canceledSteps: Step[] = [];

    // 阶段 1：取消语义（信号自身的转移尚未开始，取消永远先于其动作）
    if (entry.cancelRef) {
      const mode = entry.cancelMode ?? 'id';
      const kept: QEntry[] = [];
      for (const victim of queueDraft) {
        const hit = mode === 'id' ? victim.id === entry.cancelRef : victim.type === entry.cancelRef;
        if (hit) {
          const c: Cancellation = { ref: entry.cancelRef!, mode, byEventId: entry.id };
          cancellations.push(c);
          canceledSteps.push(
            this.buildStep(victim, ++seqBase, 'canceled', {
              fromState: this.state,
              toState: this.state,
              timeOverride: this.currentTime,
              laneOverride: this.currentLane,
              cancellations: [c],
            }),
          );
        } else {
          kept.push(victim);
        }
      }
      queueDraft.length = 0;
      queueDraft.push(...kept);
    }

    // 阶段 2：状态机转移（草稿执行，失败整笔回滚——含取消效果）
    const { step, kind, committed } = this.applyEvent(entry, ++seqBase, cancellations, queueDraft);
    if (committed) {
      out.push(...canceledSteps, step);
      this.steps.push(...out);
    } else {
      out.push(step);
      this.steps.push(step);
    }

    if (kind === 'terminated') this.status = 'terminated';
    else if (this.queue.length === 0) this.status = 'completed';
    else this.status = 'running';
    return out;
  }

  private applyEvent(
    entry: QEntry,
    seq: number,
    signalCancellations: Cancellation[],
    queueDraft: QEntry[],
  ): { step: Step; kind: StepKind; committed: boolean } {
    const beforeState = this.state;
    const beforeContext = structuredClone(this.context);

    const stateDef = this.machine.states[this.state];
    const candidates = [
      ...stateDef.transitions.filter((t) => t.on === entry.type),
      ...stateDef.transitions.filter((t) => t.on === '*'),
    ];
    const guardRejects: NonNullable<Step['guardRejects']> = [];
    let taken: TransitionDef | null = null;
    let takenGuardTrace: Step['guard'];

    for (const t of candidates) {
      if (!t.guard) {
        taken = t;
        break;
      }
      const trace = this.evalGuard(t, entry);
      if (trace.error) {
        // 守卫自身抛错：不再尝试后续候选，直接走失败策略
        return this.fail(entry, seq, beforeState, t, trace.error, guardRejects, [], signalCancellations);
      }
      if (trace.result) {
        taken = t;
        takenGuardTrace = { source: t.guardSource, result: true };
        break;
      }
      guardRejects.push({ on: t.on, source: t.guardSource });
    }

    if (!taken) {
      // 跳过转移，但取消语义独立于机器转移：提交队列草稿（移除生效）
      this.queue = queueDraft.sort(compareEntry);
      return {
        step: this.buildStep(entry, seq, 'skipped', {
          fromState: this.state,
          toState: this.state,
          guardRejects: guardRejects.length ? guardRejects : undefined,
          cancellations: signalCancellations.length ? signalCancellations : undefined,
          stateChanged: false,
        }),
        kind: 'skipped',
        committed: true,
      };
    }

    // —— 草稿区：失败即丢弃，state/context/queue（含取消与动作派发）保持转移前 ——
    const ctxDraft = structuredClone(this.context);
    const raised: NonNullable<Step['raised']> = [];
    const actionCancellations: Cancellation[] = [];
    const actionNames: string[] = [];
    const eventView = deepFreeze({
      id: entry.id,
      type: entry.type,
      payload: entry.payload ? structuredClone(entry.payload) : undefined,
    });
    const api = this.makeRuntime(entry, queueDraft, raised, actionCancellations, ctxDraft);

    let error: StructuredError | undefined;
    let targetState = this.state;

    const runList = (list: ActionDef[] | undefined, label: string): StructuredError | undefined => {
      for (const a of list ?? []) {
        actionNames.push(`${label}:${describeAction(a)}`);
        const err = this.runOne(a, ctxDraft, eventView, api);
        if (err) return err;
      }
      return undefined;
    };

    error = runList(stateDef.exit, 'exit');
    if (!error) {
      if (taken.target) targetState = taken.target;
      error = runList(taken.actions, 'action');
    }
    if (!error && taken.target) {
      error = runList(this.machine.states[taken.target]?.entry, 'entry');
    }

    if (error) {
      return this.fail(entry, seq, beforeState, taken, error, guardRejects, actionNames, signalCancellations);
    }

    // —— 提交 ——
    this.context = ctxDraft;
    this.queue = queueDraft.sort(compareEntry);
    this.state = targetState;

    const d = diffJson(beforeContext, this.context);
    return {
      step: this.buildStep(entry, seq, 'applied', {
        fromState: beforeState,
        toState: targetState,
        taken,
        guard: takenGuardTrace,
        guardRejects: guardRejects.length ? guardRejects : undefined,
        actions: actionNames,
        raised: raised.length ? raised : undefined,
        cancellations:
          signalCancellations.length || actionCancellations.length
            ? [...signalCancellations, ...actionCancellations]
            : undefined,
        diff: d,
        stateChanged: beforeState !== targetState || d.length > 0,
      }),
      kind: 'applied',
      committed: true,
    };
  }

  private makeRuntime(
    entry: QEntry,
    queueDraft: QEntry[],
    raised: NonNullable<Step['raised']>,
    actionCancellations: Cancellation[],
    ctxDraft: JsonObject,
  ): ActionRuntime {
    return {
      assign: (path, value) => setPath(ctxDraft, path, structuredClone(value)),
      raise: (event, payload, at) => {
        const id = `raised#${++this.raiseCounter}`;
        const past = at === undefined || at < this.currentTime;
        const effectiveAt = past ? this.currentTime : at;
        // 关键：当前时刻（含被钳制的“过去派发”）一律进后批道
        const lane = at !== undefined && at > this.currentTime ? 0 : this.currentLane + 1;
        queueDraft.push({
          id,
          type: event,
          at: effectiveAt,
          lane,
          priority: 0,
          seq: ++this.enqueueSeq,
          origin: 'action',
          payload: payload ? structuredClone(payload) : undefined,
        });
        raised.push({ id, type: event, at: effectiveAt, lane, priority: 0 });
        if (past && at !== undefined) {
          this.failures.push({
            code: 'RAISE_CLAMPED_PAST',
            message: `动作派发事件 at=${at} 早于当前时刻 ${this.currentTime}，已钳制到当前时刻后批道`,
            phase: 'engine',
            at: this.currentTime,
            eventId: entry.id,
            detail: { raisedEvent: event, requestedAt: at },
          });
        }
      },
      cancel: (ref, mode = 'id') => {
        for (let i = queueDraft.length - 1; i >= 0; i--) {
          const v = queueDraft[i];
          if ((mode === 'id' && v.id === ref) || (mode === 'type' && v.type === ref)) {
            queueDraft.splice(i, 1);
            actionCancellations.push({ ref, mode, byEventId: entry.id });
          }
        }
      },
      fail: (code, message): never => {
        throw new DeterminismError({
          code,
          message,
          phase: 'action',
          at: this.currentTime,
          eventId: entry.id,
        });
      },
    };
  }

  private evalGuard(t: TransitionDef, entry: QEntry): { result: boolean; error?: StructuredError } {
    try {
      const value = evalGuard(t.guard!, {
        ctx: this.context,
        event: { id: entry.id, type: entry.type, payload: entry.payload },
      });
      return { result: Boolean(value) };
    } catch (err) {
      return { result: false, error: guardError(err, this.currentTime, entry.id) };
    }
  }

  private runOne(
    a: ActionDef,
    ctxDraft: JsonObject,
    eventView: { id: string; type: string; payload?: JsonObject },
    api: ActionRuntime,
  ): StructuredError | undefined {
    try {
      switch (a.type) {
        case 'assign': {
          api.assign(a.path, evalGuard(a.value, { ctx: ctxDraft, event: eventView }));
          return;
        }
        case 'raise': {
          const payload = a.payload
            ? (evalGuard(a.payload, { ctx: ctxDraft, event: eventView }) as JsonObject | undefined)
            : undefined;
          api.raise(a.event, payload ?? undefined, a.at);
          return;
        }
        case 'cancel':
          api.cancel(a.ref, a.mode);
          return;
        case 'fail':
          api.fail(a.code, a.message);
          return;
        case 'name': {
          const injected = this.registry.get(a.name);
          if (injected) {
            injected(deepFreeze(structuredClone(ctxDraft)), deepFreeze(structuredClone(eventView)), api);
            return;
          }
          const builtin = this.machine.actions?.[a.name];
          if (builtin) {
            for (const sub of builtin) {
              const err = this.runOne(sub, ctxDraft, eventView, api);
              if (err) return { ...err, action: a.name };
            }
            return;
          }
          return {
            code: 'ACTION_NOT_FOUND',
            message: `动作未在注册表注入且机内未声明: ${a.name}`,
            phase: 'action',
            at: this.currentTime,
            eventId: eventView.id,
            action: a.name,
          };
        }
      }
    } catch (err) {
      if (err instanceof DeterminismError) {
        return { ...err.structured, action: a.type === 'name' ? a.name : a.type };
      }
      return {
        code: 'ACTION_THREW',
        message: err instanceof Error ? err.message : String(err),
        phase: 'action',
        at: this.currentTime,
        eventId: eventView.id,
        action: a.type,
      };
    }
  }

  private fail(
    entry: QEntry,
    seq: number,
    beforeState: string,
    t: TransitionDef,
    error: StructuredError,
    guardRejects: NonNullable<Step['guardRejects']>,
    actions: string[],
    signalCancellations: Cancellation[],
  ): { step: Step; kind: StepKind; committed: boolean } {
    this.failures.push(error);
    const policy = this.machine.onFailure ?? 'rollback';
    const kind: StepKind = policy === 'terminate' ? 'terminated' : 'rolled-back';
    return {
      step: this.buildStep(entry, seq, kind, {
        fromState: beforeState,
        toState: beforeState,
        taken: t,
        guardRejects: guardRejects.length ? guardRejects : undefined,
        actions: actions.length ? actions : undefined,
        // 注意：取消效果随草稿整笔回滚，被取消事件仍在队列中，故不附带 cancellations
        error,
        stateChanged: false,
        diff: [],
      }),
      kind,
      // 回滚策略下信号事件已消耗（不重放），但其取消与草稿副作用都未提交
      committed: false,
    };
  }

  private buildStep(
    entry: QEntry,
    seq: number,
    kind: StepKind,
    p: {
      fromState: string;
      toState: string;
      taken?: TransitionDef;
      guard?: Step['guard'];
      guardRejects?: Step['guardRejects'];
      actions?: string[];
      raised?: Step['raised'];
      cancellations?: Cancellation[];
      diff?: DiffEntry[];
      stateChanged?: boolean;
      error?: StructuredError;
      timeOverride?: number;
      laneOverride?: number;
    },
  ): Step {
    const time = p.timeOverride ?? entry.at;
    const lane = p.laneOverride ?? entry.lane;
    return {
      seq,
      time,
      lane,
      priority: entry.priority,
      eventId: entry.id,
      eventType: entry.type,
      payload: entry.payload,
      kind,
      fromState: p.fromState,
      toState: p.toState,
      takenTransitionOn: p.taken?.on,
      target: p.taken?.target,
      guard: p.guard,
      guardRejects: p.guardRejects,
      actions: p.actions,
      raised: p.raised,
      cancellations: p.cancellations,
      stateChanged: p.stateChanged ?? p.fromState !== p.toState,
      diff: p.diff,
      error: p.error,
      orderKey: `t=${time} lane=${lane} prio=${entry.priority} seq=${entry.seq}`,
    };
  }

  private recordExpired(): Step {
    return {
      seq: this.steps.length + 1,
      time: this.currentTime,
      lane: this.currentLane,
      priority: 0,
      eventId: '~queue-drained',
      eventType: '~queue-drained',
      kind: 'expired',
      fromState: this.state,
      toState: this.state,
      stateChanged: false,
      orderKey: `t=${this.currentTime} lane=${this.currentLane} prio=0 seq=-`,
    };
  }

  private recordBoundary(): Step {
    const error: StructuredError = {
      code: 'MAX_STEPS',
      message: `达到单情景微步上限 ${this.maxSteps}，仿真停止（防止失控嵌套派发）`,
      phase: 'engine',
      at: this.currentTime,
    };
    this.failures.push(error);
    this.status = 'boundary';
    return {
      seq: this.steps.length + 1,
      time: this.currentTime,
      lane: this.currentLane,
      priority: 0,
      eventId: '~max-steps',
      eventType: '~max-steps',
      kind: 'boundary',
      fromState: this.state,
      toState: this.state,
      stateChanged: false,
      error,
      orderKey: `t=${this.currentTime} lane=${this.currentLane}`,
    };
  }

  snapshot(): EngineSnapshot {
    return {
      currentTime: this.currentTime,
      state: this.state,
      context: structuredClone(this.context),
      steps: structuredClone(this.steps),
      queue: this.queue.map((e) => ({
        id: e.id,
        type: e.type,
        at: e.at,
        lane: e.lane,
        priority: e.priority,
        seq: e.seq,
        origin: e.origin,
        payload: e.payload ? structuredClone(e.payload) : undefined,
        cancelRef: e.cancelRef,
        cancelMode: e.cancelMode,
      })),
      status: this.status,
      failures: structuredClone(this.failures),
    };
  }
}

function compareEntry(a: QEntry, b: QEntry): number {
  return a.at - b.at || a.lane - b.lane || b.priority - a.priority || a.seq - b.seq;
}

function setPath(target: JsonObject, path: string, value: JSONLike): void {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[["']([^"']+)["']\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  if (parts.length === 0) throw new Error('assign 路径为空');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    if (cur[k] === undefined || cur[k] === null) cur[k] = nextIsIndex ? [] : {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function describeAction(a: ActionDef): string {
  switch (a.type) {
    case 'assign':
      return `assign(${a.path})`;
    case 'raise':
      return `raise(${a.event}${a.at !== undefined ? `@${a.at}` : ''})`;
    case 'cancel':
      return `cancel(${a.mode}:${a.ref})`;
    case 'fail':
      return `fail(${a.code})`;
    case 'name':
      return a.name;
  }
}

export function validateMachine(machine: MachineDef, registry: ActionRegistry): void {
  const errors: string[] = [];
  if (!machine.initial || !machine.states[machine.initial]) {
    errors.push(`initial 状态不存在: ${machine.initial}`);
  }
  const checkList = (list: ActionDef[] | undefined, owner: string, where: string, namedBody = false) => {
    for (const a of list ?? []) {
      if (a.type === 'name' && !namedBody && !registry.has(a.name) && !machine.actions?.[a.name]) {
        errors.push(`状态 ${owner} (${where}) 引用了未注册动作: ${a.name}`);
      }
    }
  };
  for (const [name, s] of Object.entries(machine.states)) {
    for (const t of s.transitions ?? []) {
      if (t.target && !machine.states[t.target]) {
        errors.push(`状态 ${name} 的转移目标不存在: ${t.target}`);
      }
      if (t.guardSource && !t.guard) {
        try {
          (t as TransitionDef).guard = parseGuard(t.guardSource);
        } catch (err) {
          errors.push(`状态 ${name} on=${t.on} 守卫解析失败: ${(err as Error).message}`);
        }
      } else if (t.guard && !t.guardSource) {
        t.guardSource = '(AST)';
      }
      checkList(t.actions, name, `on=${t.on}`);
    }
    checkList(s.entry, name, 'entry');
    checkList(s.exit, name, 'exit');
  }
  for (const [name, list] of Object.entries(machine.actions ?? {})) {
    checkList(list, name, `action:${name}`, true);
  }
  if (errors.length) {
    throw new DeterminismError({
      code: 'MACHINE_INVALID',
      message: '状态机定义校验失败',
      phase: 'machine',
      at: 0,
      detail: { errors },
    });
  }
}
