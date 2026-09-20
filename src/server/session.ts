import { BoundedMap } from '../shared/buffer';
import type {
  CommandResult,
  EnqueueRequest,
  JsonObject,
  MachineDef,
  ScenarioDef,
  ServerMessage,
  SessionStatus,
  SnapshotResponse,
  Step,
  StructuredError,
} from '../shared/types';
import { ActionRegistry } from './actionRegistry';
import { DeterminismError, Engine } from './engine';

type Listener = (msg: ServerMessage) => void;

const STEP_BUFFER_CAPACITY = 200;
const COMMAND_CACHE_CAPACITY = 256;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_STEP_WAIT_MS = 350;

export interface SessionOptions {
  ttlMs?: number;
  registry: ActionRegistry;
  now?: () => number;
}

/**
 * 仿真会话：
 * - 引擎顺序是唯一事实来源；播放/暂停/单步/跳转只改变推进节奏与观察游标，不改顺序。
 * - 步骤写入有界环形缓冲供断线重放；从最后确认序号续传，不重复应用。
 * - 空闲 TTL 过期后会话销毁并广播 expired。
 */
export class SimulationSession {
  readonly id: string;
  readonly createdAt: number;
  private engine: Engine;
  private registry: ActionRegistry;
  private machine: MachineDef;
  private listeners = new Set<Listener>();
  private buffer = new BoundedMap<number, Step>(STEP_BUFFER_CAPACITY);
  private commandCache = new BoundedMap<string, CommandResult>(COMMAND_CACHE_CAPACITY);
  private status: SessionStatus = 'idle';
  private expiresAt: number;
  private ttlMs: number;
  private expireTimer: ReturnType<typeof setTimeout> | undefined;
  private playTimer: ReturnType<typeof setTimeout> | undefined;
  private now: () => number;
  onExpire?: (id: string) => void;

  constructor(
    id: string,
    machine: MachineDef,
    scenario: ScenarioDef,
    opts: SessionOptions,
  ) {
    this.id = id;
    this.machine = machine;
    this.registry = opts.registry;
    this.engine = new Engine(machine, scenario, opts.registry);
    this.now = opts.now ?? Date.now;
    this.createdAt = this.now();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.expiresAt = this.createdAt + this.ttlMs;
    this.armExpiry();
  }

  get sessionStatus(): SessionStatus {
    return this.status;
  }

  get isAlive(): boolean {
    return this.status !== 'expired';
  }

  // ---------- TTL ----------

  private armExpiry(): void {
    this.expiresAt = this.now() + this.ttlMs;
    // 不 clearTimeout：fake timers 下已入队回调可能仍被执行；
    // 统一用绝对到期时间戳判定，旧定时器触发时发现被续期则重新排程。
    if (!this.expireTimer) {
      const tick = () => {
        this.expireTimer = undefined;
        if (this.status === 'expired') return;
        const remain = this.expiresAt - this.now();
        if (remain <= 0) {
          this.expire();
          return;
        }
        this.expireTimer = setTimeout(tick, remain);
        this.expireTimer.unref?.();
      };
      this.expireTimer = setTimeout(tick, this.ttlMs);
      this.expireTimer.unref?.();
    }
  }

  private touch(): void {
    if (this.status === 'expired') return;
    this.armExpiry();
  }

  expire(): void {
    if (this.status === 'expired') return;
    this.stopPlayLoop();
    this.status = 'expired';
    this.broadcast({ type: 'expired', sessionId: this.id });
    for (const l of [...this.listeners]) this.listeners.delete(l);
    this.onExpire?.(this.id);
  }

  // ---------- 命令（幂等） ----------

  command(body: { commandId?: string }, run: () => CommandResult): CommandResult {
    this.touch();
    if (this.status === 'expired') {
      return { ok: false, error: sessionError('SESSION_EXPIRED', '会话已过期', 0) };
    }
    if (body.commandId) {
      const cached = this.commandCache.get(body.commandId);
      if (cached) return cached;
      const result = run();
      this.commandCache.set(body.commandId, result);
      return result;
    }
    return run();
  }

