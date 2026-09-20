import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRegistry } from '../src/server/actionRegistry';
import { SessionManager, SimulationSession } from '../src/server/session';
import type { MachineDef, ScenarioDef, ServerMessage, Step } from '../src/shared/types';

// 足够长的链式机器：每个 E 自转换并派发下一个 E（同刻后批道），用于产生大量步骤
function chainMachine(): MachineDef {
  return {
    initial: 's0',
    context: { n: 0 },
    states: {
      s0: {
        transitions: [
          {
            on: 'E',
            actions: [
              { type: 'assign', path: 'n', value: { kind: 'binary', op: '+', left: { kind: 'path', path: 'ctx.n' }, right: { kind: 'literal', value: 1 } } },
            ],
          },
        ],
      },
    },
  };
}

function chainScenario(count: number): ScenarioDef {
  return {
    events: Array.from({ length: count }, (_, i) => ({ id: `e${i}`, type: 'E', at: i })),
  };
}

function makeSession(ttlMs = 60_000): SimulationSession {
  const manager = new SessionManager(new ActionRegistry());
  return manager.create(chainMachine(), chainScenario(10), ttlMs);
}

function collect(session: SimulationSession, afterSeq = 0): {
  msgs: ServerMessage[];
  stop: () => void;
} {
  const msgs: ServerMessage[] = [];
  // 先挂实时监听，再做重放
  const stop = session.subscribe((m) => msgs.push(m));
  session.replaySince(afterSeq, (m) => msgs.push(m));
  return { msgs, stop };
}

const stepMsgs = (msgs: ServerMessage[]): Step[] =>
  msgs.filter((m): m is Extract<ServerMessage, { type: 'step' }> => m.type === 'step').map((m) => m.step);

