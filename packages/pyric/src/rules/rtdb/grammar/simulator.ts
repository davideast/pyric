import type { Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RtdbRuleExpression } from '../types.js';
import {
  HAS_CHILDREN_ARGUMENT_COUNT,
  HAS_CHILDREN_ARRAY,
  HAS_CHILDREN_STRINGS,
  argumentCountMessage,
  operandMessage,
  replaceArgumentMessage,
  stringArgumentMessage,
  type TypedOperator,
} from './type-rules.js';

export interface SimulatedAuth {
  uid: string;
  token: Record<string, unknown>;
  /** The sign-in method, which production reads from the token's
   *  `firebase.sign_in_provider` claim. Absent when the token names none. */
  provider?: string;
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

export interface SimulatedQuery {
  orderByChild?: string | null;
  orderByKey?: boolean | null;
  orderByValue?: boolean | null;
  equalTo?: string | number | boolean | null;
  limitToFirst?: number | null;
  limitToLast?: number | null;
  startAt?: string | number | boolean | null;
  endAt?: string | number | boolean | null;
}

export interface EvalContext {
  auth: SimulatedAuth | null;
  data: DataSnapshot;
  newData: DataSnapshot;
  root: DataSnapshot;
  now: number;
  pathVariableBindings: Record<string, string>;
  query?: SimulatedQuery | null;
}

/** Whether `raw` is a JSON object node, as opposed to a leaf or null. */
function isObjectNode(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * A node's value as rules read it through `val()`: a `{ .value, .priority }`
 * node reads as its `.value`, and `.priority` keys are dropped at every
 * level, so a priority never shows up as data (capture rules-rtdb-r20). An
 * object left with no children reads as null.
 */
function exportedValue(raw: unknown): unknown {
  if (!isObjectNode(raw)) return raw ?? null;
  if (Object.hasOwn(raw, '.value')) return exportedValue(raw['.value']);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(raw)) {
    if (key === '.priority') continue;
    const value = exportedValue(child);
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** A node's priority: its `.priority` number or string, else null. */
function priorityOf(raw: unknown): number | string | null {
  if (!isObjectNode(raw)) return null;
  const priority = raw['.priority'];
  const isPriority = typeof priority === 'number' || typeof priority === 'string';
  return isPriority ? priority : null;
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
    return exportedValue(this._value);
  }

  exists(): boolean {
    return this.val() !== null;
  }

  hasChild(path: string): boolean {
    return this.child(path).exists();
  }

  hasChildren(keys?: readonly string[]): boolean {
    // `hasChildren(['a', 'b'])` — true only when EVERY listed key is
    // present (prod semantics). `hasChildren()` — true when the node has
    // at least one child.
    if (keys !== undefined) {
      return keys.every((key) => this.hasChild(key));
    }
    return isObjectNode(this.val());
  }

  isString(): boolean {
    return typeof this.val() === 'string';
  }

  isNumber(): boolean {
    return typeof this.val() === 'number';
  }

  isBoolean(): boolean {
    return typeof this.val() === 'boolean';
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

  getPriority(): number | string | null {
    return priorityOf(this._value);
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
  replace(from: string, to: string): string {
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

/**
 * A failure the production rules engine also raises while it evaluates a rule:
 * a rules method called on a value whose runtime type does not have it, such
 * as `toUpperCase()` on a number or on null. Production fails the whole rule
 * expression on it, with no short-circuit rescue from `||` or `!`, and treats
 * the rule as not granting (captures rules-rtdb-r17 and rules-rtdb-r26).
 *
 * Any other throw from the evaluator, such as a method that is not part of the
 * RTDB rules language, is a construct the simulator does not evaluate and is
 * not this error.
 */
export class RtdbRuleRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RtdbRuleRuntimeError';
  }
}

/** The methods the rules language defines on a data snapshot. */
const SNAPSHOT_METHODS = new Set([
  'val', 'exists', 'hasChild', 'hasChildren', 'isString', 'isNumber',
  'isBoolean', 'child', 'parent', 'getPriority',
]);

/** The methods the rules language defines on a string. */
const STRING_METHODS = new Set([
  'matches', 'contains', 'beginsWith', 'endsWith', 'replace', 'toLowerCase', 'toUpperCase',
]);

/** The one string argument of `method`. Any other value fails the rule: it is never converted to a string. */
function oneStringArgument(method: string, args: readonly unknown[]): string {
  if (args.length !== 1) throw new RtdbRuleRuntimeError(argumentCountMessage(method, 1));
  const [value] = args;
  if (typeof value !== 'string') throw new RtdbRuleRuntimeError(stringArgumentMessage(method));
  return value;
}

/** `hasChildren`'s child names: no argument, or one array of strings. */
function childNamesArgument(args: readonly unknown[]): readonly string[] | undefined {
  if (args.length === 0) return undefined;
  if (args.length > 1) throw new RtdbRuleRuntimeError(HAS_CHILDREN_ARGUMENT_COUNT);
  const [names] = args;
  if (!Array.isArray(names)) throw new RtdbRuleRuntimeError(HAS_CHILDREN_ARRAY);
  if (!names.every((name) => typeof name === 'string')) throw new RtdbRuleRuntimeError(HAS_CHILDREN_STRINGS);
  return names;
}

/** `replace`'s substring and replacement, both strings. */
function replaceArguments(args: readonly unknown[]): [string, string] {
  if (args.length !== 2) throw new RtdbRuleRuntimeError(argumentCountMessage('replace', 2));
  const [from, to] = args;
  if (typeof from !== 'string') throw new RtdbRuleRuntimeError(replaceArgumentMessage(1));
  if (typeof to !== 'string') throw new RtdbRuleRuntimeError(replaceArgumentMessage(2));
  return [from, to];
}

/**
 * Both operands of a typed operator. A snapshot is not a value an operator
 * reads; production refuses to deploy such a rule, and the evaluator fails it.
 */
function evalBinaryPair(operator: TypedOperator, left: any, right: any, ctx: unknown): [any, any] {
  const l = left.eval(ctx);
  if (l instanceof DataSnapshot) throw new RtdbRuleRuntimeError(operandMessage(operator, 'left'));
  const r = right.eval(ctx);
  if (r instanceof DataSnapshot) throw new RtdbRuleRuntimeError(operandMessage(operator, 'right'));
  return [l, r];
}

/** The rules type name of a value that is neither a snapshot nor a string. */
function runtimeTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
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

    Comparison_strictEq(left, _op, right) { const [l, r] = evalBinaryPair('===', left, right, this.args.ctx); return l === r; },
    Comparison_strictNeq(left, _op, right) { const [l, r] = evalBinaryPair('!==', left, right, this.args.ctx); return l !== r; },
    Comparison_gte(left, _op, right) { const [l, r] = evalBinaryPair('>=', left, right, this.args.ctx); return l >= r; },
    Comparison_lte(left, _op, right) { const [l, r] = evalBinaryPair('<=', left, right, this.args.ctx); return l <= r; },
    Comparison_gt(left, _op, right) { const [l, r] = evalBinaryPair('>', left, right, this.args.ctx); return l > r; },
    Comparison_lt(left, _op, right) { const [l, r] = evalBinaryPair('<', left, right, this.args.ctx); return l < r; },
    // RTDB `==` and `!=` do not convert types: the number 5 does not equal the
    // string '5', and the number 1 does not equal true.
    Comparison_looseEq(left, _op, right) { const [l, r] = evalBinaryPair('==', left, right, this.args.ctx); return l === r; },
    Comparison_looseNeq(left, _op, right) { const [l, r] = evalBinaryPair('!=', left, right, this.args.ctx); return l !== r; },
    Comparison(node) { return (node as any).eval(this.args.ctx); },

    Additive_add(left, _op, right) { const [l, r] = evalBinaryPair('+', left, right, this.args.ctx); return (l as number) + (r as number); },
    Additive_sub(left, _op, right) { const [l, r] = evalBinaryPair('-', left, right, this.args.ctx); return (l as number) - (r as number); },
    Additive(node) { return (node as any).eval(this.args.ctx); },

    Multiplicative_mul(left, _op, right) { const [l, r] = evalBinaryPair('*', left, right, this.args.ctx); return (l as number) * (r as number); },
    Multiplicative_div(left, _op, right) { const [l, r] = evalBinaryPair('/', left, right, this.args.ctx); return (l as number) / (r as number); },
    Multiplicative_mod(left, _op, right) { const [l, r] = evalBinaryPair('%', left, right, this.args.ctx); return (l as number) % (r as number); },
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
          case 'hasChild': return recv.hasChild(oneStringArgument(method, argValues));
          case 'hasChildren': return recv.hasChildren(childNamesArgument(argValues));
          case 'isString': return recv.isString();
          case 'isNumber': return recv.isNumber();
          case 'isBoolean': return recv.isBoolean();
          case 'child': return recv.child(oneStringArgument(method, argValues));
          case 'parent': return recv.parent();
          case 'getPriority': return recv.getPriority();
          default: throw new Error(`Unknown DataSnapshot method: ${method}`);
        }
      }

      if (typeof recv === 'string') {
        const str = new RtdbString(recv);
        switch (method) {
          case 'matches': return str.matches(argValues[0] as RegExp | string);
          case 'contains': return str.contains(oneStringArgument(method, argValues));
          case 'beginsWith': return str.beginsWith(oneStringArgument(method, argValues));
          case 'endsWith': return str.endsWith(oneStringArgument(method, argValues));
          case 'replace': return str.replace(...replaceArguments(argValues));
          case 'toLowerCase': return str.toLowerCase();
          case 'toUpperCase': return str.toUpperCase();
          default:
            if (SNAPSHOT_METHODS.has(method)) {
              throw new RtdbRuleRuntimeError(`Method '${method}' is not defined on a string.`);
            }
            throw new Error(`Unknown string method: ${method}`);
        }
      }

      // A rules method called on a value of another runtime type, such as a
      // number from `newData.val()` or null from a missing child. `undefined`
      // comes only from an identifier the evaluator does not bind, which is
      // not a runtime value.
      const isRulesMethod = SNAPSHOT_METHODS.has(method) || STRING_METHODS.has(method);
      if (isRulesMethod && recv !== undefined) {
        throw new RtdbRuleRuntimeError(`Method '${method}' is not defined on ${runtimeTypeName(recv)}.`);
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
        case 'query': return ctx?.query ?? null;
        default: return undefined;
      }
    },
  });
  evalSemantics = semantics;
  return semantics;
}