  play(req: { wait?: number }): CommandResult {
    if (this.status === 'running') return this.ok();
    if (this.isTerminal()) return this.ok();
    this.status = 'running';
    this.broadcast({ type: 'status', sessionId: this.id, status: 'running' });
    this.startPlayLoop(req.wait ?? DEFAULT_STEP_WAIT_MS);
    return this.ok();
  }

  pause(): CommandResult {
    this.touch(); // 暂停命令本身即活动：idle/paused 下也要刷新 TTL
    if (this.status === 'expired') {
      return { ok: false, error: sessionError('SESSION_EXPIRED', '会话已过期', this.engine.time) };
    }
    if (this.status === 'running') {
      this.status = 'paused';
      this.stopPlayLoop();
      this.broadcast({ type: 'status', sessionId: this.id, status: 'paused' });
    }
    return this.ok();
  }

  step(): CommandResult {
    if (this.isTerminal()) return this.ok();
    this.stopPlayLoop();
    if (this.status === 'running') this.status = 'paused';
    this.advanceSteps(1);
    return this.ok();
  }

  /**
   * 跳转：回跳只移动观察游标（绝不重放引擎）；前跳确定性推进若干微步。
   * 引擎执行顺序因此与暂停/继续/跳转完全无关。
   */
  jump(toSeq: number): CommandResult {
    if (!Number.isInteger(toSeq) || toSeq < 0) {
      return {
        ok: false,
        error: sessionError('JUMP_BAD_SEQ', `跳转序号非法: ${toSeq}`, this.engine.time),
      };
    }
    this.stopPlayLoop();
    if (this.status === 'running') this.status = 'paused';
    const produced = this.engine.snapshot().steps.length;
    if (toSeq > produced) {
      const n = toSeq - produced;
      if (this.isTerminal()) {
        return {
          ok: false,
          error: sessionError(
            'JUMP_PAST_END',
            `情景只有 ${produced} 个步骤，无法跳到 ${toSeq}`,
            this.engine.time,
          ),
        };
      }
      this.advanceSteps(n);
    }
    return this.ok();
  }

  reset(scenario: ScenarioDef): CommandResult {
    this.stopPlayLoop();
    try {
      this.engine = new Engine(this.machine, scenario, this.registry);
    } catch (e) {
      return { ok: false, error: toStructured(e, this.engine.time) };
    }
    this.buffer.clear();
    this.status = 'idle';
    this.broadcast({ type: 'status', sessionId: this.id, status: 'idle' });
    return this.ok();
  }

  enqueue(req: EnqueueRequest): CommandResult {
    try {
      this.engine.enqueueExternal({
        id: req.id,
        type: req.type,
        at: req.at,
        payload: req.payload as JsonObject | undefined,
        priority: req.priority,
        cancelRef: req.cancelRef,
        cancelMode: req.cancelMode,
      });
    } catch (e) {
      return { ok: false, error: toStructured(e, this.engine.time) };
    }
    if (this.status === 'paused') {
      this.broadcast({ type: 'snapshot', payload: this.snapshot() });
    }
    return this.ok();
  }

  // ---------- 推进循环 ----------

  private startPlayLoop(wait: number): void {
    this.stopPlayLoop();
    const tick = () => {
      if (this.status !== 'running') return;
      this.advanceSteps(1);
      if (this.status === 'running') {
        this.playTimer = setTimeout(tick, wait);
        this.playTimer.unref?.();
      }
    };
    // 用 setImmediate 让 play 命令先返回，再产生第一个步骤
    this.playTimer = setTimeout(tick, Math.max(0, wait));
    this.playTimer.unref?.();
  }

  private stopPlayLoop(): void {
    if (this.playTimer) {
      clearTimeout(this.playTimer);
      this.playTimer = undefined;
    }
  }

  private advanceSteps(maxN: number): void {
    for (let i = 0; i < maxN; i++) {
      if (this.isTerminal()) break;
      const steps = this.engine.advanceOne();
      for (const s of steps) {
        this.buffer.set(s.seq, s);
        this.broadcast({ type: 'step', sessionId: this.id, step: s });
      }
      const snap = this.engine.snapshot();
      if (snap.status === 'terminated') {
        this.status = 'terminated';
        this.stopPlayLoop();
        this.broadcast({ type: 'status', sessionId: this.id, status: 'terminated' });
        break;
      }
      if (snap.status === 'boundary') {
        this.status = 'terminated';
        this.stopPlayLoop();
        this.broadcast({ type: 'status', sessionId: this.id, status: 'terminated' });
        break;
      }
      if (snap.status === 'completed') {
        this.status = 'completed';
        this.stopPlayLoop();
        this.broadcast({ type: 'status', sessionId: this.id, status: 'completed' });
        break;
      }
    }
  }

