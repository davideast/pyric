import * as ohm from 'ohm-js';
import { grammar } from './RtdbExprParser.js';

export interface SimulatedAuth {
  uid: string;
  token: Record<string, unknown>;
}

/** Property names that must never be read through rule member/index
 *  access. They expose the JS object graph (`constructor` → `Function`,
 *  `__proto__`/`prototype` → the prototype chain) and are the gadget
 *  keys for a sandbox escape. Real RTDB rule data has no such fields. */
const FORBIDDEN_MEMBERS = new Set(['__proto__', 'prototype', 'constructor']);

/** Read `key` off a rule value without exposing prototype-chain gadgets
 *  or inherited properties. Returns null for forbidden or absent keys. */
function safeMemberRead(recv: unknown, key: string): unknown {
  if (FORBIDDEN_MEMBERS.has(key)) return null;
  if (typeof recv === 'string') {
    // RTDB rules expose `.length` on strings as a property; nothing else.
    return key === 'length' ? recv.length : null;
  }
  if (recv === null || typeof recv !== 'object') return null;
  // Own-property access only — never walk the prototype chain.
  if (!Object.hasOwn(recv as object, key)) return null;
  return (recv as Record<string, unknown>)[key] ?? null;
}

export interface EvalContext {
  auth: SimulatedAuth | null;
  data: DataSnapshot;
  newData: DataSnapshot;
  root: DataSnapshot;
  now: number;
  pathVariableBindings: Record<string, string>;
}

export class DataSnapshot {
  private _value: unknown;
  private _path: string;
  private _root: unknown;

  constructor(value: unknown, path: string = '/', root?: unknown) {
    this._value = value ?? null;
    this._path = path;
    this._root = root !== undefined ? root : value;
  }

  val(): unknown {
    return this._value;
  }

  exists(): boolean {
    return this._value !== null && this._value !== undefined;
  }

  hasChild(path: string): boolean {
    return this.child(path).exists();
  }

  hasChildren(keys?: readonly unknown[]): boolean {
    // `hasChildren(['a', 'b'])` — true only when EVERY listed key is
    // present (prod semantics). `hasChildren()` — true when the node has
    // at least one child.
    if (Array.isArray(keys)) {
      return keys.every((key) => this.hasChild(String(key)));
    }
    return (
      typeof this._value === 'object' &&
      this._value !== null &&
      Object.keys(this._value as object).length > 0
    );
  }

  isString(): boolean {
    return typeof this._value === 'string';
  }

  isNumber(): boolean {
    return typeof this._value === 'number';
  }

  isBoolean(): boolean {
    return typeof this._value === 'boolean';
  }

  child(path: string): DataSnapshot {
    const parts = path.split('/').filter(p => p.length > 0);
    let current: unknown = this._value;
    let currentPath = this._path;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        current = null;
        currentPath = `${currentPath}/${part}`.replace(/\/+/g, '/');
        break;
      }
      // Own-property access only: a `__proto__`/`constructor` child must
      // not resolve to the JS prototype chain.
      current = Object.hasOwn(current as object, part)
        ? ((current as Record<string, unknown>)[part] ?? null)
        : null;
      currentPath = `${currentPath === '/' ? '' : currentPath}/${part}`;
    }

    return new DataSnapshot(current, currentPath, this._root);
  }

  parent(): DataSnapshot | null {
    if (this._path === '/') return null;
    const parts = this._path.split('/').filter(p => p.length > 0);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    const rootSnap = new DataSnapshot(this._root, '/');
    if (parentPath === '/') return rootSnap;
    return rootSnap.child(parts.join('/'));
  }

  getPriority(): null {
    return null;
  }
}

class RtdbString {
  constructor(private value: string) {}

  matches(pattern: RegExp | string): boolean {
    const r = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    return r.test(this.value);
  }

  contains(other: string): boolean {
    return this.value.includes(other);
  }

  beginsWith(prefix: string): boolean {
    return this.value.startsWith(prefix);
  }

  endsWith(suffix: string): boolean {
    return this.value.endsWith(suffix);
  }

  replace(from: string | RegExp, to: string): string {
    return this.value.replace(from, to);
  }

  toLowerCase(): string {
    return this.value.toLowerCase();
  }

  toUpperCase(): string {
    return this.value.toUpperCase();
  }

  get length(): number {
    return this.value.length;
  }
}

let _evalCtx: EvalContext = {
  auth: null,
  data: new DataSnapshot(null),
  newData: new DataSnapshot(null),
  root: new DataSnapshot(null),
  now: Date.now(),
  pathVariableBindings: {},
};

