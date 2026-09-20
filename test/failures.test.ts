import { describe, expect, it } from 'vitest';
import { Engine } from '../src/server/engine';
import { PRESETS } from '../src/server/presets';
import type { MachineDef, ScenarioDef } from '../src/shared/types';
import { runAll, testRegistry } from './helpers';

function presetEngine(id: string) {
  const p = PRESETS.find((x) => x.id === id)!;
  return new Engine(p.machine, p.scenario, testRegistry());
}

describe('失败回滚（rollback 策略）', () => {
  it('注入动作第三次失败时：状态/上下文/队列副作用全部回滚，情景继续', () => {
    const engine = presetEngine('fail-rollback');
    const before = engine.snapshot();
    expect(before.state).toBe('waiting');
    expect(before.context.attempts).toBe(0);

    const steps = runAll(engine);

    // 前两次 DO 成功进入 working，RESET 回来
    const doSteps = steps.filter((s) => s.eventType === 'DO');
    expect(doSteps.map((s) => s.kind)).toEqual([
      'applied', // f1
      'applied', // f2
      'rolled-back', // f3 爆炸
      'rolled-back', // f4 仍然爆炸，但情景没有终止
    ]);

    // 回滚步骤无状态变化、无 diff，并携带结构化错误
    const rb = doSteps[2];
    expect(rb.stateChanged).toBe(false);
    expect(rb.toState).toBe('waiting');
    expect(rb.diff).toEqual([]);
    expect(rb.error).toMatchObject({ code: 'E_BOOM', phase: 'action' });

    // 成功的两次 + 复位：最终 attempts 停在 2（第三、四次的 assign 被回滚）
    const snap = engine.snapshot();
    expect(snap.context.attempts).toBe(2);
    // 最后一次失败转移整体回滚（含同事务 committed=true），且此前 RESET 已把它复位
    expect(snap.context.committed).toBe(false);
    expect(snap.context.marker).toBe('untouched'); // 失败动作之后的 assign 从未生效
    expect(snap.state).toBe('waiting');
    expect(snap.failures.filter((f) => f.code === 'E_BOOM')).toHaveLength(2);
  });

  it('动作失败前在草稿中派发/取消的事件随回滚撤销', () => {
    const machine: MachineDef = {
      initial: 's',
      context: { n: 0 },
      onFailure: 'rollback',
      states: {
        s: {
          transitions: [
            {
              on: 'GO',
              target: 't',
              actions: [
                { type: 'assign', path: 'n', value: { kind: 'binary', op: '+', left: { kind: 'path', path: 'ctx.n' }, right: { kind: 'literal', value: 1 } } },
                { type: 'raise', event: 'SIDE' },
                { type: 'fail', code: 'X', message: 'boom' },
              ],
            },
          ],
        },
        t: { transitions: [{ on: 'SIDE', target: 't' }] },
      },
    };
    const engine = new Engine(
      machine,
      { events: [{ id: 'g1', type: 'GO', at: 0 }, { id: 'g2', type: 'GO', at: 1 }] },
      testRegistry(),
    );
    const steps = runAll(engine);
    expect(steps.find((s) => s.eventId === 'g1')?.kind).toBe('rolled-back');
    expect(steps.find((s) => s.eventId === 'g2')?.kind).toBe('rolled-back');
    expect(steps.find((s) => s.eventType === 'SIDE')).toBeUndefined();
    expect(engine.snapshot().context.n).toBe(0);
  });

  it('守卫求值错误记录为结构化错误并回滚，不尝试后续候选', () => {
    const engine = presetEngine('guard-error');
    const steps = runAll(engine);
    const bad = steps.filter((s) => s.eventType === 'BAD_GUARD');
    expect(bad).toHaveLength(2);
    for (const s of bad) {
      expect(s.kind).toBe('rolled-back');
      expect(s.error?.phase).toBe('guard');
    }
    // 之后正常 DO 仍可执行
    const good = steps.find((s) => s.eventId === 'g3')!;
    expect(good.kind).toBe('applied');
    expect(good.toState).toBe('working');
  });
});

