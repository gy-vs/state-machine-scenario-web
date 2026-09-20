// 会话层：包装引擎，负责
//  - 有界事件缓冲（环形日志，重连续传的数据源）
//  - 执行节奏控制（start/pause/resume/step，只影响节奏，不改变执行顺序）
//  - 断线重连：按 lastAck 续传，缺口时发 resync + 快照
//  - 会话过期清扫

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { Engine, type Registry } from './engine';
import type {
  MachineDef,
  ScenarioDef,
  ScenarioEvent,
  ServerMsg,
  ServerMsgEnvelope,
  SessionStatus,
  Snapshot,
} from '../shared/types';

const MAX_LOG = 500; // 有界会话事件缓冲

export class Session {
  readonly id = randomUUID();
  readonly engine: Engine;
  lastActivity = Date.now();

  private mode: 'idle' | 'running' | 'paused' = 'idle';
  private seq = 0;
  private log: ServerMsgEnvelope[] = [];
  private clients = new Set<WebSocket>();
  private pumping = false;
  private stepBudget = 0;

  constructor(
    readonly machine: MachineDef,
    readonly scenario: ScenarioDef,
    registry: Registry,
  ) {
    this.engine = new Engine(machine, registry, scenario.onError ?? 'rollback');
    this.engine.loadScenario(scenario);
  }

  get status(): SessionStatus {
    if (this.engine.status === 'done') return 'done';
    if (this.engine.status === 'aborted') return 'aborted';
    return this.mode;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  snapshot(): Snapshot {
    return {
      sessionId: this.id,
      status: this.status,
      clock: this.engine.clock,
      state: this.engine.state,
      context: this.engine.context,
      queue: this.engine.pending(),
      stepsApplied: this.engine.stepsApplied,
    };
  }

  /** 广播 + 记入有界缓冲。只有 step/status 进缓冲，它们才是需要续传的状态变化。 */
  private emit(msg: ServerMsg): void {
    const env = { ...msg, seq: ++this.seq } as ServerMsgEnvelope;
    this.log.push(env);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    const data = JSON.stringify(env);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ...msg, seq: this.seq }));
  }

  /** 客户端挂载/重连：从 lastAck 之后续传，缓冲缺口则先 resync + 快照。 */
  attach(ws: WebSocket, lastAck: number): void {
    this.touch();
    this.clients.add(ws);
    this.send(ws, { type: 'hello', sessionId: this.id, seq: this.seq });

    const oldest = this.log.length > 0 ? this.log[0].seq : this.seq + 1;
    if (lastAck < oldest - 1) {
      // 缓冲已截断，无法完整续传：让客户端清空本地日志，以快照为准
      this.send(ws, { type: 'resync' });
    }
    this.send(ws, { type: 'snapshot', snapshot: this.snapshot() });
    for (const env of this.log) {
      if (env.seq > lastAck && ws.readyState === ws.OPEN) ws.send(JSON.stringify(env));
    }
  }

  detach(ws: WebSocket): void {
    this.clients.delete(ws);
    this.touch();
  }

  control(op: 'start' | 'pause' | 'resume' | 'step', count = 1): void {
    this.touch();
    switch (op) {
      case 'start':
      case 'resume':
        if (this.status === 'done' || this.status === 'aborted') return;
        this.mode = 'running';
        this.emit({ type: 'status', status: this.status });
        this.pump();
        break;
      case 'pause':
        // 只影响节奏：泵在下一个事件边界停下，执行顺序不变
        this.mode = 'paused';
        this.emit({ type: 'status', status: this.status });
        break;
      case 'step':
        if (this.status === 'done' || this.status === 'aborted') return;
        if (this.mode === 'idle') this.mode = 'paused';
        this.stepBudget += Math.max(1, Math.min(1000, Math.floor(count)));
        this.pump();
        break;
    }
  }

  inject(event: ScenarioEvent, delay = 0): void {
    this.touch();
    this.engine.inject(event, delay);
    if (this.mode === 'running') this.pump();
  }

  /** 执行泵：每个 setImmediate 处理一个事件，控制指令在事件边界生效。 */
  private pump(): void {
    if (this.pumping) return;
    if (this.mode !== 'running' && this.stepBudget <= 0) return;
    this.pumping = true;

    const loop = (): void => {
      if (this.engine.status === 'done' || this.engine.status === 'aborted') {
        this.pumping = false;
        return;
      }
      if (this.mode !== 'running' && this.stepBudget <= 0) {
        this.pumping = false;
        return;
      }
      const rec = this.engine.stepOnce();
      if (!rec) {
        this.pumping = false;
        this.emit({ type: 'status', status: this.status });
        return;
      }
      if (this.stepBudget > 0) this.stepBudget--;
      this.emit({ type: 'step', step: rec, queue: this.engine.pending(), status: this.status });
      if (this.status === 'aborted') {
        this.emit({ type: 'status', status: 'aborted', error: this.engine.lastError });
        this.pumping = false;
        return;
      }
      setImmediate(loop);
    };
    loop();
  }

  close(): void {
    for (const ws of this.clients) {
      try {
        ws.close(1000, 'session destroyed');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private registry: Registry,
    private ttlMs = 15 * 60 * 1000,
  ) {}

  create(machine: MachineDef, scenario: ScenarioDef): Session {
    const s = new Session(machine, scenario, this.registry);
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  destroy(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.close();
    return this.sessions.delete(id);
  }

  /** 过期清扫：仅回收没有客户端连接且闲置超时的会话。 */
  sweep(now = Date.now()): string[] {
    const expired: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.clientCount === 0 && now - s.lastActivity > this.ttlMs) {
        s.close();
        this.sessions.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }
}
