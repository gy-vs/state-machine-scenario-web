// 共享类型：状态机定义、情景定义、线协议（WebSocket 消息）

export interface JsonObject {
  [key: string]: unknown;
}

// ---------- 状态机定义 ----------

export interface TransitionDef {
  target?: string; // 缺省 = 内部转移（自转）
  guard?: string; // 注册表中的守卫名
  actions?: string[]; // 注册表中的动作名，按序执行
}

export interface StateDef {
  on?: Record<string, TransitionDef | TransitionDef[]>;
}

export interface MachineDef {
  initial: string;
  context?: JsonObject;
  states: Record<string, StateDef>;
}

// ---------- 情景定义 ----------

export interface ScenarioEvent {
  type: string;
  payload?: unknown;
  priority?: number; // 同刻决胜：数值小者先处理，缺省 0
  token?: string; // 取消令牌
}

export interface ScenarioStep {
  at: number; // 虚拟时刻
  send?: ScenarioEvent[];
  cancel?: string; // 在该时刻发出取消信号（针对 token）
  priority?: number; // 取消信号自身的优先级
}

export interface ScenarioDef {
  name?: string;
  onError?: 'rollback' | 'abort'; // 守卫/动作失败策略，缺省 rollback
  steps: ScenarioStep[];
}

// ---------- 结构化错误 ----------

export type ErrorCode = 'GUARD_ERROR' | 'ACTION_ERROR' | 'QUEUE_OVERFLOW' | 'CONFIG';

export interface StructuredError {
  code: ErrorCode;
  message: string;
  guard?: string;
  action?: string;
}

// ---------- 运行时记录 ----------

export interface QueuedEventView {
  id: number;
  time: number;
  priority: number;
  type: string;
  token?: string;
  source: 'scenario' | 'raised' | 'injected';
}

export interface ContextDiffEntry {
  key: string;
  before: unknown;
  after: unknown;
}

export interface StepRecord {
  n: number; // 引擎步序号（从 1 开始）
  clock: number; // 该步的虚拟时钟
  event: { id: number; type: string; payload?: unknown; source: string; token?: string };
  from: string;
  to: string;
  transition: boolean; // 是否真正发生了转移
  rolledBack?: boolean; // 动作失败后已回滚
  guards: { name: string; ok: boolean }[];
  diff: ContextDiffEntry[]; // 上下文的单步差异
  raised: { type: string; time: number; token?: string }[]; // 动作派生的新事件
  cancelled: { id: number; type: string; token?: string }[]; // 本步取消掉的事件
  note?: string; // unhandled / guards-rejected / cancel:xxx 等
  error?: StructuredError;
}

export type SessionStatus = 'idle' | 'running' | 'paused' | 'done' | 'aborted';

export interface Snapshot {
  sessionId: string;
  status: SessionStatus;
  clock: number;
  state: string;
  context: JsonObject;
  queue: QueuedEventView[];
  stepsApplied: number;
}

// ---------- 线协议 ----------

export type ServerMsg =
  | { type: 'hello'; sessionId: string; seq: number }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'resync' } // 缓冲已截断，客户端应清空本地日志后以快照为准
  | { type: 'step'; step: StepRecord; queue: QueuedEventView[]; status: SessionStatus }
  | { type: 'status'; status: SessionStatus; error?: StructuredError }
  | { type: 'error'; code: string; message: string };

export type ServerMsgEnvelope = ServerMsg & { seq: number };

export type ClientMsg =
  | { type: 'attach'; sessionId: string; lastAck: number }
  | { type: 'control'; op: 'start' | 'pause' | 'resume' | 'step'; count?: number }
  | { type: 'inject'; event: ScenarioEvent; delay?: number }
  | { type: 'ack'; seq: number }
  | { type: 'destroy' };
