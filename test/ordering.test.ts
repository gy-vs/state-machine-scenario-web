import { describe, expect, it } from 'vitest';
import { Engine } from '../src/server/engine';
import { PRESETS } from '../src/server/presets';
import type { MachineDef } from '../src/shared/types';
import { appliedSteps, runAll, testRegistry } from './helpers';

function presetEngine(id: string) {
  const p = PRESETS.find((x) => x.id === id)!;
  return new Engine(p.machine, p.scenario, testRegistry());
}

describe('同刻竞争：time → lane → priority → seq 决胜', () => {
  it('同一虚拟时刻 priority 高者先应用，排序键可在步骤中审计', () => {
    const engine = presetEngine('same-tick-race');
    const steps = runAll(engine);
    const at10 = steps.filter((s) => s.time === 10 && s.kind !== 'canceled');

    // t=10 同在 lane=0：CANCEL(p10) → COMPLETE(p1) → START(p0)
    expect(at10.map((s) => s.eventId)).toEqual(['e-cancel', 'e-complete', 'e-start']);
    expect(at10[0].orderKey).toContain('prio=10');
    expect(at10[1].orderKey).toContain('prio=1');

    // 取消赢得竞争进入 aborted；后两个在 aborted 状态无匹配 → skipped
    expect(at10.map((s) => s.kind)).toEqual(['applied', 'skipped', 'skipped']);
    expect(at10[0].toState).toBe('aborted');

    // t=20 迟到 COMPLETE 在 aborted 上同样 skipped，不改变最终状态
    const late = steps.find((s) => s.eventId === 'e-late')!;
    expect(late.kind).toBe('skipped');

    const snap = engine.snapshot();
    expect(snap.queue).toEqual([]);
    expect(snap.context.count).toBe(1);
    expect(snap.state).toBe('aborted');
  });

  it('动作在同刻派发的事件进入后批道，绝不插到当前批次之前', () => {
    const machine = {
      initial: 'a',
      context: {},
      states: {
        a: {
          transitions: [
            {
              on: 'GO',
              target: 'b',
              // 同刻派发 NESTED
              actions: [{ type: 'raise', event: 'NESTED' }],
            },
          ],
        },
        b: { transitions: [{ on: 'OTHER', target: 'c' }, { on: 'NESTED', target: 'd' }] },
        c: { transitions: [] },
        d: { transitions: [] },
      },
    } as const;

    const engine = new Engine(
      machine as unknown as MachineDef,
      {
        events: [
          { id: 'go', type: 'GO', at: 5 },
          { id: 'other', type: 'OTHER', at: 5, priority: -5 },
        ],
      },
      testRegistry(),
    );

    const s1 = engine.advanceOne();
    // 第一个微步只能是 GO（初始事件 lane=0）；NESTED 此时尚未产生
    expect(s1.map((x) => x.eventId)).toEqual(['go']);
    const raised = s1[0].raised!;
    expect(raised[0].lane).toBe(1); // 后批道

    const s2 = engine.advanceOne();
    // OTHER(lane0) 先于 NESTED(lane1)，即使 NESTED 在 GO 的动作里已经产生
    expect(s2[0].eventId).toBe('other');
    expect(s2[0].toState).toBe('c');

    const s3 = engine.advanceOne();
    expect(s3[0].eventType).toBe('NESTED');
    // NESTED 的转移目标 d 在 c 状态下不存在匹配 → skipped（不影响结论：顺序正确）
    expect(s3[0].kind).toBe('skipped');
  });

  it('同刻同 lane 同 priority 时按入队 seq 先入先出', () => {
    const registry = testRegistry();
    registry.register('appendId', (ctx, event, api) => {
      const prev = Array.isArray(ctx.order) ? (ctx.order as string[]) : [];
      api.assign('order', [...prev, event.id]);
    });
    const machine: MachineDef = {
      initial: 's',
      context: { order: [] as string[] },
      states: {
        s: {
          transitions: [
            {
              on: 'X',
              actions: [{ type: 'name', name: 'appendId' }],
            },
          ],
        },
      },
    };
    const engine = new Engine(
      machine,
      {
        events: [
          { id: 'first', type: 'X', at: 0 },
          { id: 'second', type: 'X', at: 0 },
          { id: 'third', type: 'X', at: 0 },
        ],
      },
      registry,
    );
    runAll(engine);
    expect(engine.snapshot().context.order).toEqual(['first', 'second', 'third']);
  });
});

describe('嵌套派发', () => {
  it('COMPLETE 派发同刻 AUDIT（后批道），失败路径在当前时刻派发 WAKE 触发重试链', () => {
    const engine = presetEngine('nested-dispatch');
    const steps = runAll(engine);
    const kinds = steps.map((s) => `${s.eventType}:${s.kind}`);

    // SUBMIT→START→COMPLETE(false, 重试)→WAKE(同刻后批道)→START→COMPLETE(true)→AUDIT→迟到START skipped
    expect(kinds).toContain('SUBMIT:applied');
    expect(kinds).toContain('WAKE:applied');
    expect(kinds).toContain('AUDIT:applied');

    const audit = steps.find((s) => s.eventType === 'AUDIT')!;
    expect(audit.lane).toBeGreaterThan(0);
    // AUDIT 必须晚于产生它的 COMPLETE
    const completing = steps.find((s) => s.eventId === 'n5')!;
    expect(audit.seq).toBeGreaterThan(completing.seq);

    // 同刻迟到 START 已在 done 状态，且不能先于 AUDIT
    const lateStart = steps.find((s) => s.eventId === 'n6')!;
    expect(lateStart.seq).toBeGreaterThan(audit.seq);

    const snap = engine.snapshot();
    expect(snap.state).toBe('done');
    expect(snap.context.retries).toBe(1);
    expect(snap.context.lastResult).toBe(42);
  });

  it('嵌套派发顺序在直接引擎构造中同样成立（链式同刻）', () => {
    const machine = {
      initial: 's0',
      context: { chain: [] as number[] },
      states: {
        s0: {
          transitions: [
            {
              on: 'PING',
              target: 's1',
              actions: [{ type: 'raise', event: 'PING2' }],
            },
          ],
        },
        s1: {
          transitions: [
            {
              on: 'PING2',
              target: 's2',
              actions: [{ type: 'raise', event: 'PING3' }],
            },
          ],
        },
        s2: {
          transitions: [{ on: 'PING3', target: 's3' }],
        },
        s3: { transitions: [] },
      },
    };
    const engine = new Engine(
      machine as unknown as MachineDef,
      { events: [{ id: 'p', type: 'PING', at: 0 }] },
      testRegistry(),
    );
    const steps = runAll(engine);
    expect(appliedSteps(steps).map((s) => s.eventType)).toEqual(['PING', 'PING2', 'PING3']);
    expect(appliedSteps(steps).map((s) => s.lane)).toEqual([0, 1, 2]);
    expect(engine.currentState).toBe('s3');
  });
});
