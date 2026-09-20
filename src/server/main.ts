import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { JSONValue } from '../shared/types';
import { ActionRegistry } from './actionRegistry';
import { createApp } from './http';
import { DeterminismError } from './engine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);

// 注入式动作注册表：进程级共享，所有会话可用。
// 处理器同步执行；ctx 为冻结只读视图，所有写入必须经 api（进入确定性引擎）。
export function buildRegistry(): ActionRegistry {
  const registry = new ActionRegistry();

  registry.register('recordLog', (ctx, event, api) => {
    const prev = Array.isArray(ctx.log) ? (ctx.log as JSONValue[]) : [];
    const payload = (event.payload ?? {}) as { ref?: JSONValue };
    api.assign('log', [
      ...prev,
      { at: 'n:' + String(ctx.count), ref: payload.ref ?? null },
    ]);
  });

  registry.register('recordAudit', (ctx, _event, api) => {
    const prev = Array.isArray(ctx.log) ? (ctx.log as JSONValue[]) : [];
    api.assign('log', [...prev, { audit: true, n: (ctx.count as JSONValue) ?? null }]);
  });

  // 第三次被调用时结构性失败，用于回滚/终止情景演示。
  // 直接读取 ctx.attempts：该 assign 与本动作处于同一草稿事务，
  // 抛错后整个转移（含 attempts/committed 写入）回滚。
  registry.register('maybeExplode', (ctx, _event, api) => {
    const attempts = Number(ctx.attempts ?? 0);
    if (attempts >= 3) {
      api.fail('E_BOOM', `注入动作在第 ${attempts} 次尝试时爆炸`);
    }
  });

  // 演示“对冻结上下文直接写入”会被拒绝
  registry.register('naughtyMutate', (ctx) => {
    (ctx as { hacked?: boolean }).hacked = true;
  });

  return registry;
}

function main(): void {
  const registry = buildRegistry();
  const { app } = createApp({ registry });

  // 生产模式托管 Vite 构建产物
  const distDir = path.resolve(__dirname, '../../dist');
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (_req, res, next) => {
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[fsm-workbench] listening on http://localhost:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[fsm-workbench] injected actions: ${registry.names().join(', ')}`);
  });
}

// DeterminismError 在注册表文件之外被引用，供未来扩展错误映射时复用
export { DeterminismError };

main();
