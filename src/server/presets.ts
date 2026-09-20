// 预置机器与情景：覆盖同刻竞争、嵌套派发、取消/完成竞争、失败回滚。
// 暂停重连与会话过期由操作/传输层测试覆盖（对任意预置情景生效）。
import { parseGuard } from '../shared/expr';
import type {
  ActionDef,
  GuardNode,
  MachineDef,
  ScenarioDef,
} from '../shared/types';

const g = (source: string): GuardNode => parseGuard(source);
const assign = (path: string, source: string): ActionDef => ({ type: 'assign', path, value: g(source) });
const raise = (event: string, payloadSource?: string, at?: number): ActionDef => ({
  type: 'raise',
  event,
  payload: payloadSource ? g(payloadSource) : undefined,
  at,
});

export interface Preset {
  id: string;
  title: string;
  description: string;
  machine: MachineDef;
  scenario: ScenarioDef;
}

// ---------- 机器 A：任务工作机 ----------

function taskMachine(onFailure: 'rollback' | 'terminate'): MachineDef {
  return {
    initial: 'idle',
    context: { count: 0, retries: 0, log: [], lastResult: null, phase: 'idle' },
    onFailure,
    states: {
      idle: {
        entry: [assign('phase', '"idle"')],
        transitions: [
          {
            on: 'SUBMIT',
            target: 'queued',
            actions: [
              assign('count', 'ctx.count + 1'),
              assign('lastResult', 'null'),
              { type: 'name', name: 'recordLog' },
            ],
          },
        ],
      },
      queued: {
        entry: [assign('phase', '"queued"')],
        transitions: [
          // 取消优先：先匹配显式 CANCEL；完成竞争时由同刻 priority 决胜
          { on: 'CANCEL', target: 'aborted', actions: [assign('phase', '"aborted-by-cancel"')] },
          { on: 'START', target: 'running' },
          // WAKE：失败重试后由动作在当前时刻后批道派发的唤醒信号（保持在 queued）
          { on: 'WAKE' },
          {
            on: 'COMPLETE',
            target: 'done',
            guard: g('event.payload.ok === true'),
            guardSource: 'event.payload.ok === true',
            actions: [
              assign('lastResult', 'event.payload.result'),
              assign('phase', '"done"'),
            ],
          },
          {
            on: 'COMPLETE',
            target: 'failed',
            actions: [assign('phase', '"failed-guard"'), assign('lastResult', '"rejected"')],
          },
        ],
      },
      running: {
        entry: [assign('phase', '"running"')],
        transitions: [
          { on: 'CANCEL', target: 'aborted' },
          {
            on: 'COMPLETE',
            target: 'done',
            guard: g('event.payload.ok === true'),
            guardSource: 'event.payload.ok === true',
            actions: [
              assign('lastResult', 'event.payload.result'),
              assign('phase', '"done"'),
              // 嵌套派发：完成后同刻（后批道）发出审计事件，绝不插到当前批次之前
              raise('AUDIT', '{ ok: true, n: ctx.count }'),
            ],
          },
          {
            on: 'COMPLETE',
            // 失败重试：守卫为真才回退 queued，并在未来虚拟时刻唤醒
            target: 'queued',
            guard: g('event.payload.ok === false && ctx.retries < 2'),
            guardSource: 'event.payload.ok === false && ctx.retries < 2',
            actions: [
              assign('retries', 'ctx.retries + 1'),
              assign('phase', '"retrying"'),
              raise('WAKE', '{ n: ctx.retries }'),
            ],
          },
          {
            on: 'COMPLETE',
            target: 'failed',
            guard: g('ctx.retries >= 2'),
            guardSource: 'ctx.retries >= 2',
            actions: [assign('phase', '"failed-exhausted"')],
          },
        ],
      },
      done: {
        entry: [assign('phase', '"done"')],
        transitions: [
          // 机内声明的命名动作
          { on: 'AUDIT', actions: [{ type: 'name', name: 'recordAudit' }] },
          { on: 'SUBMIT', target: 'queued', actions: [assign('count', 'ctx.count + 1')] },
        ],
      },
      failed: {
        entry: [assign('phase', '"failed"')],
        transitions: [
          { on: 'SUBMIT', target: 'queued', actions: [assign('count', 'ctx.count + 1')] },
        ],
      },
      aborted: {
        entry: [assign('phase', '"aborted"')],
        transitions: [
          { on: 'SUBMIT', target: 'queued', actions: [assign('count', 'ctx.count + 1')] },
        ],
      },
    },
    actions: {
      recordAudit: [
        { type: 'cancel', ref: 'WAKE', mode: 'type' },
        assign('log', 'ctx.log'), // no-op 占位，保持机内命名动作可见
      ],
    },
  };
}

