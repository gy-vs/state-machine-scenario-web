import { describe, expect, it } from 'vitest';
import { Engine, type Registry } from './engine';
import { defaultRegistry } from './registry';
import { Session, SessionManager } from './session';
import type { MachineDef, ScenarioDef, ServerMsgEnvelope, StepRecord } from '../shared/types';

function runAll(engine: Engine): StepRecord[] {
  const recs: StepRecord[] = [];
  let r: StepRecord | null;
  while ((r = engine.stepOnce())) recs.push(r);
  return recs;
}

/** 记录事件处理顺序到 context.log 的注册表 */
function traceRegistry(): Registry {
  return {
    guards: { always: () => true },
    actions: {
      trace: ({ context, event }, api) => {
        const log = Array.isArray(context.log) ? (context.log as string[]) : [];
        api.assign({ log: [...log, event.type] });
      },
    },
  };
}

const traceMachine: MachineDef = {
  initial: 's',
  context: { log: [] },
  states: {
    s: {
      on: {
        A: { actions: ['trace'] },
        B: { actions: ['trace'] },
        C: { actions: ['trace'] },
      },
    },
  },
};

describe('引擎：同刻竞争', () => {
  it('同一虚拟时刻按 (priority, id) 决胜', () => {
    const engine = new Engine(traceMachine, traceRegistry());
    engine.loadScenario({
      steps: [
        // 声明顺序 C,B,A，但优先级决定执行顺序
        { at: 5, send: [{ type: 'C', priority: 2 }, { type: 'B', priority: 1 }] },
        { at: 5, send: [{ type: 'A', priority: 1 }] },
      ],
    });
    runAll(engine);
    // B 与 A 同优先级，id 小者（先声明的 B）在前
    expect(engine.context.log).toEqual(['B', 'A', 'C']);
    expect(engine.clock).toBe(5);
  });
});

describe('引擎：嵌套派发', () => {
  it('动作派生的事件不得插到当前批次之前', () => {
    const machine: MachineDef = {
      initial: 's',
      context: { log: [] },
      states: {
        s: {
          on: {
            A: { actions: ['trace', 'spawn'] },
            B: { actions: ['trace'] },
            C: { actions: ['trace'] },
          },
        },
      },
    };
    const registry: Registry = {
      guards: {},
      actions: {
        ...traceRegistry().actions,
        // A 派生一个同刻、优先级极高的事件 C——若允许插队，C 会跑到 B 前面
        spawn: (_i, api) => api.raise({ type: 'C', priority: -100 }, 0),
      },
    };
    const engine = new Engine(machine, registry);
    engine.loadScenario({ steps: [{ at: 0, send: [{ type: 'A' }, { type: 'B' }] }] });
    runAll(engine);
    expect(engine.context.log).toEqual(['A', 'B', 'C']);
  });
});

describe('引擎：取消与完成竞争', () => {
  const machine: MachineDef = {
    initial: 's',
    context: { done: [] },
    states: {
      s: {
        on: {
          TICK: { actions: ['hit'] },
          BOOM: { actions: ['hit'] },
        },
      },
    },
  };
  const registry: Registry = {
    guards: {},
    actions: {
      hit: ({ context, event }, api) => {
        const done = Array.isArray(context.done) ? (context.done as string[]) : [];
        api.assign({ done: [...done, event.type] });
      },
    },
  };

  it('取消信号排在目标事件之前 → 目标被取消', () => {
    const engine = new Engine(machine, registry);
    engine.loadScenario({
      steps: [
        { at: 5, send: [{ type: 'TICK', token: 'k' }] },
        { at: 5, cancel: 'k', priority: -1 }, // 取消信号优先
      ],
    });
    const recs = runAll(engine);
    expect(engine.context.done).toEqual([]);
    expect(recs[0].note).toBe('cancel:k');
    expect(recs[0].cancelled).toHaveLength(1);
  });

  it('目标事件排在取消信号之前 → 先完成，取消落空', () => {
    const engine = new Engine(machine, registry);
    engine.loadScenario({
      steps: [
        { at: 5, send: [{ type: 'TICK', token: 'k' }] },
        { at: 5, cancel: 'k', priority: 1 }, // 取消信号靠后
      ],
    });
    runAll(engine);
    expect(engine.context.done).toEqual(['TICK']);
  });

  it('取消信号可跨时刻取消未来的事件', () => {
    const engine = new Engine(machine, registry);
    engine.loadScenario({
      steps: [
        { at: 1, send: [{ type: 'TICK', token: 'k' }] },
        { at: 10, send: [{ type: 'BOOM', token: 'k' }] },
        { at: 5, cancel: 'k' },
      ],
    });
    runAll(engine);
    expect(engine.context.done).toEqual(['TICK']); // BOOM 在 t=5 被取消
  });
});

