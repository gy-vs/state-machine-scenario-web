// 可注入的动作/守卫注册表。
// 引擎只通过名字引用守卫与动作，注册表在创建会话时注入，
// 因此测试或业务方可以提供完全不同的实现。

import type { Registry } from './engine';
import type { JsonObject } from '../shared/types';

export function defaultRegistry(): Registry {
  return {
    guards: {
      always: () => true,
      never: () => false,
      progressDone: ({ context }) => Number(context.progress ?? 0) >= 100,
      payloadFlag: ({ event }) => Boolean((event.payload as JsonObject | undefined)?.flag),
      // 演示用：总是抛错的守卫，触发结构化 GUARD_ERROR
      explodingGuard: () => {
        throw new Error('guard exploded (demo)');
      },
    },
    actions: {
      // 通用赋值：payload.patch 为要合并进上下文的对象
      assign: ({ event }, api) => {
        const patch = (event.payload as JsonObject | undefined)?.patch;
        if (patch && typeof patch === 'object') api.assign(patch as JsonObject);
      },
      bumpProgress: ({ context }, api) => {
        api.assign({ progress: Number(context.progress ?? 0) + 25 });
      },
      // 嵌套派发：5 个虚拟时间单位后再次 TICK，形成自驱动链路
      raiseTick: (_input, api) => {
        api.raise({ type: 'TICK', token: 'tick' }, 5);
      },
      cancelToken: ({ event }, api) => {
        const token = String((event.payload as JsonObject | undefined)?.token ?? '');
        if (token) api.cancel(token);
      },
      appendLog: ({ context, event }, api) => {
        const log = Array.isArray(context.log) ? (context.log as unknown[]) : [];
        api.assign({ log: [...log, `${event.type}@${api.clock}`] });
      },
      markComplete: (_input, api) => {
        api.assign({ done: true });
      },
      // 演示用：总是抛错的动作，触发回滚或终止
      explodingAction: () => {
        throw new Error('action exploded (demo)');
      },
    },
  };
}
