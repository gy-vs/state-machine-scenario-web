import type { ActionHandler } from '../shared/types';

/**
 * 可注入动作注册表：会话创建时注入，机内声明的同名动作会被注册实现覆盖。
 * 注册表只提供纯副作用处理器，所有效果经 ActionContext 进入确定性引擎。
 */
export class ActionRegistry {
  private handlers = new Map<string, ActionHandler>();

  register(name: string, handler: ActionHandler): void {
    this.handlers.set(name, handler);
  }

  registerAll(map: Record<string, ActionHandler>): void {
    for (const [k, v] of Object.entries(map)) this.register(k, v);
  }

  get(name: string): ActionHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  names(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