/** A parsed expression wrapped for the evaluation semantics. */
interface EvaluationTree {
  eval(ctx: EvalContext): unknown;
}

/** The parsed tree of `raw`, wrapped for the evaluation semantics. */
function parseForEvaluation(raw: string): EvaluationTree {
  const matched = matchRtdbExpression(raw);
  if (!matched.ok) throw new Error(matched.message);
  return getEvalSemantics()(matched.match) as unknown as EvaluationTree;
}

/** Evaluates expression text, parsing it on every call. */
export function evaluateRtdbExpression(raw: string, ctx: EvalContext): unknown {
  return parseForEvaluation(raw).eval(ctx);
}

/**
 * Each compiled rule's parsed tree, made on its first evaluation. Keyed by
 * the rule object, so a parse lives exactly as long as the compiled ruleset
 * holding it. The wrapped tree keeps its child wrappers between evaluations,
 * and each evaluation passes its context as an operation argument, so one
 * tree serves every evaluation, nested ones included.
 */
const parsedRules = new WeakMap<RtdbRuleExpression, EvaluationTree>();

/** Evaluates a compiled rule, parsing its text once for the life of the rule. */
export function evaluateRtdbRule(rule: RtdbRuleExpression, ctx: EvalContext): unknown {
  let parsed = parsedRules.get(rule);
  if (parsed === undefined) {
    parsed = parseForEvaluation(rule.raw);
    parsedRules.set(rule, parsed);
  }
  return parsed.eval(ctx);
}
