import type { DiffEntry, JSONValue } from './types';

// 结构化 JSON diff：对象递归、数组按下标
export function diffJson(before: JSONValue, after: JSONValue, basePath = ''): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(before, after, basePath, out);
  return out;
}

function walk(before: JSONValue, after: JSONValue, path: string, out: DiffEntry[]) {
  if (equal(before, after)) return;
  if (isObj(before) && isObj(after) && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of [...keys].sort()) {
      const p = path ? `${path}.${k}` : k;
      const hasB = Object.prototype.hasOwnProperty.call(before, k);
      const hasA = Object.prototype.hasOwnProperty.call(after, k);
      if (!hasB && hasA) out.push({ kind: 'add', path: p, newValue: after[k] });
      else if (hasB && !hasA) out.push({ kind: 'remove', path: p, oldValue: before[k] });
      else walk(before[k], after[k], p, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= before.length) out.push({ kind: 'add', path: p, newValue: after[i] });
      else if (i >= after.length) out.push({ kind: 'remove', path: p, oldValue: before[i] });
      else walk(before[i], after[i], p, out);
    }
    return;
  }
  out.push({ kind: 'change', path: path || '$', oldValue: before, newValue: after });
}

function isObj(v: JSONValue): v is Record<string, JSONValue> {
  return typeof v === 'object' && v !== null;
}

function equal(a: JSONValue, b: JSONValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => equal((a as Record<string, JSONValue>)[k], (b as Record<string, JSONValue>)[k]));
  }
  return false;
}