describe('引擎：失败处理', () => {
  const machine: MachineDef = {
    initial: 'a',
    context: { n: 0 },
    states: {
      a: {
        on: {
          GO: { target: 'b', actions: ['bump', 'boom'] },
          PING: { actions: ['bump'] },
          GUARDED: { guard: 'explode', target: 'b' },
        },
      },
      b: { on: {} },
    },
  };
  const registry: Registry = {
    guards: {
      explode: () => {
        throw new Error('guard failed');
      },
    },
    actions: {
      bump: ({ context }, api) => api.assign({ n: Number(context.n) + 1 }),
      boom: () => {
        throw new Error('action failed');
      },
    },
  };

  it('rollback：动作失败回滚状态与上下文，情景继续', () => {
    const engine = new Engine(machine, registry, 'rollback');
    engine.loadScenario({ steps: [{ at: 0, send: [{ type: 'GO' }, { type: 'PING' }] }] });
    const recs = runAll(engine);
    expect(recs[0].error?.code).toBe('ACTION_ERROR');
    expect(recs[0].error?.action).toBe('boom');
    expect(recs[0].rolledBack).toBe(true);
    expect(engine.state).toBe('a'); // 没有停在 b
    expect(engine.context.n).toBe(1); // GO 的 bump 被回滚，PING 的 bump 生效
    expect(engine.status).toBe('done');
  });

  it('abort：动作失败终止情景，后续事件不再处理', () => {
    const engine = new Engine(machine, registry, 'abort');
    engine.loadScenario({ steps: [{ at: 0, send: [{ type: 'GO' }, { type: 'PING' }] }] });
    const recs = runAll(engine);
    expect(recs).toHaveLength(1);
    expect(engine.status).toBe('aborted');
    expect(engine.lastError?.code).toBe('ACTION_ERROR');
  });

  it('守卫抛错产生结构化 GUARD_ERROR，rollback 策略下情景继续', () => {
    const engine = new Engine(machine, registry, 'rollback');
    engine.loadScenario({ steps: [{ at: 0, send: [{ type: 'GUARDED' }, { type: 'PING' }] }] });
    const recs = runAll(engine);
    expect(recs[0].error?.code).toBe('GUARD_ERROR');
    expect(recs[0].error?.guard).toBe('explode');
    expect(engine.state).toBe('a');
    expect(engine.context.n).toBe(1);
  });
});

// ---------- 会话层 ----------

class FakeWS {
  msgs: ServerMsgEnvelope[] = [];
  readyState = 1;
  OPEN = 1;
  send(data: string): void {
    this.msgs.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  ofType(type: string): ServerMsgEnvelope[] {
    return this.msgs.filter((m) => m.type === type);
  }
}

async function flush(ticks = 300): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
}

function demoScenario(): ScenarioDef {
  return {
    onError: 'rollback',
    steps: [
      { at: 0, send: [{ type: 'START' }] },
      { at: 7, send: [{ type: 'PAUSE' }, { type: 'RESUME', priority: 1 }] },
    ],
  };
}