describe('失败终止（terminate 策略）', () => {
  it('第一次结构性失败立即终止情景，后续事件永不应用', () => {
    const engine = presetEngine('fail-terminate');
    const steps = runAll(engine);
    const term = steps.find((s) => s.kind === 'terminated');
    expect(term).toBeDefined();
    expect(term!.eventId).toBe('t3');
    expect(term!.error?.code).toBe('E_BOOM');

    expect(engine.engineStatus).toBe('terminated');
    // t4 不在步骤中，仍在队列里（终止后冻结）——advanceOne 不再出队
    const snap = engine.snapshot();
    expect(snap.queue.map((q) => q.id)).toContain('t4');
  });

  it('终止后拒绝外部事件注入', () => {
    const engine = presetEngine('fail-terminate');
    runAll(engine);
    expect(() =>
      engine.enqueueExternal({ id: 'late', type: 'DO', at: 999 }),
    ).toThrowError(/无法追加事件/);
  });
});

describe('过去时刻与边界', () => {
  it('拒绝向过去虚拟时刻注入外部事件（过去只能由引擎内部后批道派发）', () => {
    const machine: MachineDef = {
      initial: 's',
      context: {},
      states: { s: { transitions: [{ on: 'A', target: 's' }] } },
    };
    const engine = new Engine(
      machine,
      { events: [{ id: 'a', type: 'A', at: 100 }] },
      testRegistry(),
    );
    runAll(engine);
    expect(engine.time).toBe(100);
    expect(() => engine.enqueueExternal({ id: 'late', type: 'A', at: 50 })).toThrowError(
      /过去时刻/,
    );
    // 同刻允许，进入后批道
    engine.enqueueExternal({ id: 'now', type: 'A', at: 100 });
    const steps = runAll(engine);
    expect(steps.at(-1)?.lane).toBe(1);
  });

  it('失控嵌套派发受 maxSteps 边界保护', () => {
    const machine: MachineDef = {
      initial: 's',
      context: {},
      states: {
        s: {
          transitions: [
            {
              on: 'LOOP',
              actions: [{ type: 'raise', event: 'LOOP' }],
            },
          ],
        },
      },
    };
    const scenario: ScenarioDef = { maxSteps: 20, events: [{ id: 'l0', type: 'LOOP', at: 0 }] };
    const engine = new Engine(machine, scenario, testRegistry());
    const steps = runAll(engine);
    expect(steps.at(-1)?.kind).toBe('boundary');
    expect(steps.at(-1)?.error?.code).toBe('MAX_STEPS');
    expect(engine.engineStatus).toBe('boundary');
  });
});

describe('注入注册表', () => {
  it('直接篡改冻结上下文不会污染引擎状态', () => {
    const machine: MachineDef = {
      initial: 's',
      context: { hacked: false },
      states: {
        s: {
          transitions: [{ on: 'GO', target: 'e', actions: [{ type: 'name', name: 'naughtyMutate' }] }],
        },
        e: { transitions: [] },
      },
    };
    const engine = new Engine(
      machine,
      { events: [{ id: 'g', type: 'GO', at: 0 }] },
      testRegistry(),
    );
    runAll(engine);
    // 冻结对象上赋值在非严格模式静默失败；引擎自己的草稿不受影响
    expect(engine.snapshot().context.hacked).toBe(false);
  });

  it('引用未注册动作在创建时即被校验拒绝', () => {
    const machine: MachineDef = {
      initial: 's',
      context: {},
      states: {
        s: { transitions: [{ on: 'GO', actions: [{ type: 'name', name: 'not-registered' }] }] },
      },
    };
    expect(
      () => new Engine(machine, { events: [] }, testRegistry()),
    ).toThrowError(/状态机定义校验失败/);
  });
});
