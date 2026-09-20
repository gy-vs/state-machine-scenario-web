// 守卫表达式：词法分析 + Pratt 解析 + 确定性求值
// 白名单语法：字面量、ctx/event 路径、算术、比较、逻辑、三元、in；无函数调用、无赋值
import type { GuardNode, JSONValue, JsonObject, StructuredError } from './types';

const TOKEN_RE =
  /\s*(?:(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(true|false|null)|\b(ctx|event)\b|([A-Za-z_$][A-Za-z0-9_$]*)|(===|!==|==|!=|<=|>=|&&|\|\||\?\?|[+\-*/%<>!?:.,\[\](){}]))/y;

type Token = { value: string; start: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  while (i < src.length) {
    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(src);
    if (!m || m.index !== i) {
      throw new ExprError('EXPR_TOKEN', `无法解析的字符，位置 ${i}: "${src.slice(i, i + 12)}"`, i);
    }
    tokens.push({ value: m[0].trim(), start: i });
    i = m.index + m[0].length;
  }
  return tokens;
}

export class ExprError extends Error {
  code = 'EXPR_PARSE';
  pos: number;
  constructor(code: string, message: string, pos: number) {
    super(message);
    this.code = code;
    this.pos = pos;
  }
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): GuardNode {
    const node = this.parseExpr(0);
    if (this.pos < this.tokens.length) {
      throw new ExprError('EXPR_PARSE', `多余的 token: ${this.peek()?.value}`, this.peek()?.start ?? 0);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new ExprError('EXPR_PARSE', '意外的表达式结尾', 0);
    return t;
  }
  private accept(value: string): boolean {
    if (this.peek()?.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expect(value: string): Token {
    const t = this.peek();
    if (!t || t.value !== value) {
      throw new ExprError('EXPR_PARSE', `期望 "${value}"，实际 "${t?.value ?? 'EOF'}"`, t?.start ?? 0);
    }
    this.pos++;
    return t;
  }

  private bindingPower(op: string): [number, number] | undefined {
    switch (op) {
      case '||':
        return [1, 2];
      case '??':
        return [2, 3];
      case '&&':
        return [3, 4];
      case '==':
      case '!=':
      case '===':
      case '!==':
        return [5, 6];
      case '<':
      case '<=':
      case '>':
      case '>=':
      case 'in':
        return [6, 7];
      case '+':
      case '-':
        return [8, 9];
      case '*':
      case '/':
      case '%':
        return [10, 11];
    }
    return undefined;
  }

  private parseExpr(minBp: number): GuardNode {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.value === '?') {
        if (minBp > 1) break;
        this.next();
        const consequent = this.parseExpr(0);
        this.expect(':');
        const alternate = this.parseExpr(1);
        left = { kind: 'ternary', test: left, consequent, alternate };
        continue;
      }
      const bp = t.value === 'in' ? this.bindingPower('in') : this.bindingPower(t.value);
      if (!bp || bp[0] < minBp) break;
      this.next();
      const right = this.parseExpr(bp[1]);
      left = { kind: 'binary', op: t.value as never, left, right };
    }
    return left;
  }

  private parsePrefix(): GuardNode {
    const t = this.next();
    if (t.value === '!') return { kind: 'unary', op: '!', arg: this.parseExpr(12) };
    if (t.value === '-') return { kind: 'unary', op: '-', arg: this.parseExpr(12) };
    if (t.value === '(') {
      const node = this.parseExpr(0);
      this.expect(')');
      return node;
    }
    if (t.value === '[') return this.parseArray(t);
    if (t.value === '{') return this.parseObject(t);
    if (t.value === 'true') return { kind: 'literal', value: true };
    if (t.value === 'false') return { kind: 'literal', value: false };
    if (t.value === 'null') return { kind: 'literal', value: null };
    if (/^\d/.test(t.value)) return { kind: 'literal', value: Number(t.value) };
    if (t.value.startsWith('"') || t.value.startsWith("'")) {
      return { kind: 'literal', value: unescape(t.value.slice(1, -1)) };
    }
    if (/^[A-Za-z_$]/.test(t.value)) {
      // 路径：ident(.ident | [number] | ["string"])*
      let path = t.value;
      for (;;) {
        if (this.accept('.')) {
          const id = this.next();
          if (!/^[A-Za-z_$]/.test(id.value)) {
            throw new ExprError('EXPR_PARSE', `路径成员非法: ${id.value}`, id.start);
          }
          path += '.' + id.value;
        } else if (this.accept('[')) {
          const k = this.next();
          if (/^\d/.test(k.value)) path += `[${k.value}]`;
          else if (k.value.startsWith('"') || k.value.startsWith("'")) {
            path += `[${k.value}]`;
          } else throw new ExprError('EXPR_PARSE', `下标必须是数字或字符串: ${k.value}`, k.start);
          this.expect(']');
        } else break;
      }
      return { kind: 'path', path };
    }
    throw new ExprError('EXPR_PARSE', `无法识别的 token: ${t.value}`, t.start);
  }

  private parseArray(open: Token): GuardNode {
    const items: GuardNode[] = [];
    if (this.peek()?.value !== ']') {
      for (;;) {
        items.push(this.parseExpr(0));
        if (this.accept(',')) continue;
        break;
      }
    }
    if (!this.accept(']')) {
      throw new ExprError('EXPR_PARSE', `数组字面量缺少 "]"`, open.start);
    }
    return { kind: 'array', items };
  }

  private parseObject(open: Token): GuardNode {
    const props: { key: string; value: GuardNode }[] = [];
    if (this.peek()?.value !== '}') {
      for (;;) {
        const keyTok = this.next();
        const key = keyTok.value.replace(/^["']|["']$/g, '');
        if (!/^[A-Za-z_$]/.test(key) && !keyTok.value.startsWith('"') && !keyTok.value.startsWith("'")) {
          throw new ExprError('EXPR_PARSE', `对象键非法: ${keyTok.value}`, keyTok.start);
        }
        this.expect(':');
        props.push({ key, value: this.parseExpr(0) });
        if (this.accept(',')) continue;
        break;
      }
    }
    if (!this.accept('}')) {
      throw new ExprError('EXPR_PARSE', `对象字面量缺少 "}"`, open.start);
    }
    return { kind: 'object', props };
  }
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

export function parseGuard(source: string): GuardNode {
  const tokens = tokenize(source);
  if (tokens.length === 0) throw new ExprError('EXPR_PARSE', '空守卫表达式', 0);
  return new Parser(tokens).parse();
}

// ---------- 求值 ----------

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

function readPath(root: unknown, path: string): JSONValue | undefined {
  // ctx.foo.bar[0]["x"] / event.payload.x / 裸名
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[["']([^"']+)["']\]/g, '.$1')
    .split('.');
  let cur: unknown = root;
  if (parts[0] === 'ctx' || parts[0] === 'event') {
    cur = (root as Record<string, unknown>)[parts[0]];
    parts.shift();
  }
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)?.[p];
  }
  return cur as JSONValue | undefined;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function evalGuard(
  node: GuardNode,
  scope: { ctx: JsonObject; event: { id: string; type: string; payload?: JsonObject } },
): JSONValue {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return readPath(scope, node.path) ?? null;
    case 'array':
      return node.items.map((n) => evalGuard(n, scope));
    case 'object': {
      const out: Record<string, JSONValue> = {};
      for (const p of node.props) out[p.key] = evalGuard(p.value, scope);
      return out;
    }
    case 'unary': {
      const v = evalGuard(node.arg, scope);
      if (node.op === '!') return !truthy(v);
      if (typeof v !== 'number') throw new ExprError('EXPR_TYPE', `一元 "-" 需要数字，得到 ${typeName(v)}`, 0);
      return -v;
    }
    case 'ternary':
      return truthy(evalGuard(node.test, scope))
        ? evalGuard(node.consequent, scope)
        : evalGuard(node.alternate, scope);
    case 'binary':
      return evalBinary(node, scope);
  }
}

function truthy(v: JSONValue): boolean {
  return v !== false && v !== null && v !== 0 && v !== '';
}

function evalBinary(node: Extract<GuardNode, { kind: 'binary' }>, scope: Parameters<typeof evalGuard>[1]): JSONValue {
  const op = node.op;
  if (op === '&&') return truthy(evalGuard(node.left, scope)) ? evalGuard(node.right, scope) : false;
  if (op === '||') {
    const l = evalGuard(node.left, scope);
    return truthy(l) ? l : evalGuard(node.right, scope);
  }
  const l = evalGuard(node.left, scope);
  if (op === '??') return l === null || l === undefined ? evalGuard(node.right, scope) : l;
  const r = evalGuard(node.right, scope);
  switch (op) {
    case '===':
      return l === r;
    case '!==':
      return l !== r;
    case '==':
      // 抽象数据只做宽松相等：数字/布尔/字符串，null/undefined 等价
      return l == r; // eslint-disable-line eqeqeq
    case '!=':
      return l != r; // eslint-disable-line eqeqeq
    case '<':
      return num(l) < num(r);
    case '<=':
      return num(l) <= num(r);
    case '>':
      return num(l) > num(r);
    case '>=':
      return num(l) >= num(r);
    case '+':
      return num(l) + num(r);
    case '-':
      return num(l) - num(r);
    case '*':
      return num(l) * num(r);
    case '/':
      if (num(r) === 0) throw new ExprError('EXPR_DIV0', '除零', 0);
      return num(l) / num(r);
    case '%':
      if (num(r) === 0) throw new ExprError('EXPR_DIV0', '模零', 0);
      return num(l) % num(r);
    case 'in': {
      if (typeof r !== 'object' || r === null) {
        throw new ExprError('EXPR_TYPE', `"in" 右侧需要对象/数组，得到 ${typeName(r)}`, 0);
      }
      if (typeof l !== 'string') throw new ExprError('EXPR_TYPE', `"in" 左侧需要字符串`, 0);
      return Array.isArray(r) ? r.includes(l) : l in r;
    }
  }
}

function num(v: JSONValue): number {
  if (typeof v !== 'number') throw new ExprError('EXPR_TYPE', `期望数字，得到 ${typeName(v)} (${JSON.stringify(v)})`, 0);
  return v;
}

export function guardError(err: unknown, at: number, eventId?: string): StructuredError {
  const e = err as ExprError;
  return {
    code: e?.code ?? 'EXPR_UNKNOWN',
    message: e?.message ?? String(err),
    phase: 'guard',
    at,
    eventId,
  };
}

export { deepFreeze };
