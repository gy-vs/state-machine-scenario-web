// 确定性虚拟时钟仿真引擎。
//
// 核心语义：
//  - 事件按 (虚拟时刻, 优先级, 序列号) 全序排列，同刻事件决胜顺序明确；
//  - 处理某时刻时先把该时刻已入队的事件整体取出为一个"批次"，
//    动作派生（raise）的新事件进入 deferred，绝不插到当前批次之前；
//  - 取消信号本身也是一个有序事件（$cancel），与目标事件的完成竞争由同一全序决定；
//  - 守卫/动作抛错时产生结构化错误，按 onError 策略回滚当前转移或终止情景。

import type {
  ContextDiffEntry,
  JsonObject,
  MachineDef,
  QueuedEventView,
  ScenarioDef,
  ScenarioEvent,
  StepRecord,
  StructuredError,
  TransitionDef,
} from '../shared/types';

export interface GuardInput {
  context: JsonObject;
  event: { type: string; payload?: unknown };
  state: string;
  clock: number;
}

export interface ActionApi {
  clock: number;
  raise(event: ScenarioEvent, delay?: number): void;
  cancel(token: string): void;
  assign(patch: JsonObject): void;
}

export type GuardFn = (input: GuardInput) => boolean;
export type ActionFn = (input: GuardInput, api: ActionApi) => void;

export interface Registry {
  guards: Record<string, GuardFn>;
  actions: Record<string, ActionFn>;
}

interface SimEvent {
  id: number;
  time: number;
  priority: number;
  type: string;
  payload?: unknown;
  token?: string;
  source: 'scenario' | 'raised' | 'injected';
}

const CANCEL_TYPE = '$cancel';
const MAX_QUEUE = 1000; // 有界事件队列，防止动作无限派生拖垮会话

