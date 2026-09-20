// 共享类型定义：抽象状态机、情景、引擎步骤与协议消息

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

export type JsonObject = { [key: string]: JSONValue };

/** 守卫表达式节点（白名单 AST，避免 eval） */
export type GuardNode =
  | { kind: 'literal'; value: JSONValue }
  | { kind: 'path'; path: string } // 以 ctx. / event. 开头，或裸标识符
  | { kind: 'array'; items: GuardNode[] }
  | { kind: 'object'; props: { key: string; value: GuardNode }[] }
  | { kind: 'unary'; op: '!' | '-'; arg: GuardNode }
  | {
      kind: 'binary';
      op:
        | '&&'
        | '||'
        | '??'
        | '=='
        | '!='
        | '==='
        | '!=='
        | '<'
        | '<='
        | '>'
        | '>='
        | '+'
        | '-'
        | '*'
        | '/'
        | '%'
        | 'in';
      left: GuardNode;
      right: GuardNode;
    }
  | { kind: 'ternary'; test: GuardNode; consequent: GuardNode; alternate: GuardNode };

/** 动作定义：内置原语或注入注册表中的命名动作 */
export type ActionDef =
  | { type: 'assign'; path: string; value: GuardNode }
  | { type: 'raise'; event: string; payload?: GuardNode; at?: number }
  | { type: 'cancel'; ref: string; mode: 'id' | 'type' }
  | { type: 'fail'; code: string; message: string }
  | { type: 'name'; name: string };

export interface TransitionDef {
  on: string; // 事件名，'*' 为通配
  target?: string; // 缺省为自转换（执行动作但不离开状态）
  guard?: GuardNode;
  /** 守卫的人类可读形式，编辑器保留原文，引擎以 AST 为准 */
  guardSource?: string;
  actions?: ActionDef[];
}

export interface StateDef {
  /** entry/exit 动作，进入/离开该状态时各执行一次 */
  entry?: ActionDef[];
  exit?: ActionDef[];
  transitions: TransitionDef[];
}

export interface MachineDef {
  initial: string;
  context: JsonObject;
  states: Record<string, StateDef>;
  /** 机内声明的命名动作，名字与注入注册表冲突时注入实现优先 */
  actions?: Record<string, ActionDef[]>;
  /** 失败策略：rollback=回滚当前转移；terminate=终止情景 */
  onFailure?: 'rollback' | 'terminate';
}

/** 情景初始事件（外部激励） */
export interface ScenarioEvent {
  id: string;
  type: string;
  at: number;
  payload?: JsonObject;
  /** 取消信号引用：其它事件的 id 或 type */
  cancelRef?: string;
  cancelMode?: 'id' | 'type';
  priority?: number;
}

export interface ScenarioDef {
  events: ScenarioEvent[];
  /** 单情景可执行微步上限（防御性边界） */
  maxSteps?: number;
}

/** 结构化错误 */
export interface StructuredError {
  code: string;
  message: string;
  phase: 'guard' | 'action' | 'machine' | 'session' | 'engine';
  at: number;
  eventId?: string;
  action?: string;
  detail?: JsonObject;
}

export type StepKind =
  | 'applied' // 转移成功
  | 'skipped' // 无可触发转移或守卫全部为假
  | 'canceled' // 事件被取消信号移除
  | 'rolled-back' // 守卫/动作失败后回滚
  | 'terminated' // 失败策略为 terminate
  | 'expired' // 情景队列自然耗尽（结束态）
  | 'boundary'; // 触碰 maxSteps 等边界

export interface Cancellation {
  ref: string;
  mode: 'id' | 'type';
  byEventId: string;
}

export interface GuardTrace {
  source?: string;
  result: boolean;
  error?: StructuredError;
}

export interface DiffEntry {
  kind: 'add' | 'remove' | 'change';
  path: string;
  oldValue?: JSONValue;
  newValue?: JSONValue;
}

/** 引擎产生的一个微步（虚拟时钟的一次确定推进） */
export interface Step {
  seq: number;
  time: number;
  lane: number;
  priority: number;
  eventId: string;
  eventType: string;
  payload?: JsonObject;
  kind: StepKind;
  fromState: string;
  toState: string;
  takenTransitionOn?: string;
  target?: string;
  guard?: GuardTrace;
  guardRejects?: { on: string; source?: string }[];
  actions?: string[];
  raised?: { id: string; type: string; at: number; lane: number; priority: number }[];
  cancellations?: Cancellation[];
  stateChanged: boolean;
  diff?: DiffEntry[];
  error?: StructuredError;
  /** 排序键，便于排查同刻决胜 */
  orderKey: string;
}

export interface QueueEntryView {
  id: string;
  type: string;
  at: number;
  lane: number;
  priority: number;
  seq: number;
  origin: 'scenario' | 'action' | 'external';
  payload?: JsonObject;
  cancelRef?: string;
  cancelMode?: 'id' | 'type';
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'terminated'
  | 'expired';

// ---------- 协议：REST 请求 / 响应 ----------

export interface CreateSessionRequest {
  machine: MachineDef;
  scenario: ScenarioDef;
  ttlMs?: number;
}

export interface CreateSessionResponse {
  sessionId: string;
  status: SessionStatus;
  expiresAt: number;
}

export interface CommandRequest {
  /** 客户端幂等键；重连后重放命令不会重复应用 */
  commandId?: string;
  wait?: number; // play 时单步最小间隔（毫秒墙钟，仅影响观察节奏）
}

export interface JumpRequest extends CommandRequest {
  toSeq: number;
}

export interface EnqueueRequest extends CommandRequest {
  id: string;
  type: string;
  at: number;
  payload?: JsonObject;
  priority?: number;
  cancelRef?: string;
  cancelMode?: 'id' | 'type';
}

export interface SnapshotResponse {
  sessionId: string;
  status: SessionStatus;
  currentTime: number;
  state: string;
  context: JsonObject;
  steps: Step[];
  queue: QueueEntryView[];
  lastAppliedSeq: number;
  bufferedFromSeq: number;
  expiresAt: number;
  failures: StructuredError[];
  registryActions: string[];
  machineActions: string[];
}

export type CommandResult =
  | { ok: true; snapshot: SnapshotResponse }
  | { ok: false; error: StructuredError };

// ---------- 协议：SSE 事件 ----------

export type ServerMessage =
  | { type: 'snapshot'; payload: SnapshotResponse }
  | { type: 'step'; sessionId: string; step: Step }
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'error'; sessionId?: string; error: StructuredError }
  | { type: 'expired'; sessionId: string }
  | { type: 'hello'; sessionId: string; replayFromSeq: number; bufferedFromSeq: number };

export interface ActionContext {
  assign: (path: string, value: JSONValue) => void;
  raise: (event: string, payload?: JsonObject, at?: number) => void;
  cancel: (ref: string, mode?: 'id' | 'type') => void;
  fail: (code: string, message: string) => never;
}

/**
 * 可注入动作处理器；必须同步完成（微步确定性要求）。
 * ctx 为只读冻结视图，副作用只能通过 ActionContext 产生，失败请调用 fail() 或抛错。
 */
export type ActionHandler = (
  ctx: Readonly<JsonObject>,
  event: Readonly<{ id: string; type: string; payload?: JsonObject }>,
  api: ActionContext,
) => void;

export type GuardHandler = (
  ctx: Readonly<JsonObject>,
  event: Readonly<{ id: string; type: string; payload?: JsonObject }>,
) => boolean;