describe('暂停 / 继续 / 单步 / 跳转：不改变执行顺序', () => {
  it('单步推进的步骤序列与一次性推进完全一致（播放节奏不改顺序）', () => {
    // jump(到末尾) = 引擎一次性确定性推进；播放只是给它加上墙钟间隔
    const oneShot = makeSession();
    oneShot.jump(10);
    const fully = oneShot.snapshot().steps.map((s) => s.eventId + ':' + s.kind).join('|');

    const manual = makeSession();
    manual.pause();
    for (;;) {
      const r = manual.step();
      if (!r.ok) break;
      const st = r.snapshot.status;
      if (st === 'completed' || st === 'terminated') break;
    }
    const stepwise = manual.snapshot().steps.map((s) => s.eventId + ':' + s.kind).join('|');
    expect(stepwise).toBe(fully);
    expect(fully).toContain('e0:applied');
    expect(fully).toContain('e9:applied');
  });

  it('回跳只移动观察位置；继续后步骤序号与状态不重放', () => {
    const s = makeSession();
    for (let i = 0; i < 5; i++) s.step();
    const at5 = s.snapshot();
    expect(at5.steps.length).toBe(5);

    s.jump(2);
    const jumped = s.snapshot();
    // 引擎步骤不会因回跳减少（不重放）
    expect(jumped.steps.length).toBe(5);
    expect(jumped.context.n).toBe(at5.context.n);

    // 再前跳到 8
    s.jump(8);
    expect(s.snapshot().steps.length).toBe(8);
    const cont = s.snapshot().steps.map((x) => x.seq);
    expect(cont).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('暂停期间不产生步骤；继续后从断点严格延续', () => {
    const s = makeSession();
    for (let i = 0; i < 3; i++) s.step();
    const before = s.snapshot().steps.length;
    s.pause();
    vi.useFakeTimers();
    s.play({ wait: 10 });
    vi.advanceTimersByTime(25);
    const afterFew = s.snapshot().steps.length;
    expect(afterFew).toBeGreaterThan(before);
    s.pause();
    const pausedAt = s.snapshot().steps.length;
    vi.advanceTimersByTime(200);
    expect(s.snapshot().steps.length).toBe(pausedAt);
    vi.useRealTimers();
  });
});

describe('断线重连：从最后确认序号续传且不重复应用', () => {
  it('重放只发送 lastSeq 之后的步骤，seq 连续且事件不重复应用', () => {
    const s = makeSession();
    for (let i = 0; i < 6; i++) s.step();

    const { msgs, stop } = collect(s, 3);
    const replayed = stepMsgs(msgs);
    expect(replayed.map((x) => x.seq)).toEqual([4, 5, 6]);
    // 重放不会再次推进引擎：上下文只应用了 6 次
    expect(s.snapshot().context.n).toBe(6);
    stop();
  });

  it('实时断线期间新步骤在重连后补齐，且与实时流无重复', () => {
    const s = makeSession();
    for (let i = 0; i < 3; i++) s.step();
    // 客户端最后确认到 3 后断线；服务端继续推进到 6
    for (let i = 0; i < 3; i++) s.step();

    const { msgs, stop } = collect(s, 3);
    const seqs = stepMsgs(msgs).map((m) => m.seq);
    expect(seqs).toEqual([4, 5, 6]);
    expect(new Set(seqs).size).toBe(seqs.length);
    stop();
  });

  it('确认点已滑出有界缓冲时：不猜补中间步骤，改发整量快照 + REPLAY_TRUNCATED', () => {
    const s = makeSession();
    for (let i = 0; i < 10; i++) s.step();
    const { msgs, stop } = collect(s, 0);
    // 缓冲容量 200，不会截断——用超大会话制造截断
    stop();

    const big = new SessionManager(new ActionRegistry()).create(chainMachine(), chainScenario(220), 60_000);
    big.jump(215);
    const collected: ServerMessage[] = [];
    big.replaySince(5, (m) => collected.push(m));
    const errMsg = collected.find((m) => m.type === 'error');
    const snapMsg = collected.find((m) => m.type === 'snapshot');
    expect(errMsg).toBeDefined();
    if (errMsg?.type === 'error') expect(errMsg.error.code).toBe('REPLAY_TRUNCATED');
    expect(snapMsg).toBeDefined();
  });
});

describe('命令幂等', () => {
  it('同一 commandId 重放返回同一结果且不重复推进', () => {
    const s = makeSession();
    const r1 = s.command({ commandId: 'cmd-1' }, () => s.step());
    const n1 = r1.ok ? r1.snapshot.steps.length : -1;
    const r2 = s.command({ commandId: 'cmd-1' }, () => s.step());
    const n2 = r2.ok ? r2.snapshot.steps.length : -1;
    expect(n1).toBe(n2);
    expect(n1).toBe(1);
  });

  it('外部事件注入幂等：重复 id 被拒绝', () => {
    const s = makeSession();
    const ok = s.enqueue({ id: 'dup', type: 'E', at: 50 });
    expect(ok.ok).toBe(true);
    const bad = s.enqueue({ id: 'dup', type: 'E', at: 51 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('EVENT_DUP_ID');
  });
});

describe('会话过期', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('TTL 到期销毁会话、广播 expired，命令返回 SESSION_EXPIRED', () => {
    const manager = new SessionManager(new ActionRegistry());
    const s = manager.create(chainMachine(), chainScenario(3), 100);
    const expired = vi.fn();
    s.subscribe((m) => {
      if (m.type === 'expired') expired();
    });
    vi.advanceTimersByTime(101);
    expect(expired).toHaveBeenCalledOnce();
    expect(manager.get(s.id)).toBeUndefined();
  });

  it('活动会刷新 TTL', () => {
    const manager = new SessionManager(new ActionRegistry());
    const s = manager.create(chainMachine(), chainScenario(3), 100);
    vi.advanceTimersByTime(80);
    s.pause(); // touch
    vi.advanceTimersByTime(80);
    expect(manager.get(s.id)).toBeDefined();
    vi.advanceTimersByTime(30);
    expect(manager.get(s.id)).toBeUndefined();
  });
});
