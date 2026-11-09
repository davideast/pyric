import type { Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RtdbRuleExpression } from '../types.js';
import {
  UNTERMINATED_STRING_LITERAL,
  isUnterminatedRtdbStringLiteral,
  unescapeRtdbStringLiteral,
} from './string-literal.js';
import {
  HAS_CHILDREN_ARGUMENT_COUNT,
  MATCHES_REGEX_LITERAL,
  REGEX_FLAGS,
  isSupportedRegexFlags,
  HAS_CHILDREN_ARRAY,
  HAS_CHILDREN_STRINGS,
  argumentCountMessage,
  operandMessage,
  replaceArgumentMessage,
  stringArgumentMessage,
  type TypedOperator,
} from './type-rules.js';
import { RtdbRegex, compileRtdbRegex } from './regex.js';
import { DataSnapshot, RtdbRuleRuntimeError } from './data-snapshot.js';

export { DataSnapshot, RtdbRuleRuntimeError } from './data-snapshot.js';

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

export interface SimulatedQuery {
  orderByChild?: string | null;
  orderByKey?: boolean | null;
  orderByValue?: boolean | null;
  orderByPriority?: boolean | null;
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

class RtdbString {
  constructor(private value: string) {}

  matches(pattern: RtdbRegex): boolean {
    return pattern.test(this.value);
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

/** `matches`'s one argument, a regular expression literal. */
function regexArgument(args: readonly unknown[]): RtdbRegex {
  if (args.length !== 1) throw new RtdbRuleRuntimeError(argumentCountMessage('matches', 1));
  const [pattern] = args;
  if (!(pattern instanceof RtdbRegex)) throw new RtdbRuleRuntimeError(MATCHES_REGEX_LITERAL);
  return pattern;
}

/** `replace`'s substring and replacement, both strings. */
function replaceArguments(args: readonly unknown[]): [string, string] {
  if (args.length !== 2) throw new RtdbRuleRuntimeError(argumentCountMessage('replace', 2));
  const [from, to] = args;
  if (typeof from !== 'string') throw new RtdbRuleRuntimeError(replaceArgumentMessage(1));
  if (typeof to !== 'string') throw new RtdbRuleRuntimeError(replaceArgumentMessage(2));
  return [from, to];
}

/** The operators that compare for equality, which read null like any other value. */
const EQUALITY_OPERATORS = new Set<TypedOperator>(['==', '===', '!=', '!==']);
const ARITHMETIC_NUMBER_OPERATORS = new Set<TypedOperator>(['-', '*', '/', '%']);
const ORDERING_OPERATORS = new Set<TypedOperator>(['<', '<=', '>', '>=']);

/** Whether `value` fails an operator that takes it as an operand. */
function isInvalidOperand(operator: TypedOperator, value: unknown): boolean {
  if (value instanceof DataSnapshot || typeof value === 'function') return true;
  if (EQUALITY_OPERATORS.has(operator)) return false;
  if (ARITHMETIC_NUMBER_OPERATORS.has(operator)) return typeof value !== 'number';
  return typeof value !== 'number' && typeof value !== 'string';
}

/**
 * Both operands of a typed operator. A snapshot is not a value an operator
 * reads; production refuses to deploy such a rule, and the evaluator fails it.
 * Null, booleans, strings, and objects fail arithmetic or ordering operators
 * whose operand types do not include them, `|| true` included (captures
 * r27-stdlib-core-patterns, r33-null-operands, r36-runtime-arithmetic-types,
 * and r37-runtime-comparison-and-length-types); `==` and `!=` compare values
 * without type conversion.
 */
function evalBinaryPair(operator: TypedOperator, left: any, right: any, ctx: unknown): [any, any] {
  const l = left.eval(ctx);
  if (isInvalidOperand(operator, l)) throw new RtdbRuleRuntimeError(operandMessage(operator, 'left'));
  const r = right.eval(ctx);
  if (isInvalidOperand(operator, r) || (ORDERING_OPERATORS.has(operator) && typeof l !== typeof r)) {
    throw new RtdbRuleRuntimeError(operandMessage(operator, 'right'));
  }
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
      const c = (cond as any).eval(this.args.ctx);
      if (typeof c !== 'boolean') throw new RtdbRuleRuntimeError('condition of ? must be boolean.');
      return c ? (then as any).eval(this.args.ctx) : (els as any).eval(this.args.ctx);
    },
    Ternary(node) { return (node as any).eval(this.args.ctx); },

    // A chain matches flat (`first`, then each term of `rest`) and is folded
    // in a loop: left to right, stopping at the first deciding term, exactly
    // as the left-nested pairs `((a || b) || c)` evaluate.
    LogicalOr_or(first, _ops, rest) {
      const l = (first as any).eval(this.args.ctx);
      if (typeof l !== 'boolean') throw new RtdbRuleRuntimeError('Left operand of || must be boolean.');
      if (l) return true;
      for (const term of rest.children) {
        const r = (term as any).eval(this.args.ctx);
        if (typeof r !== 'boolean') throw new RtdbRuleRuntimeError('Right operand of || must be boolean.');
        if (r) return true;
      }
      return false;
    },
    LogicalOr(node) { return (node as any).eval(this.args.ctx); },

    LogicalAnd_and(first, _ops, rest) {
      const l = (first as any).eval(this.args.ctx);
      if (typeof l !== 'boolean') throw new RtdbRuleRuntimeError('Left operand of && must be boolean.');
      if (!l) return false;
      for (const term of rest.children) {
        const r = (term as any).eval(this.args.ctx);
        if (typeof r !== 'boolean') throw new RtdbRuleRuntimeError('Right operand of && must be boolean.');
        if (!r) return false;
      }
      return true;
    },
    LogicalAnd(node) { return (node as any).eval(this.args.ctx); },

    Equality_strictEq(left, _op, right) { const [l, r] = evalBinaryPair('===', left, right, this.args.ctx); return l === r; },
    Equality_strictNeq(left, _op, right) { const [l, r] = evalBinaryPair('!==', left, right, this.args.ctx); return l !== r; },
    // RTDB `==` and `!=` do not convert types: the number 5 does not equal the
    // string '5', and the number 1 does not equal true.
    Equality_looseEq(left, _op, right) { const [l, r] = evalBinaryPair('==', left, right, this.args.ctx); return l === r; },
    Equality_looseNeq(left, _op, right) { const [l, r] = evalBinaryPair('!=', left, right, this.args.ctx); return l !== r; },
    Equality(node) { return (node as any).eval(this.args.ctx); },

    Comparison_gte(left, _op, right) { const [l, r] = evalBinaryPair('>=', left, right, this.args.ctx); return l >= r; },
    Comparison_lte(left, _op, right) { const [l, r] = evalBinaryPair('<=', left, right, this.args.ctx); return l <= r; },
    Comparison_gt(left, _op, right) { const [l, r] = evalBinaryPair('>', left, right, this.args.ctx); return l > r; },
    Comparison_lt(left, _op, right) { const [l, r] = evalBinaryPair('<', left, right, this.args.ctx); return l < r; },
    Comparison(node) { return (node as any).eval(this.args.ctx); },

    Additive_add(left, _op, right) { const [l, r] = evalBinaryPair('+', left, right, this.args.ctx); return (l as number) + (r as number); },
    Additive_sub(left, _op, right) { const [l, r] = evalBinaryPair('-', left, right, this.args.ctx); return (l as number) - (r as number); },
    Additive(node) { return (node as any).eval(this.args.ctx); },

    Multiplicative_mul(left, _op, right) { const [l, r] = evalBinaryPair('*', left, right, this.args.ctx); return (l as number) * (r as number); },
    Multiplicative_div(left, _op, right) {
      const [l, r] = evalBinaryPair('/', left, right, this.args.ctx);
      return (r as number) === 0 ? Number.NaN : (l as number) / (r as number);
    },
    Multiplicative_mod(left, _op, right) { const [l, r] = evalBinaryPair('%', left, right, this.args.ctx); return (l as number) % (r as number); },
    Multiplicative(node) { return (node as any).eval(this.args.ctx); },

    UnaryExpr_not(_op, expr) {
      const val = (expr as any).eval(this.args.ctx);
      return typeof val === 'boolean' ? !val : false;
    },
    UnaryExpr_neg(_op, expr) {
      const value = (expr as any).eval(this.args.ctx);
      if (typeof value !== 'number') throw new RtdbRuleRuntimeError('Invalid unary - expression: operand is not a number.');
      return -value;
    },
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
          case 'matches': return str.matches(regexArgument(argValues));
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
      const prop = member.sourceString;
      if (prop === 'length') {
        if (typeof recv === 'string') return recv.length;
        throw new RtdbRuleRuntimeError("No such method/property 'length'.");
      }
      if (recv === null || recv === undefined) return null;
      return safeMemberRead(recv, prop);
    },

