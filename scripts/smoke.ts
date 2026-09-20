// 端到端冒烟测试：HTTP 创建会话 → WS 挂载 → 运行 → 暂停 → 断线重连续传
/* eslint-disable no-console */
import WebSocket from 'ws';

const BASE = 'http://localhost:3001';

const machine = {
  initial: 'idle',
  context: { progress: 0, log: [] },
  states: {
    idle: { on: { START: { target: 'downloading', actions: ['appendLog', 'raiseTick'] } } },
    downloading: {
      on: {
        TICK: [
          { guard: 'progressDone', target: 'done', actions: ['appendLog', 'markComplete'] },
          { target: 'downloading', actions: ['bumpProgress', 'appendLog', 'raiseTick'] },
        ],
        PAUSE: { target: 'paused', actions: ['appendLog'] },
        RISKY: { target: 'failed', actions: ['explodingAction'] },
      },
    },
    paused: {
      on: {
        RESUME: { target: 'downloading', actions: ['appendLog', 'raiseTick'] },
        CANCEL: { target: 'cancelled', actions: ['appendLog'] },
      },
    },
    done: { on: {} },
    failed: { on: {} },
    cancelled: { on: {} },
  },
};

const scenario = {
  name: 'smoke',
  onError: 'rollback',
  steps: [
    { at: 0, send: [{ type: 'START' }] },
    { at: 7, send: [{ type: 'PAUSE', priority: 0 }, { type: 'RESUME', priority: 1 }] },
    { at: 12, send: [{ type: 'RISKY' }] },
    { at: 20, cancel: 'tick', priority: 0 },
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function attach(sessionId: string, lastAck: number): Promise<{ ws: WebSocket; msgs: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3001/ws');
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'attach', sessionId, lastAck }));
      resolve({ ws, msgs });
    });
    ws.on('error', reject);
  });
}

async function main() {
  // 1. 创建会话
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine, scenario }),
  });
  const { sessionId, snapshot } = (await res.json()) as any;
  console.log('✓ 创建会话', sessionId.slice(0, 8), '初始状态:', snapshot.state);
  console.log('  初始队列:', snapshot.queue.map((e: any) => `${e.type}@${e.time}(p${e.priority})`).join(', '));

  // 2. 挂载并单步 3 步
  const c1 = await attach(sessionId, 0);
  c1.ws.send(JSON.stringify({ type: 'control', op: 'step', count: 3 }));
  await sleep(300);
  const steps1 = c1.msgs.filter((m) => m.type === 'step');
  console.log(`✓ 单步×3: ${steps1.map((m) => `#${m.step.n} ${m.step.event.type} ${m.step.from}→${m.step.to}`).join(' | ')}`);
  const lastAck = steps1[steps1.length - 1].seq;

  // 3. 暂停后离线，服务端继续推进（模拟离线期间的执行）
  c1.ws.send(JSON.stringify({ type: 'control', op: 'pause' }));
  await sleep(100);
  c1.ws.close();
  await sleep(100);
  const c1b = await attach(sessionId, lastAck); // 用另一个连接推进
  c1b.ws.send(JSON.stringify({ type: 'control', op: 'step', count: 2 }));
  await sleep(300);
  c1b.ws.close();

  // 4. 断线重连：从 lastAck 续传
  const c2 = await attach(sessionId, lastAck);
  await sleep(200);
  const replayed = c2.msgs.filter((m) => m.type === 'step');
  console.log(`✓ 重连续传: 收到 ${replayed.length} 条漏掉的步骤, seq 全部 > ${lastAck}:`,
    replayed.every((m: any) => m.seq > lastAck));
  console.log('  resync 消息数:', c2.msgs.filter((m) => m.type === 'resync').length, '(应为 0，缓冲未截断)');

  // 5. 运行到结束，观察回滚与取消
  c2.ws.send(JSON.stringify({ type: 'control', op: 'start' }));
  await sleep(800);
  const all = c2.msgs.filter((m) => m.type === 'step').map((m) => m.step);
  const rolled = all.find((s: any) => s.rolledBack);
  const cancel = all.find((s: any) => s.note?.startsWith('cancel:'));
  console.log(`✓ 运行至结束: 共 ${all.length} 步, 最终状态:`,
    c2.msgs.filter((m) => m.type === 'snapshot' || m.type === 'status').pop()?.status);
  console.log('  回滚步骤:', rolled ? `#${rolled.n} ${rolled.event.type} [${rolled.error?.code}] ${rolled.error?.message}` : '无');
  console.log('  取消步骤:', cancel ? `#${cancel.n} ${cancel.note} 取消 ${cancel.cancelled.length} 个事件` : '无');
  const finalSnap = c2.msgs.filter((m) => m.type === 'step').pop();
  console.log('  结束时钟:', finalSnap?.step.clock);

  // 6. 会话过期
  await fetch(`${BASE}/api/sessions/${sessionId}/expire`, { method: 'POST' });
  const expired = await attach(sessionId, 0).catch(() => null);
  await sleep(200);
  const errMsg = expired?.msgs.find((m) => m.type === 'error');
  console.log('✓ 过期后 attach:', errMsg ? `${errMsg.code}（符合预期）` : '未收到错误（异常！）');

  process.exit(0);
}

main().catch((e) => {
  console.error('冒烟测试失败:', e);
  process.exit(1);
});