function compare(a: SimEvent, b: SimEvent): number {
  return a.time - b.time || a.priority - b.priority || a.id - b.id;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Engine {
  clock = 0;
  state: string;
  context: JsonObject;
  status: 'idle' | 'running' | 'done' | 'aborted' = 'idle';
  stepsApplied = 0;
  lastError?: StructuredError;

  private queue: SimEvent[] = []; // 已排序的主队列
  private batch: SimEvent[] = []; // 当前时刻正在处理的批次
  private deferred: SimEvent[] = []; // 批次处理期间派生的事件
  private nextId = 1;
  private cancelledTokens = new Set<string>();
  private readonly onError: 'rollback' | 'abort';

  constructor(
    private def: MachineDef,
    private registry: Registry,
    onError: 'rollback' | 'abort' = 'rollback',
  ) {
    if (!def.states[def.initial]) {
      throw new Error(`initial state '${def.initial}' is not defined in states`);
    }
    this.state = def.initial;
    this.context = structuredClone(def.context ?? {});
    this.onError = onError;
  }

  loadScenario(scenario: ScenarioDef): void {
    // 稳定排序：同一 at 的步骤保持声明顺序
    const steps = [...scenario.steps].sort((a, b) => a.at - b.at);
    for (const step of steps) {
      for (const ev of step.send ?? []) this.schedule(ev, step.at, 'scenario');
      if (step.cancel != null) {
        this.enqueue({
          time: step.at,
          priority: step.priority ?? 0,
          type: CANCEL_TYPE,
          payload: { token: step.cancel },
          source: 'scenario',
        });
      }
    }
  }

  schedule(ev: ScenarioEvent, at: number, source: SimEvent['source']): void {
    this.enqueue({
      time: at,
      priority: ev.priority ?? 0,
      type: ev.type,
      payload: ev.payload,
      token: ev.token,
      source,
    });
  }

  /** 外部注入（相对当前虚拟时钟的延迟）。会话结束后注入可重新唤醒引擎。 */
  inject(ev: ScenarioEvent, delay = 0): void {
    if (this.status === 'done') this.status = 'idle';
    this.schedule(ev, this.clock + delay, 'injected');
  }

  pending(): QueuedEventView[] {
    return [...this.batch, ...this.queue, ...this.deferred].sort(compare).map((e) => ({
      id: e.id,
      time: e.time,
      priority: e.priority,
      type: e.type,
      token: e.token,
      source: e.source,
    }));
  }

  /** 推进一个事件（不是整个批次），返回该步记录；队列耗尽返回 null。 */
  stepOnce(): StepRecord | null {
    if (this.status === 'done' || this.status === 'aborted') return null;

    if (this.batch.length === 0) {
      // 当前批次已清空：把批次期间派生的事件并入主队列。
      // 它们的 id 更大，按 (time, priority, id) 排序自然排在既有同刻事件之后。
      if (this.deferred.length > 0) {
        for (const e of this.deferred) this.insertSorted(this.queue, e);
        this.deferred = [];
      }
      if (this.queue.length === 0) {
        this.status = 'done';
        return null;
      }
      const t = this.queue[0].time;
      this.clock = t;
      while (this.queue.length > 0 && this.queue[0].time === t) {
        this.batch.push(this.queue.shift()!);
      }
    }

    this.status = 'running';
    const ev = this.batch.shift()!;
    const rec = this.process(ev);
    this.stepsApplied++;
    return rec;
  }

  // ---------- 内部 ----------

  private makeEvent(partial: Omit<SimEvent, 'id'>): SimEvent {
    return { ...partial, id: this.nextId++ };
  }

  private enqueue(partial: Omit<SimEvent, 'id'>): void {
    const ev = this.makeEvent(partial);
    if (ev.token && this.cancelledTokens.has(ev.token)) return; // 胎死腹中
    this.insertSorted(this.queue, ev);
    if (this.queue.length + this.deferred.length > MAX_QUEUE) {
      this.status = 'aborted';
      this.lastError = { code: 'QUEUE_OVERFLOW', message: `event queue exceeded ${MAX_QUEUE}` };
    }
  }

  private insertSorted(arr: SimEvent[], ev: SimEvent): void {
    let i = 0;
    while (i < arr.length && compare(arr[i], ev) <= 0) i++;
    arr.splice(i, 0, ev);
  }

  private guardInput(ev: SimEvent): GuardInput {
    return {
      context: this.context,
      event: { type: ev.type, payload: ev.payload },
      state: this.state,
      clock: this.clock,
    };
  }

  private purgeToken(token: string, rec: StepRecord): void {
    this.cancelledTokens.add(token);
    const purge = (arr: SimEvent[]) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].token === token) {
          rec.cancelled.push({ id: arr[i].id, type: arr[i].type, token });
          arr.splice(i, 1);
        }
      }
    };
    purge(this.queue);
    purge(this.batch);
    purge(this.deferred);
    rec.cancelled.reverse();
  }

  private process(ev: SimEvent): StepRecord {
    const rec: StepRecord = {
      n: this.stepsApplied + 1,
      clock: this.clock,
      event: { id: ev.id, type: ev.type, payload: ev.payload, source: ev.source, token: ev.token },
      from: this.state,
      to: this.state,
      transition: false,
      guards: [],
      diff: [],
      raised: [],
      cancelled: [],
    };

    // 取消信号：与目标事件同刻时由 (priority, id) 决定谁先谁后，
    // 因此"取消与完成竞争"的结果是确定性的。
    if (ev.type === CANCEL_TYPE) {
      const token = String((ev.payload as JsonObject | undefined)?.token ?? '');
      this.purgeToken(token, rec);
      rec.note = `cancel:${token}`;
      return rec;
    }

    if (ev.token && this.cancelledTokens.has(ev.token)) {
      rec.note = 'dropped:cancelled';
      return rec;
    }

    const raw = this.def.states[this.state]?.on?.[ev.type];
    const transitions: TransitionDef[] = raw ? (Array.isArray(raw) ? raw : [raw]) : [];

    let chosen: TransitionDef | undefined;
    for (const t of transitions) {
      if (!t.guard) {
        chosen = t;
        break;
      }
      let ok: boolean;
      try {
        const g = this.registry.guards[t.guard];
        if (!g) throw new Error(`unknown guard '${t.guard}'`);
        ok = !!g(this.guardInput(ev));
      } catch (e) {
        rec.guards.push({ name: t.guard, ok: false });
        return this.fail(rec, { code: 'GUARD_ERROR', guard: t.guard, message: errMessage(e) });
      }
      rec.guards.push({ name: t.guard, ok });
      if (ok) {
        chosen = t;
        break;
      }
    }

    if (!chosen) {
      rec.note = transitions.length > 0 ? 'guards-rejected' : 'unhandled';
      return rec;
    }

    // 执行转移：先快照，动作失败时可整体回滚
    rec.transition = true;
    const snapshot = { state: this.state, context: structuredClone(this.context) };
    const deferredMark = this.deferred.length;
    const raisedMark = 0;
    const target = chosen.target ?? this.state;
    rec.to = target;

    const api: ActionApi = {
      clock: this.clock,
      assign: (patch) => {
        Object.assign(this.context, patch);
      },
      raise: (event, delay = 0) => {
        const ne = this.makeEvent({
          time: this.clock + delay,
          priority: event.priority ?? 0,
          type: event.type,
          payload: event.payload,
          token: event.token,
          source: 'raised',
        });
        this.deferred.push(ne); // 关键：派生事件进 deferred，不插到当前批次之前
        rec.raised.push({ type: ne.type, time: ne.time, token: ne.token });
      },
      cancel: (token) => this.purgeToken(token, rec),
    };

    try {
      for (const name of chosen.actions ?? []) {
        const fn = this.registry.actions[name];
        if (!fn) throw new Error(`unknown action '${name}'`);
        try {
          fn(this.guardInput(ev), api);
        } catch (e) {
          const err = new Error(errMessage(e));
          return this.fail(
            rec,
            { code: 'ACTION_ERROR', action: name, message: err.message },
            snapshot,
            deferredMark,
            raisedMark,
          );
        }
      }
      this.state = target;
    } catch (e) {
      return this.fail(
        rec,
        { code: 'ACTION_ERROR', message: errMessage(e) },
        snapshot,
        deferredMark,
        raisedMark,
      );
    }

    rec.diff = diffContext(snapshot.context, this.context);
    return rec;
  }

  private fail(
    rec: StepRecord,
    error: StructuredError,
    snapshot?: { state: string; context: JsonObject },
    deferredMark?: number,
    raisedMark?: number,
  ): StepRecord {
    rec.error = error;
    this.lastError = error;
    if (this.onError === 'abort') {
      this.status = 'aborted';
      return rec;
    }
    // rollback：恢复状态与上下文，丢弃失败转移派生的事件
    if (snapshot) {
      this.state = snapshot.state;
      this.context = snapshot.context;
      this.deferred.length = deferredMark!;
      rec.raised.length = raisedMark!;
      rec.to = snapshot.state;
      rec.rolledBack = true;
    }
    return rec;
  }
}

function diffContext(before: JsonObject, after: JsonObject): ContextDiffEntry[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff: ContextDiffEntry[] = [];
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) diff.push({ key, before: b, after: a });
  }
  return diff;
}