    CallExpr_indexAccess(receiver, _open, index, _close) {
      const recv = (receiver as any).eval(this.args.ctx);
      const idx = (index as any).eval(this.args.ctx);
      if (typeof idx !== 'string' && typeof idx !== 'number') throw new RtdbRuleRuntimeError('Invalid property access.');
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
      if (isUnterminatedRtdbStringLiteral(this.sourceString)) {
        throw new SyntaxError(UNTERMINATED_STRING_LITERAL);
      }
      return unescapeRtdbStringLiteral(this.sourceString);
    },
    string_single(_open, _chars, _close) {
      if (isUnterminatedRtdbStringLiteral(this.sourceString)) {
        throw new SyntaxError(UNTERMINATED_STRING_LITERAL);
      }
      return unescapeRtdbStringLiteral(this.sourceString);
    },
    string(node) { return (node as any).eval(this.args.ctx); },

    regex(_slash1, body, _slash2, flags) {
      if (!isSupportedRegexFlags(flags.sourceString)) throw new RtdbRuleRuntimeError(REGEX_FLAGS);
      return compileRtdbRegex(body.sourceString, flags.sourceString);
    },

    bool_true(_lit) { return true; },
    bool_false(_lit) { return false; },
    bool(node) { return (node as any).eval(this.args.ctx); },

    null(_lit) { return null; },

    ident(_dollar, _start, _rest) {
      const ctx = this.args.ctx as EvalContext;
      const name = this.sourceString;
      // Only a `$` name reads a path variable, so a `$data` wildcard never
      // shadows the built-in `data` snapshot.
      if (_dollar.sourceString === '$') {
        const bindings = ctx?.pathVariableBindings;
        if (bindings !== undefined) {
          if (name in bindings) return bindings[name];
          if (name.slice(1) in bindings) return bindings[name.slice(1)];
        }
        return undefined;
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
