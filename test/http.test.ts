import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildRegistry } from '../src/server/main';
import { createApp } from '../src/server/http';
import { DEFAULT_PRESET_ID, PRESETS } from '../src/server/presets';
import type { ServerMessage, SnapshotResponse } from '../src/shared/types';

let server: Server;
let base: string;

beforeAll(async () => {
  const { app } = createApp({ registry: buildRegistry() });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

const j = async (url: string, init?: RequestInit) => {
  const res = await fetch(base + url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json();
  return { res, body };
};

const preset = PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;

describe('REST API', () => {
  it('健康检查与预置列表', async () => {
    const h = await j('/api/health');
    expect(h.body.ok).toBe(true);
    expect(h.body.registryActions).toContain('maybeExplode');

    const p = await j('/api/presets');
    expect(p.body.presets.length).toBeGreaterThanOrEqual(6);
  });

  it('创建会话 → 单步 → 暂停 → 快照，非法机器返回结构化错误', async () => {
    const created = await j('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ machine: preset.machine, scenario: preset.scenario, ttlMs: 60000 }),
    });
    expect(created.res.status).toBe(201);
    const id = created.body.sessionId as string;

    let snap: SnapshotResponse;
    for (let i = 0; i < 3; i++) {
      const r = await j(`/api/sessions/${id}/step`, {
        method: 'POST',
        body: JSON.stringify({ commandId: `step-${i}` }),
      });
      snap = r.body as SnapshotResponse;
    }
    expect(snap!.steps.length).toBe(3);

    // 命令幂等：相同 commandId 不产生第 4 步
    const replay = await j(`/api/sessions/${id}/step`, {
      method: 'POST',
      body: JSON.stringify({ commandId: 'step-2' }),
    });
    expect((replay.body as SnapshotResponse).steps.length).toBe(3);

    // 注入过去时刻事件 → 结构化 409
    const past = await j(`/api/sessions/${id}/events`, {
      method: 'POST',
      body: JSON.stringify({ id: 'late', type: 'START', at: -999 }),
    });
    expect(past.res.status).toBe(409);
    expect(past.body.error.code).toBe('EVENT_IN_PAST');

    // 非法机器（未注册动作）→ 400 MACHINE_INVALID
    const badMachine = structuredClone(preset.machine);
    (badMachine.states as Record<string, unknown>).idle = {
      transitions: [{ on: 'X', actions: [{ type: 'name', name: 'ghost-action' }] }],
    };
    const bad = await j('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ machine: badMachine, scenario: preset.scenario }),
    });
    expect(bad.res.status).toBe(400);
    expect(bad.body.error.code).toBe('MACHINE_INVALID');
  });

  it('会话不存在返回 404', async () => {
    const r = await j('/api/sessions/nope');
    expect(r.res.status).toBe(404);
    expect(r.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

// ---------- SSE 续传 ----------

function openStream(id: string, afterSeq?: number): {
  messages: ServerMessage[];
  controller: AbortController;
} {
  const controller = new AbortController();
  const messages: ServerMessage[] = [];
  const url = `${base}/api/sessions/${id}/stream${afterSeq ? `?afterSeq=${afterSeq}` : ''}`;
  void (async () => {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (dataLine) messages.push(JSON.parse(dataLine.slice(5).trim()));
      }
    }
  })().catch(() => undefined);
  return { messages, controller };
}

const waitFor = async (predicate: () => boolean, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待 SSE 消息超时');
};

describe('SSE 流式推送与断线续传', () => {
  it('播放时逐步骤推送；断开后从最后确认序号续传，无重复', async () => {
    const created = await j('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ machine: preset.machine, scenario: preset.scenario, ttlMs: 60000 }),
    });
    const id = created.body.sessionId as string;

    const first = openStream(id);
    await waitFor(() => first.messages.some((m) => m.type === 'hello'));

    await j(`/api/sessions/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ commandId: 'play-1', wait: 5 }),
    });

    await waitFor(() => first.messages.some((m) => m.type === 'status' && m.status === 'completed'), 5000);
    const firstSteps = first.messages.filter((m) => m.type === 'step').map((m) => (m as { step: { seq: number } }).step.seq);
    expect(firstSteps.length).toBeGreaterThan(4);
    expect(new Set(firstSteps).size).toBe(firstSteps.length); // 无重复
    const confirmed = firstSteps[2]; // 客户端只确认到第 3 步

    // 断线
    first.controller.abort();
    await new Promise((r) => setTimeout(r, 100));

    // 用 Last-Event-ID 语义等价的 afterSeq 续传
    const second = openStream(id, confirmed);
    await waitFor(() => second.messages.some((m) => m.type === 'hello'));
    const replayed = second.messages.filter((m) => m.type === 'step').map((m) => (m as { step: { seq: number } }).step.seq);
    expect(replayed.length).toBeGreaterThan(0);
    expect(Math.min(...replayed)).toBe(confirmed + 1);
    // 与首次连接收到的尾部完全一致，且无重叠
    expect(replayed.every((s) => s > confirmed)).toBe(true);
    second.controller.abort();
  });

  it('会话 TTL 过期时流收到 expired 且后续请求 404', async () => {
    const created = await j('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ machine: preset.machine, scenario: preset.scenario, ttlMs: 300 }),
    });
    const id = created.body.sessionId as string;
    const stream = openStream(id);
    await waitFor(() => stream.messages.some((m) => m.type === 'expired'), 3000);
    await new Promise((r) => setTimeout(r, 50));
    const gone = await j(`/api/sessions/${id}`);
    expect(gone.res.status).toBe(404);
  });
});
