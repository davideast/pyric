import type { Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';

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

/** Process standard escape sequences in single-quoted string literals. */
function processStringEscapes(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\' || i === raw.length - 1) {
      out += c;
      continue;
    }
    const next = raw[++i];
    switch (next) {
      case '\\': out += '\\'; break;
      case '\'': out += '\''; break;
      case '"':  out += '"';  break;
      case 'n':  out += '\n'; break;
      case 'r':  out += '\r'; break;
      case 't':  out += '\t'; break;
      case 'b':  out += '\b'; break;
      case 'f':  out += '\f'; break;
      case '/':  out += '/';  break;
      default:   out += '\\' + next; break;
    }
  }
  return out;
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
    if (parts.length === 0) return this;

    let current: unknown = this._value;
    for (const part of parts) {
      if (current !== null && current !== undefined && typeof current === 'object') {
        current = Object.hasOwn(current as object, part)
          ? ((current as Record<string, unknown>)[part] ?? null)
          : null;
      } else {
        current = null;
      }
    }

    const prefix = this._path === '/' ? '' : this._path;
    const currentPath = `${prefix}/${parts.join('/')}`;
    return new DataSnapshot(current, currentPath, this._root);
  }

  parent(): DataSnapshot | null {
    if (this._path === '/') return null;
    const parts = this._path.split('/').filter(p => p.length > 0);
    parts.pop();
    if (parts.length === 0) {
      return new DataSnapshot(this._root, '/');
    }
    const rootSnap = new DataSnapshot(this._root, '/');
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

  /** Production's String.replace substitutes EVERY occurrence of the substring;
   *  JavaScript's `String.prototype.replace` given a STRING pattern substitutes
   *  only the first, so delegating to it straight silently diverged. Confirmed by
   *  the r11-string-validation capture: production ALLOWS the write whose rule is
   *  `newData.val().replace('_', '-') === 'a-b-c'` for the value `a_b_c`, which
   *  only holds under replace-all. */
  replace(from: string | RegExp, to: string): string {
    if (from instanceof RegExp) {
      const flags = from.flags.includes('g') ? from.flags : `${from.flags}g`;
      return this.value.replace(new RegExp(from.source, flags), to);
    }
    if (from === '') return this.value;
    return this.value.split(from).join(to);
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

let evalSemantics: Semantics | undefined;

function getEvalSemantics(): Semantics {
  if (evalSemantics) return evalSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addOperation<unknown>('eval(ctx)', {
    Expr(node) { return (node as any).eval(this.args.ctx); },

    Ternary_ternary(cond, _q, then, _c, els) {
      return (cond as any).eval(this.args.ctx) ? (then as any).eval(this.args.ctx) : (els as any).eval(this.args.ctx);
    },
    Ternary(node) { return (node as any).eval(this.args.ctx); },

    Logical_and(left, _op, right) { return (left as any).eval(this.args.ctx) && (right as any).eval(this.args.ctx); },
    Logical_or(left, _op, right) { return (left as any).eval(this.args.ctx) || (right as any).eval(this.args.ctx); },
    Logical(node) { return (node as any).eval(this.args.ctx); },

    Comparison_gte(left, _op, right) { return (left as any).eval(this.args.ctx) >= (right as any).eval(this.args.ctx); },
    Comparison_lte(left, _op, right) { return (left as any).eval(this.args.ctx) <= (right as any).eval(this.args.ctx); },
    Comparison_gt(left, _op, right) { return (left as any).eval(this.args.ctx) > (right as any).eval(this.args.ctx); },
    Comparison_lt(left, _op, right) { return (left as any).eval(this.args.ctx) < (right as any).eval(this.args.ctx); },
    Comparison_looseEq(left, _op, right) { return (left as any).eval(this.args.ctx) == (right as any).eval(this.args.ctx); },
    Comparison_looseNeq(left, _op, right) { return (left as any).eval(this.args.ctx) != (right as any).eval(this.args.ctx); },
    Comparison(node) { return (node as any).eval(this.args.ctx); },

    Additive_add(left, _op, right) { return (left as any).eval(this.args.ctx) as number + ((right as any).eval(this.args.ctx) as number); },
    Additive_sub(left, _op, right) { return (left as any).eval(this.args.ctx) as number - ((right as any).eval(this.args.ctx) as number); },
    Additive(node) { return (node as any).eval(this.args.ctx); },

    Multiplicative_mul(left, _op, right) { return (left as any).eval(this.args.ctx) as number * ((right as any).eval(this.args.ctx) as number); },
    Multiplicative_div(left, _op, right) { return (left as any).eval(this.args.ctx) as number / ((right as any).eval(this.args.ctx) as number); },
    Multiplicative_mod(left, _op, right) { return (left as any).eval(this.args.ctx) as number % ((right as any).eval(this.args.ctx) as number); },
    Multiplicative(node) { return (node as any).eval(this.args.ctx); },

    UnaryExpr_not(_op, expr) {
      const val = (expr as any).eval(this.args.ctx);
      if (typeof val !== 'boolean') {
        return false;
      }
      return !val;
    },
    UnaryExpr_neg(_op, expr) { return -((expr as any).eval(this.args.ctx) as number); },
    UnaryExpr(node) { return (node as any).eval(this.args.ctx); },

    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const recv = (receiver as any).eval(this.args.ctx);
      const method = methodName.sourceString;
      const argValues = (args as any).asIteration().children.map((a: any) => (a as any).eval(this.args.ctx));

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
      const recv = (receiver as any).eval(this.args.ctx);
      if (recv === null || recv === undefined) return null;
      return safeMemberRead(recv, member.sourceString);
    },

    CallExpr_indexAccess(receiver, _open, index, _close) {
      const recv = (receiver as any).eval(this.args.ctx);
      const idx = (index as any).eval(this.args.ctx);
      if (recv === null || recv === undefined) return null;
      return safeMemberRead(recv, String(idx));
    },

    CallExpr(node) { return (node as any).eval(this.args.ctx); },

    Primary_paren(_open, expr, _close) { return (expr as any).eval(this.args.ctx); },
    Primary(node) { return (node as any).eval(this.args.ctx); },

    Array(_open, elems, _close) {
      return (elems as any).asIteration().children.map((e: any) => (e as any).eval(this.args.ctx));
    },

    literal(node) { return (node as any).eval(this.args.ctx); },

    number_float(_int, _dot, _frac, _exp) { return parseFloat(this.sourceString); },
    number_exp(_digits, _exp) { return parseFloat(this.sourceString); },
    number_int(_digits) { return parseInt(this.sourceString, 10); },
    number(node) { return (node as any).eval(this.args.ctx); },

    string_double(_open, _chars, _close) {
      return JSON.parse(this.sourceString);
    },
    string_single(_open, chars, _close) {
      return processStringEscapes(chars.sourceString);
    },
    string(node) { return (node as any).eval(this.args.ctx); },

    regex(_slash1, body, _slash2, flags) {
      return new RegExp(body.sourceString, flags.sourceString);
    },

    bool_true(_lit) { return true; },
    bool_false(_lit) { return false; },
    bool(node) { return (node as any).eval(this.args.ctx); },

    null(_lit) { return null; },

    ident(_dollar, _start, _rest) {
      const ctx = this.args.ctx as EvalContext;
      const name = this.sourceString;
      if (ctx?.pathVariableBindings && name in ctx.pathVariableBindings) {
        return ctx.pathVariableBindings[name];
      }
      switch (name) {
        case 'auth': return ctx?.auth ?? null;
        case 'data': return ctx?.data;
        case 'newData': return ctx?.newData;
        case 'root': return ctx?.root;
        case 'now': return ctx?.now;
        default: return undefined;
      }
    },
  });
  evalSemantics = semantics;
  return semantics;
}

export function evaluateRtdbExpression(raw: string, ctx: EvalContext): unknown {
  const match = matchRtdbExpression(raw);
  if (match.failed()) {
    throw new Error(match.message ?? 'RTDB expression failed to parse');
  }
  return (getEvalSemantics()(match) as any).eval(ctx);
}