const evalSemantics = grammar.createSemantics();
evalSemantics.addOperation<unknown>('eval', {
  Expr(node) { return (node as any).eval(); },

  Ternary_ternary(cond, _q, then, _c, els) {
    return (cond as any).eval() ? (then as any).eval() : (els as any).eval();
  },
  Ternary(node) { return (node as any).eval(); },

  Logical_and(left, _op, right) { return (left as any).eval() && (right as any).eval(); },
  Logical_or(left, _op, right) { return (left as any).eval() || (right as any).eval(); },
  Logical(node) { return (node as any).eval(); },

  Comparison_strictEq(left, _op, right) { return (left as any).eval() === (right as any).eval(); },
  Comparison_strictNeq(left, _op, right) { return (left as any).eval() !== (right as any).eval(); },
  Comparison_gte(left, _op, right) { return (left as any).eval() >= (right as any).eval(); },
  Comparison_lte(left, _op, right) { return (left as any).eval() <= (right as any).eval(); },
  Comparison_gt(left, _op, right) { return (left as any).eval() > (right as any).eval(); },
  Comparison_lt(left, _op, right) { return (left as any).eval() < (right as any).eval(); },
  Comparison_looseEq(left, _op, right) { return (left as any).eval() == (right as any).eval(); },
  Comparison_looseNeq(left, _op, right) { return (left as any).eval() != (right as any).eval(); },
  Comparison(node) { return (node as any).eval(); },

  Additive_add(left, _op, right) { return (left as any).eval() as number + ((right as any).eval() as number); },
  Additive_sub(left, _op, right) { return (left as any).eval() as number - ((right as any).eval() as number); },
  Additive(node) { return (node as any).eval(); },

  Multiplicative_mul(left, _op, right) { return (left as any).eval() as number * ((right as any).eval() as number); },
  Multiplicative_div(left, _op, right) { return (left as any).eval() as number / ((right as any).eval() as number); },
  Multiplicative_mod(left, _op, right) { return (left as any).eval() as number % ((right as any).eval() as number); },
  Multiplicative(node) { return (node as any).eval(); },

  UnaryExpr_not(_op, expr) { return !(expr as any).eval(); },
  UnaryExpr_neg(_op, expr) { return -((expr as any).eval() as number); },
  UnaryExpr(node) { return (node as any).eval(); },

  CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
    const recv = (receiver as any).eval();
    const method = methodName.sourceString;
    const argValues = (args as any).asIteration().children.map((a: any) => (a as any).eval());

    if (recv instanceof DataSnapshot) {
      switch (method) {
        case 'val': return recv.val();
        case 'exists': return recv.exists();
        case 'hasChild': return recv.hasChild(String(argValues[0]));
        case 'hasChildren': return recv.hasChildren(argValues.length > 0 ? (argValues[0] as unknown[]) : undefined);
        case 'isString': return recv.isString();
        case 'isNumber': return recv.isNumber();
        case 'isBoolean': return recv.isBoolean();
        case 'child': return recv.child(String(argValues[0]));
        case 'parent': return recv.parent();
        case 'getPriority': return recv.getPriority();
        default: throw new Error(`Unknown DataSnapshot method: ${method}`);
      }
    }

    if (typeof recv === 'string') {
      const str = new RtdbString(recv);
      switch (method) {
        case 'matches': return str.matches(argValues[0] as RegExp | string);
        case 'contains': return str.contains(String(argValues[0]));
        case 'beginsWith': return str.beginsWith(String(argValues[0]));
        case 'endsWith': return str.endsWith(String(argValues[0]));
        case 'replace': return str.replace(argValues[0] as string | RegExp, String(argValues[1]));
        case 'toLowerCase': return str.toLowerCase();
        case 'toUpperCase': return str.toUpperCase();
        default: throw new Error(`Unknown string method: ${method}`);
      }
    }

    // No generic method-call fallback. Dispatching to an arbitrary JS
    // method on an arbitrary receiver (`recv[method].apply(recv, ...)`)
    // is a sandbox-escape primitive: e.g. `(0).constructor.constructor(...)`
    // reaches the `Function` constructor and executes attacker-supplied
    // code. Only the RTDB-rules methods explicitly allowlisted above
    // (DataSnapshot and string methods) may be called.
    throw new Error(`Unknown method '${method}' for the given value.`);
  },

  CallExpr_memberAccess(receiver, _dot, member) {
    const recv = (receiver as any).eval();
    if (recv === null || recv === undefined) return null;
    return safeMemberRead(recv, member.sourceString);
  },

  CallExpr_indexAccess(receiver, _open, index, _close) {
    const recv = (receiver as any).eval();
    const idx = (index as any).eval();
    if (recv === null || recv === undefined) return null;
    return safeMemberRead(recv, String(idx));
  },

  CallExpr(node) { return (node as any).eval(); },

  Primary_paren(_open, expr, _close) { return (expr as any).eval(); },
  Primary(node) { return (node as any).eval(); },

  Array(_open, elems, _close) {
    return (elems as any).asIteration().children.map((e: any) => (e as any).eval());
  },

  literal(node) { return (node as any).eval(); },

  number_float(_int, _dot, _frac) { return parseFloat(this.sourceString); },
  number_int(_digits) { return parseInt(this.sourceString, 10); },
  number(node) { return (node as any).eval(); },

  string_double(_open, _chars, _close) {
    return JSON.parse(this.sourceString);
  },
  string_single(_open, chars, _close) {
    return chars.children.map((c: any) => c.sourceString).join('');
  },
  string(node) { return (node as any).eval(); },

  regex(_slash1, body, _slash2, flags) {
    return new RegExp(body.sourceString, flags.sourceString);
  },

  bool_true(_lit) { return true; },
  bool_false(_lit) { return false; },
  bool(node) { return (node as any).eval(); },

  null(_lit) { return null; },

  ident(_dollar, _start, _rest) {
    const name = this.sourceString;
    if (name in _evalCtx.pathVariableBindings) {
      return _evalCtx.pathVariableBindings[name];
    }
    switch (name) {
      case 'auth': return _evalCtx.auth;
      case 'data': return _evalCtx.data;
      case 'newData': return _evalCtx.newData;
      case 'root': return _evalCtx.root;
      case 'now': return _evalCtx.now;
      default: return undefined;
    }
  },
});

export function evaluateExpression(match: ohm.MatchResult, ctx: EvalContext): unknown {
  _evalCtx = ctx;
  return (evalSemantics(match) as any).eval();
}