// ---------- 机器 B：失败策略演示 ----------

function fragileMachine(onFailure: 'rollback' | 'terminate'): MachineDef {
  return {
    initial: 'waiting',
    context: { attempts: 0, committed: false, marker: 'untouched' },
    onFailure,
    states: {
      waiting: {
        transitions: [
          {
            on: 'DO',
            target: 'working',
            actions: [
              assign('attempts', 'ctx.attempts + 1'),
              assign('committed', 'true'),
              assign('marker', '"after-explode"'), // 先写入草稿，随后动作失败 → 必须随整笔回滚
              { type: 'name', name: 'maybeExplode' }, // 注入动作：第三次调用抛错
            ],
          },
          {
            on: 'BAD_GUARD',
            target: 'working',
            // 访问非对象字段做算术 → 守卫求值错误
            guard: g('ctx.marker.foo + 1 > 0'),
            guardSource: 'ctx.marker.foo + 1 > 0',
          },
        ],
      },
      working: {
        transitions: [
          {
            on: 'RESET',
            target: 'waiting',
            actions: [
              assign('committed', 'false'),
              assign('marker', '"untouched"'),
            ],
          },
        ],
      },
    },
  };
}

// ---------- 情景 ----------

const scenarios: Preset[] = [
  {
    id: 'same-tick-race',
    title: '同刻竞争：priority 决胜',
    description:
      't=10 在 queued 状态上 CANCEL(p10) 与 COMPLETE(p1)、START(p0) 同刻：高优先级取消胜出进入 aborted，其余两个成为 skipped；观察 lane/priority/seq 排序键。',
    machine: taskMachine('rollback'),
    scenario: {
      events: [
        // t=0 SUBMIT 进入 queued；t=10 三个同刻事件按 priority 决胜：
        { id: 'e-submit', type: 'SUBMIT', at: 0, payload: { ref: 'A' } },
        // CANCEL(p10) > COMPLETE(p1) > START(p0)：取消赢得竞争
        { id: 'e-cancel', type: 'CANCEL', at: 10, priority: 10 },
        { id: 'e-complete', type: 'COMPLETE', at: 10, priority: 1, payload: { ok: true, result: 'X' } },
        { id: 'e-start', type: 'START', at: 10, priority: 0 },
        // 未来时刻的迟到完成：若前面未取消会被消费；此处仅作为观察项（aborted 上 skipped）
        { id: 'e-late', type: 'COMPLETE', at: 20, payload: { ok: true, result: 'late' } },
      ],
    },
  },
  {
    id: 'nested-dispatch',
    title: '嵌套派发：新事件不插队',
    description:
      't=0 SUBMIT→START→COMPLETE 链。COMPLETE 在同刻后批道派发 AUDIT；失败路径在未来时刻派发 WAKE 形成重试嵌套。',
    machine: taskMachine('rollback'),
    scenario: {
      events: [
        { id: 'n1', type: 'SUBMIT', at: 0, payload: { ref: 'nested' } },
        { id: 'n2', type: 'START', at: 1 },
        { id: 'n3', type: 'COMPLETE', at: 2, payload: { ok: false, why: 'first-try' } },
        // WAKE 在 t=2 后批道把任务重新置为 queued，t=3 START 再次运行
        { id: 'n4', type: 'START', at: 3 },
        { id: 'n5', type: 'COMPLETE', at: 4, payload: { ok: true, result: 42 } },
        // 下一时刻的 START：此时已 done（无匹配 → skipped），
        // 而 n5 同刻后批道派发的 AUDIT 必须在离开 t=4 前先被处理
        { id: 'n6', type: 'START', at: 5, priority: -1 },
      ],
    },
  },
  {
    id: 'cancel-wins',
    title: '取消 vs 完成竞争',
    description:
      't=5 CANCEL 信号（priority 5）与 COMPLETE（priority 1）同刻，且显式取消转移先匹配；同时演示 id 取消把待处理的未来事件移除。',
    machine: taskMachine('rollback'),
    scenario: {
      events: [
        { id: 'c-submit', type: 'SUBMIT', at: 0 },
        { id: 'c-late-complete', type: 'COMPLETE', at: 9, payload: { ok: true, result: 'late' } },
        {
          id: 'c-cancel',
          type: 'CANCEL',
          at: 5,
          priority: 5,
          cancelRef: 'c-late-complete',
          cancelMode: 'id',
        },
        { id: 'c-complete', type: 'COMPLETE', at: 5, priority: 1, payload: { ok: true } },
      ],
    },
  },
  {
    id: 'fail-rollback',
    title: '失败回滚（rollback）',
    description:
      'maybeExplode 在第 3 次 DO 时失败：已计算的 assign 全部回滚，队列副作用撤销，状态停留 waiting，情景继续。',
    machine: fragileMachine('rollback'),
    scenario: {
      events: [
        { id: 'f1', type: 'DO', at: 1 },
        { id: 'f1-reset', type: 'RESET', at: 2 },
        { id: 'f2', type: 'DO', at: 3 },
        { id: 'f2-reset', type: 'RESET', at: 4 },
        { id: 'f3', type: 'DO', at: 5 }, // 第三次：爆炸 → rolled-back
        { id: 'f4', type: 'DO', at: 6 }, // 第四次：同样爆炸，但情景未终止
      ],
    },
  },
  {
    id: 'fail-terminate',
    title: '失败终止（terminate）',
    description: '同样的失败序列，机器策略为 terminate：第一次结构性失败立即终止整个情景，后续事件不再应用。',
    machine: fragileMachine('terminate'),
    scenario: {
      events: [
        { id: 't1', type: 'DO', at: 1 },
        { id: 't1-reset', type: 'RESET', at: 2 },
        { id: 't2', type: 'DO', at: 3 },
        { id: 't2-reset', type: 'RESET', at: 4 },
        { id: 't3', type: 'DO', at: 5 }, // → terminated
        { id: 't4', type: 'DO', at: 6 }, // 永不应用
      ],
    },
  },
  {
    id: 'guard-error',
    title: '守卫求值错误',
    description: 'BAD_GUARD 对字符串取子字段做算术，守卫本身抛错 → 结构化错误 + 回滚，状态不变。',
    machine: fragileMachine('rollback'),
    scenario: {
      events: [
        { id: 'g1', type: 'BAD_GUARD', at: 1 },
        { id: 'g2', type: 'BAD_GUARD', at: 2 },
        { id: 'g3', type: 'DO', at: 3 },
      ],
    },
  },
];

export const PRESETS: Preset[] = scenarios;
export const DEFAULT_PRESET_ID = 'same-tick-race';

// 供 UI 显示表达式帮助
export const EXPRESSION_HINTS =
  'ctx.count + 1 · event.payload.ok === true · ctx.x > 0 ? "a" : "b" · "k" in ctx.meta · (a && b) || !c';