  private isTerminal(): boolean {
    return (
      this.status === 'completed' ||
      this.status === 'terminated' ||
      this.status === 'expired'
    );
  }

  // ---------- SSE ----------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.touch();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 从最后确认序号续传。缓冲不足（客户端落后太多或重连过晚）时，
   * 不猜测、不补造中间步骤，改为整量快照 + REPLAY_TRUNCATED 错误提示。
   */
  replaySince(lastSeq: number, send: Listener): void {
    this.touch();
    const buffered = this.buffer.values().sort((a, b) => a.seq - b.seq);
    const oldest = buffered[0]?.seq;
    if (lastSeq > 0 && oldest !== undefined && lastSeq < oldest - 1) {
      send({
        type: 'error',
        sessionId: this.id,
        error: {
          code: 'REPLAY_TRUNCATED',
          message: `确认序号 ${lastSeq} 已滑出有界缓冲（最早保留 ${oldest}），已改用整量快照同步`,
          phase: 'session',
          at: this.engine.time,
        },
      });
      send({ type: 'snapshot', payload: this.snapshot() });
      send({ type: 'hello', sessionId: this.id, replayFromSeq: this.lastSeq(), bufferedFromSeq: oldest });
      return;
    }
    const missing = buffered.filter((s) => s.seq > lastSeq);
    for (const s of missing) send({ type: 'step', sessionId: this.id, step: s });
    send({
      type: 'hello',
      sessionId: this.id,
      replayFromSeq: lastSeq,
      bufferedFromSeq: oldest ?? lastSeq + 1,
    });
  }

  private lastSeq(): number {
    const all = this.buffer.values();
    return all.length ? all[all.length - 1].seq : 0;
  }

  private broadcast(msg: ServerMessage): void {
    for (const l of [...this.listeners]) {
      try {
        l(msg);
      } catch {
        /* 单个监听器异常不影响仿真 */
      }
    }
  }

  // ---------- 快照 ----------

  snapshot(): SnapshotResponse {
    const snap = this.engine.snapshot();
    const buffered = this.buffer.values().sort((a, b) => a.seq - b.seq);
    return {
      sessionId: this.id,
      status: this.status,
      currentTime: snap.currentTime,
      state: snap.state,
      context: snap.context,
      steps: snap.steps,
      queue: snap.queue,
      lastAppliedSeq: this.engine.lastAppliedSeq,
      bufferedFromSeq: buffered[0]?.seq ?? snap.steps.length + 1,
      expiresAt: this.expiresAt,
      failures: snap.failures,
      registryActions: this.registry.names(),
      machineActions: Object.keys(this.machine.actions ?? {}).sort(),
    };
  }

  private ok(): CommandResult {
    return { ok: true, snapshot: this.snapshot() };
  }
}

export class SessionManager {
  private sessions = new Map<string, SimulationSession>();
  private counter = 0;

  constructor(private registry: ActionRegistry) {}

  create(machine: MachineDef, scenario: ScenarioDef, ttlMs?: number): SimulationSession {
    let id: string;
    do {
      this.counter += 1;
      id = `s_${Date.now().toString(36)}_${this.counter.toString(36)}`;
    } while (this.sessions.has(id));
    const session = new SimulationSession(id, machine, scenario, {
      registry: this.registry,
      ttlMs,
    });
    session.onExpire = (sid) => this.sessions.delete(sid);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): SimulationSession | undefined {
    const s = this.sessions.get(id);
    if (!s || !s.isAlive) return undefined;
    return s;
  }

  get size(): number {
    return this.sessions.size;
  }
}

function sessionError(code: string, message: string, at: number): StructuredError {
  return { code, message, phase: 'session', at };
}

function toStructured(e: unknown, at: number): StructuredError {
  if (e instanceof DeterminismError) return e.structured;
  return {
    code: 'INTERNAL',
    message: e instanceof Error ? e.message : String(e),
    phase: 'engine',
    at,
  };
}
