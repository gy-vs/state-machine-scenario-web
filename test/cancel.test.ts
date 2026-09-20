import { describe, expect, it } from 'vitest';
import { Engine } from '../src/server/engine';
import { PRESETS } from '../src/server/presets';
import type { MachineDef } from '../src/shared/types';
import { runAll, testRegistry } from './helpers';

function presetEngine(id: string) {
  const p = PRESETS.find((x) => x.id === id)!;
  return new Engine(p.machine, p.scenario, testRegistry());
}

describe('取消与完成竞争', () => {
  it('同刻 CANCEL(priority 高) 胜出；id 取消移除未来 COMPLETE，不产生应用步骤', () => {
    const engine = presetEngine('cancel-wins');
    const steps = runAll(engine);

    const cancel = steps.find((s) => s.eventId === 'c-cancel')!;
    const complete = steps.find((s) => s.eventId === 'c-complete')!;
    expect(cancel.seq).toBeLessThan(complete.seq);
    expect(cancel.kind).toBe('applied');
    expect(cancel.toState).toBe('aborted');

    // 取消动作附带的结构化取消记录
    expect(cancel.cancellations).toEqual([
      { ref: 'c-late-complete', mode: 'id', byEventId: 'c-cancel' },
    ]);

    // 被取消事件产生独立 canceled 步骤，排在信号步骤之前
    const victim = steps.find((s) => s.eventId === 'c-late-complete')!;
    expect(victim.kind).toBe('canceled');
    expect(victim.seq).toBeLessThan(cancel.seq);

    // 同刻 COMPLETE 在 aborted 上无匹配转移 → skipped
    expect(complete.kind).toBe('skipped');
    expect(complete.toState).toBe('aborted');

    // 最终队列不含已取消事件
    expect(engine.snapshot().queue.map((q) => q.id)).not.toContain('c-late-complete');
    expect(engine.currentState).toBe('aborted');
  });

  it('type 取消一次移除全部同类型待处理事件', () => {
    const machine: MachineDef = {
      initial: 's',
      context: {},
      states: {
        s: { transitions: [{ on: 'FLUSH', target: 'f' }] },
        f: { transitions: [{ on: 'TODO', target: 'f' }] },
      },
    };
    const engine = new Engine(
      machine,
      {
        events: [
          { id: 'sig', type: 'FLUSH', at: 1, cancelRef: 'TODO', cancelMode: 'type' },
          { id: 't1', type: 'TODO', at: 5 },
          { id: 't2', type: 'TODO', at: 6 },
          { id: 'keep', type: 'OTHER', at: 7 },
        ],
      },
      testRegistry(),
    );
    const steps = runAll(engine);
    expect(steps.filter((s) => s.kind === 'canceled').map((s) => s.eventId).sort()).toEqual([
      't1',
      't2',
    ]);
    // OTHER 不被波及（在 f 状态 skipped，但事件确实出队了）
    expect(steps.find((s) => s.eventId === 'keep')?.kind).toBe('skipped');
  });

  it('取消匹配不到目标时幂等无副作用，信号自身正常转移', () => {
    const machine: MachineDef = {
      initial: 's',
      context: {},
      states: { s: { transitions: [{ on: 'GO', target: 'e' }] }, e: { transitions: [] } },
    };
    const engine = new Engine(
      machine,
      { events: [{ id: 'g', type: 'GO', at: 0, cancelRef: 'ghost', cancelMode: 'id' }] },
      testRegistry(),
    );
    const steps = runAll(engine);
    expect(steps.find((s) => s.eventId === 'g')?.kind).toBe('applied');
    expect(steps.filter((s) => s.kind === 'canceled')).toHaveLength(0);
  });

  it('信号事件转移失败回滚时，其取消效果一并撤销（原子性）', () => {
    const machine: MachineDef = {
      initial: 's',
      context: {},
      onFailure: 'rollback',
      states: {
        s: {
          transitions: [
            {
              on: 'SIG',
              target: 'e',
              guard: {
                // 守卫结构性错误
                kind: 'binary',
                op: '+',
                left: { kind: 'path', path: 'ctx.missing.deep' },
                right: { kind: 'literal', value: 1 },
              },
              guardSource: 'ctx.missing.deep + 1',
            },
          ],
        },
        e: { transitions: [] },
      },
    };
    const engine = new Engine(
      machine,
      {
        events: [
          { id: 'sig', type: 'SIG', at: 0, cancelRef: 'future', cancelMode: 'id' },
          { id: 'future', type: 'WHATEVER', at: 10 },
        ],
      },
      testRegistry(),
    );
    const steps = runAll(engine);
    expect(steps.find((s) => s.eventId === 'sig')?.kind).toBe('rolled-back');
    // 取消被回滚：future 仍然存活并在之后出队
    expect(engine.snapshot().queue).toHaveLength(0); // future 已被处理（skipped）
    expect(steps.find((s) => s.eventId === 'future')?.kind).toBe('skipped');
    expect(steps.filter((s) => s.kind === 'canceled')).toHaveLength(0);
  });
});
