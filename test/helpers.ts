import { ActionRegistry } from '../src/server/actionRegistry';
import { Engine } from '../src/server/engine';
import type { JSONValue, MachineDef, ScenarioDef, Step } from '../src/shared/types';

// 与 src/server/main.ts 中相同的演示注入动作；测试自带注册表以避免依赖进程入口
export function testRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register('recordLog', (ctx, event, api) => {
    const prev = Array.isArray(ctx.log) ? (ctx.log as JSONValue[]) : [];
    const payload = (event.payload ?? {}) as { ref?: JSONValue };
    api.assign('log', [...prev, { at: 'n:' + String(ctx.count), ref: payload.ref ?? null }]);
  });
  registry.register('recordAudit', (ctx, _event, api) => {
    const prev = Array.isArray(ctx.log) ? ctx.log : [];
    api.assign('log', [...prev, { audit: true, n: ctx.count ?? null }]);
  });
  registry.register('maybeExplode', (ctx, _event, api) => {
    if (Number(ctx.attempts ?? 0) >= 3) {
      api.fail('E_BOOM', `第 ${ctx.attempts} 次尝试爆炸`);
    }
  });
  registry.register('naughtyMutate', (ctx) => {
    (ctx as { hacked?: boolean }).hacked = true;
  });
  return registry;
}

export function runAll(engine: Engine): Step[] {
  const out: Step[] = [];
  for (;;) {
    const batch = engine.advanceOne();
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.some((s) => s.kind === 'terminated' || s.kind === 'boundary')) break;
  }
  return out;
}

export function makeEngine(machine: MachineDef, scenario: ScenarioDef, registry = testRegistry()): Engine {
  return new Engine(machine, scenario, registry);
}

export function appliedSteps(steps: Step[]): Step[] {
  return steps.filter((s) => s.kind === 'applied');
}