const demoMachine: MachineDef = {
  initial: 'idle',
  context: { progress: 0 },
  states: {
    idle: { on: { START: { target: 'running', actions: ['raiseTick'] } } },
    running: {
      on: {
        TICK: [{ target: 'running', actions: ['bumpProgress', 'raiseTick'] }],
        PAUSE: { target: 'paused' },
      },
    },
    paused: { on: { RESUME: { target: 'running', actions: ['raiseTick'] } } },
  },
};

describe('会话：暂停/继续/单步不改变执行顺序', () => {
  it('step 精确推进 N 个事件，pause 在事件边界生效', async () => {
    const s = new Session(demoMachine, demoScenario(), defaultRegistry());
    const ws = new FakeWS();
    s.attach(ws as never, 0);

    s.control('step', 3);
    await flush();
    expect(ws.ofType('step')).toHaveLength(3);
    expect(s.status).toBe('paused');

    s.control('pause'); // 已暂停，无副作用
    s.control('step', 2);
    await flush();
    expect(ws.ofType('step')).toHaveLength(5);

    // 步序号严格递增 —— 顺序与连续执行一致
    const ns = ws.ofType('step').map((m) => (m as { step: StepRecord }).step.n);
    expect(ns).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('会话：断线重连续传', () => {
  it('从 lastAck 续传，不重复应用', async () => {
    const s = new Session(demoMachine, demoScenario(), defaultRegistry());
    const ws1 = new FakeWS();
    s.attach(ws1 as never, 0);
    s.control('step', 4);
    await flush();
    const steps1 = ws1.ofType('step');
    expect(steps1).toHaveLength(4);
    const lastAck = steps1[steps1.length - 1].seq;
    s.detach(ws1 as never);

    // 离线期间会话继续推进
    s.control('step', 3);
    await flush();

    // 重连：只应收到 seq > lastAck 的条目
    const ws2 = new FakeWS();
    s.attach(ws2 as never, lastAck);
    const replayed = ws2.ofType('step');
    expect(replayed.length).toBe(3);
    expect(replayed.every((m) => m.seq > lastAck)).toBe(true);
    const seqs = replayed.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // 无重复
  });

  it('缓冲截断时发送 resync + 快照', async () => {
    const s = new Session(demoMachine, demoScenario(), defaultRegistry());
    const ws1 = new FakeWS();
    s.attach(ws1 as never, 0);
    // 推进超过缓冲上限（500）的步数
    s.control('step', 600);
    await flush(3000);
    s.detach(ws1 as never);

    const ws2 = new FakeWS();
    s.attach(ws2 as never, 10); // lastAck 远远落后
    expect(ws2.ofType('resync')).toHaveLength(1);
    expect(ws2.ofType('snapshot')).toHaveLength(1);
    const snap = ws2.ofType('snapshot')[0] as unknown as { snapshot: { state: string } };
    expect(typeof snap.snapshot.state).toBe('string');
  });
});

describe('会话：过期', () => {
  it('闲置且无连接的会话被清扫，之后 attach 得到 SESSION_EXPIRED', () => {
    const manager = new SessionManager(defaultRegistry(), 1000);
    const s = manager.create(demoMachine, demoScenario());
    s.lastActivity = Date.now() - 2000;
    expect(manager.sweep()).toEqual([s.id]);
    expect(manager.get(s.id)).toBeUndefined();
  });

  it('有连接或未到期的会话不会被清扫', () => {
    const manager = new SessionManager(defaultRegistry(), 1000);
    const connected = manager.create(demoMachine, demoScenario());
    const fresh = manager.create(demoMachine, demoScenario());
    connected.attach(new FakeWS() as never, 0);
    connected.lastActivity = Date.now() - 2000; // 超时但有连接
    expect(manager.sweep()).toEqual([]);
    expect(manager.get(connected.id)).toBeDefined();
    expect(manager.get(fresh.id)).toBeDefined();
  });
});
