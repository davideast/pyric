// Unified RTDB lowering target for pure policy functions and transitions.
// Unifies numeric predicates, exact safe-integer increments, and general
// numeric/boolean/string/null comparisons over data/newData snapshots.
// Uses Kleene dual-polarity local guards and safe-int arithmetic bounds to
// preserve CEL short-circuiting and prevent fail-open negation or overflow drift.
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { parseRtdbExpressionTree, type RtdbExpressionTree } from '../rtdb/grammar/expression-tree.js';
import { validateExpression as validateRtdbExpression } from '../rtdb/grammar/validator.js';
import { field } from './firestore.js';

export interface RtdbSnapshotBinding {
  snapshot: 'data' | 'newData';
  parent?: boolean;
  path?: string;
  type?: 'number' | 'string' | 'boolean' | 'any';
}

export type RtdbBinding = 'data' | 'newData' | RtdbSnapshotBinding;
export type RtdbBindings = Readonly<Record<string, RtdbBinding>>;

export interface LowerRtdbOptions {
  /** Default leaf type for snapshot reads lacking explicit type constraints. */
  defaultLeafType?: 'number' | 'any';
  /** Reject `before.*` bound to `newData` or `after.*` bound to `data`. */
  checkTiming?: boolean;
  /** Maximum emitted predicate length in characters. */
  maxLength?: number;
}

export interface LowerRtdbResult {
  inputs: string[];
  features: string[];
  problems: string[];
  predicate?: string;
}

type ValueKind = 'number' | 'string' | 'boolean' | 'null' | 'unknown';
type Polarity = 'pos' | 'neg';

interface RtdbTerm {
  readonly text: string;
  readonly kind: ValueKind;
  readonly guards: readonly string[];
  readonly snapshotNode?: string;
  readonly isRootBinding?: boolean;
  readonly typedLeaf?: boolean;
  readonly pureWhenGuarded?: boolean;
  readonly numVal?: number;
  readonly arith?: { readonly op: '+' | '-' | '*' | '?:'; readonly a: RtdbTerm; readonly b: RtdbTerm; readonly cond?: string };
}

interface LetEntry {
  readonly expr: Expression;
  readonly env: ReadonlyMap<string, LetEntry>;
}

const KEY_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_MAX_LENGTH = 16384;
const SAFE_INT_MAX = 9007199254740991;
const SAFE_INT_MIN = -9007199254740991;
const INLINE_BOUND_MAX_CHARS = 80;

function normalizeBinding(binding: RtdbBinding): RtdbSnapshotBinding | undefined {
  if (binding === 'data' || binding === 'newData') return { snapshot: binding };
  if (!binding || typeof binding !== 'object') return undefined;
  if (binding.snapshot !== 'data' && binding.snapshot !== 'newData') return undefined;
  if (binding.parent !== undefined && typeof binding.parent !== 'boolean') return undefined;
  if (binding.path !== undefined) {
    if (typeof binding.path !== 'string' || !binding.path.length) return undefined;
    if (!binding.path.split('/').every((part) => KEY_SEGMENT.test(part))) return undefined;
  }
  if (binding.type !== undefined && !['number', 'string', 'boolean', 'any'].includes(binding.type)) {
    return undefined;
  }
  return binding;
}

function mergeGuards(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) for (const guard of list) if (!seen.has(guard)) { seen.add(guard); out.push(guard); }
  return out;
}
function guardPrefix(guards: readonly string[]): string {
  return guards.length === 1 ? guards[0]! : '(' + guards.join(' && ') + ')';
}
function withGuards(term: RtdbTerm): string {
  return term.guards.length ? '(' + [...term.guards, term.text].join(' && ') + ')' : term.text;
}
function safeStringLiteral(value: string): string | undefined {
  return /[\r\n\u2028\u2029]/.test(value) ? undefined : JSON.stringify(value);
}
function integerCheck(nodeExpr: string, min = SAFE_INT_MIN, max = SAFE_INT_MAX): string {
  return `(${nodeExpr}.isNumber() && ${nodeExpr}.val() >= ${min} && ${nodeExpr}.val() <= ${max} && ${nodeExpr}.val() % 1 == 0)`;
}
function scalarGuard(nodeExpr: string): string {
  return `(${nodeExpr}.isNumber() || ${nodeExpr}.isString() || ${nodeExpr}.isBoolean())`;
}
function flip(pol: Polarity): Polarity { return pol === 'pos' ? 'neg' : 'pos'; }
function negateCmp(op: '<' | '<=' | '>' | '>='): '<' | '<=' | '>' | '>=' {
  return op === '<' ? '>=' : op === '<=' ? '>' : op === '>' ? '<=' : '<';
}

function nonZeroConstantNumber(expr: Expression): number | undefined {
  if (expr.type === 'literal' && typeof expr.value === 'number' && Number.isFinite(expr.value) && expr.value !== 0) {
    return expr.value;
  }
  if (expr.type === 'unaryOp' && expr.op === '-') {
    const inner = nonZeroConstantNumber(expr.operand);
    return inner !== undefined ? -inner : undefined;
  }
  return undefined;
}

function isDefinitelyBoolean(expr: Expression, letEnv: ReadonlyMap<string, LetEntry>): boolean {
  if (expr.type === 'literal') return typeof expr.value === 'boolean';
  if (expr.type === 'unaryOp') return expr.op === '!';
  if (expr.type === 'isExpr') return true;
  if (expr.type === 'binaryOp') {
    return ['&&', '||', '==', '!=', '<', '<=', '>', '>='].includes(expr.op);
  }
  if (expr.type === 'ternary') {
    return isDefinitelyBoolean(expr.consequent, letEnv) && isDefinitelyBoolean(expr.alternate, letEnv);
  }
  if (expr.type === 'identifier') {
    const entry = letEnv.get(expr.name);
    return entry ? isDefinitelyBoolean(entry.expr, entry.env) : false;
  }
  return false;
}

function inferLiteralKind(expr: Expression): 'number' | 'string' | 'boolean' | undefined {
  if (expr.type === 'literal') {
    if (typeof expr.value === 'number') return 'number';
    if (typeof expr.value === 'string') return 'string';
    if (typeof expr.value === 'boolean') return 'boolean';
  }
  if (expr.type === 'unaryOp' && expr.op === '-') return 'number';
  if (expr.type === 'binaryOp' && (expr.op === '-' || expr.op === '*' || expr.op === '%')) return 'number';
  return undefined;
}

// Bound a numeric term within [-limit, limit]: recurse on depth>=2 arithmetic trees so
// intermediate subexpressions can never overflow and large trees are never duplicated.
function boundTerm(term: RtdbTerm, limit: number): string[] {
  if (term.numVal !== undefined) return Math.abs(term.numVal) <= limit ? [] : ['false'];
  if (!term.arith) return [`(${term.text} >= ${-limit} && ${term.text} <= ${limit})`];
  if (term.arith.op === '?:') {
    const yb = boundTerm(term.arith.a, limit);
    const nb = boundTerm(term.arith.b, limit);
    if (!yb.length && !nb.length) return [];
    if (sameGuards(yb, nb)) return yb;
    const y = yb.length ? guardPrefix(yb) : 'true';
    const n = nb.length ? guardPrefix(nb) : 'true';
    return [`(${term.arith.cond!} ? ${y} : ${n})`];
  }
  const hasNested = Boolean(term.arith.a.arith || term.arith.b.arith);
  if (!hasNested && term.text.length <= INLINE_BOUND_MAX_CHARS) {
    return [`(${term.text} >= ${-limit} && ${term.text} <= ${limit})`];
  }
  const childLimit = term.arith.op === '*' ? Math.floor(Math.sqrt(limit)) : Math.floor(limit / 2);
  if (childLimit < 1) return [`(${term.text} >= ${-limit} && ${term.text} <= ${limit})`];
  return mergeGuards(boundTerm(term.arith.a, childLimit), boundTerm(term.arith.b, childLimit));
}

function arithGuards(term: RtdbTerm): string[] {
  return term.kind === 'number' && term.arith ? boundTerm(term, SAFE_INT_MAX) : [];
}

function sameGuards(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

export function lowerRtdbExpression(
  expr: Expression,
  bindings: RtdbBindings,
  options: LowerRtdbOptions = {},
  lets: readonly { name: string; value: Expression }[] = [],
): LowerRtdbResult {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const defaultLeafType = options.defaultLeafType ?? 'any';
  const checkTiming = options.checkTiming ?? false;
  const normalized = new Map<string, RtdbSnapshotBinding>();
  const problems = new Set<string>();
  const inputs = new Set<string>();
  const features = new Set<string>();
  for (const [key, raw] of Object.entries(bindings)) {
    const parsed = normalizeBinding(raw);
    if (!parsed) problems.add('Invalid RTDB snapshot binding for ' + key);
    else normalized.set(key, parsed);
  }
  function checkLength(text: string): string {
    if (text.length > maxLength) throw new Error('RTDB predicate exceeds emission limit');
    return text;
  }
  function makeTerm(
    text: string,
    kind: ValueKind,
    guards: readonly string[] = [],
    extra?: Omit<RtdbTerm, 'text' | 'kind' | 'guards'>,
  ): RtdbTerm {
    let total = checkLength(text).length;
    for (const g of guards) total += g.length + 4;
    if (total > maxLength) throw new Error('RTDB predicate exceeds emission limit');
    return { text, kind, guards, ...extra };
  }
  function resolveSnapshot(path: string): RtdbTerm | undefined {
    const exact = normalized.get(path);
    let binding = exact;
    let remaining: string[] = [];
    const isRootBinding = Boolean(exact) && !path.includes('.');
    if (!exact) {
      const parts = path.split('.');
      for (let i = parts.length - 1; i >= 1; i--) {
        const found = normalized.get(parts.slice(0, i).join('.'));
        if (found) { binding = found; remaining = parts.slice(i); break; }
      }
    }
    if (!binding) { problems.add('Missing binding: ' + path); return undefined; }
    if (checkTiming) {
      const root = path.split('.')[0];
      if ((root === 'before' && binding.snapshot !== 'data') || (root === 'after' && binding.snapshot !== 'newData')) {
        problems.add('Wrong snapshot: ' + path + ' bound to ' + binding.snapshot);
        return undefined;
      }
    }
    if (!remaining.every((k) => KEY_SEGMENT.test(k))) { problems.add('Unsupported RTDB field ' + path); return undefined; }
    const childPath = [binding.path, ...remaining].filter(Boolean).join('/');
    const nodeExpr = binding.snapshot + (binding.parent ? '.parent()' : '') + (childPath ? '.child(' + JSON.stringify(childPath) + ')' : '');
    const hint = binding.type ?? defaultLeafType;
    if (hint === 'number' || hint === 'string' || hint === 'boolean') {
      const method = hint === 'number' ? '.isNumber()' : hint === 'string' ? '.isString()' : '.isBoolean()';
      const text = hint === 'boolean' ? '(' + nodeExpr + '.val() == true)' : nodeExpr + '.val()';
      return makeTerm(text, hint, [nodeExpr + method], { snapshotNode: nodeExpr, isRootBinding, typedLeaf: true, pureWhenGuarded: true });
    }
    return makeTerm(nodeExpr + '.val()', 'unknown', [], { snapshotNode: nodeExpr, isRootBinding, typedLeaf: false });
  }

  function narrow(term: RtdbTerm, kind: 'number' | 'string' | 'boolean'): RtdbTerm | undefined {
    if (term.kind === kind) return term;
    if (term.kind === 'unknown' && term.snapshotNode) {
      const check = kind === 'number' ? '.isNumber()' : kind === 'string' ? '.isString()' : '.isBoolean()';
      const text = kind === 'boolean' ? '(' + term.snapshotNode + '.val() == true)' : term.snapshotNode + '.val()';
      return makeTerm(text, kind, mergeGuards(term.guards, [term.snapshotNode + check]), {
        snapshotNode: term.snapshotNode, isRootBinding: term.isRootBinding, typedLeaf: true, pureWhenGuarded: true,
      });
    }
    return undefined;
  }

  const rootEnv = new Map<string, LetEntry>();
  const boolCache = new Map<LetEntry, Partial<Record<Polarity, RtdbTerm>>>();

  function emitUntypedScalarEq(snap: RtdbTerm, scalar: RtdbTerm, effectivePol: Polarity, snapOnLeft: boolean): RtdbTerm {
    if (effectivePol === 'pos') {
      const typed = narrow(snap, scalar.kind as 'number' | 'string' | 'boolean')!;
      const text = snapOnLeft ? `(${typed.text} == ${scalar.text})` : `(${scalar.text} == ${typed.text})`;
      return makeTerm(text, 'boolean', mergeGuards(typed.guards, scalar.guards), { pureWhenGuarded: true });
    }
    const existGuard = snap.isRootBinding ? [] : [snap.snapshotNode + '.exists()'];
    const snapVal = snap.snapshotNode + '.val()';
    const text = snapOnLeft ? `(${snapVal} != ${scalar.text})` : `(${scalar.text} != ${snapVal})`;
    return makeTerm(text, 'boolean', mergeGuards(existGuard, scalar.guards), { pureWhenGuarded: true });
  }

  function emitValue(
    node: Expression,
    expectedKind?: 'number' | 'string' | 'boolean',
    env: ReadonlyMap<string, LetEntry> = rootEnv,
  ): RtdbTerm {
    const path = field(node);
    if (path) {
      const local = env.get(path);
      if (local) return emitValue(local.expr, expectedKind, local.env);
      inputs.add(path);
      const resolved = resolveSnapshot(path);
      if (!resolved) throw new Error('Unbound RTDB field ' + path);
      return expectedKind ? (narrow(resolved, expectedKind) ?? resolved) : resolved;
    }
    if (node.type === 'literal') {
      if (typeof node.value === 'boolean') return makeTerm(String(node.value), 'boolean', [], { pureWhenGuarded: true });
      if (node.value === null) return makeTerm('null', 'null');
      if (typeof node.value === 'number') {
        if (!Number.isFinite(node.value) || Object.is(node.value, -0) || Math.abs(node.value) > SAFE_INT_MAX) {
          throw new Error('Unsupported RTDB numeric literal: ' + node.raw);
        }
        return makeTerm(String(node.value), 'number', [], { numVal: node.value });
      }
      if (typeof node.value === 'string') {
        const encoded = safeStringLiteral(node.value);
        if (!encoded) throw new Error('Unsupported RTDB string literal');
        return makeTerm(encoded, 'string');
      }
      throw new Error('Unsupported RTDB literal');
    }
    if (node.type === 'unaryOp') {
      features.add(node.op);
      if (node.op === '-') {
        const inner = narrow(emitValue(node.operand, 'number', env), 'number');
        if (!inner) throw new Error('Unsupported RTDB unary - operand');
        return makeTerm('(-' + inner.text + ')', 'number', inner.guards, {
          numVal: inner.numVal !== undefined ? -inner.numVal : undefined,
          arith: inner.arith,
        });
      }
      if (node.op === '!') return emitBool(node, 'pos', env);
    }
    if (node.type === 'methodCall') {
      if (node.method === 'size' && node.args.length === 0) {
        const recv = narrow(emitValue(node.object, 'string', env), 'string');
        if (!recv) throw new Error('RTDB .size() requires a string receiver');
        features.add('string.length');
        return makeTerm('(' + recv.text + '.length)', 'number', recv.guards);
      }
      throw new Error('Unsupported RTDB method call: ' + node.method);
    }
    if (node.type === 'binaryOp') {
      features.add(node.op);
      if (['&&', '||', '==', '!=', '<', '<=', '>', '>='].includes(node.op)) {
        return emitBool(node, 'pos', env);
      }
      if (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '%') {
        const hintKind = node.op === '+'
          ? (expectedKind ?? inferLiteralKind(node.left) ?? inferLiteralKind(node.right))
          : 'number';
        const rawLeft = emitValue(node.left, hintKind, env);
        const rawRight = emitValue(node.right, hintKind, env);
        if (node.op === '+' && (rawLeft.kind === 'string' || rawRight.kind === 'string')) {
          const l = narrow(rawLeft, 'string') ?? narrow(emitValue(node.left, 'string', env), 'string');
          const r = narrow(rawRight, 'string') ?? narrow(emitValue(node.right, 'string', env), 'string');
          if (!l || !r) throw new Error('RTDB + cannot mix string and non-string');
          return makeTerm('(' + l.text + ' + ' + r.text + ')', 'string', mergeGuards(l.guards, r.guards));
        }
        const l = narrow(rawLeft, 'number') ?? narrow(emitValue(node.left, 'number', env), 'number');
        const r = narrow(rawRight, 'number') ?? narrow(emitValue(node.right, 'number', env), 'number');
        if (!l || !r) throw new Error('Unsupported RTDB arithmetic operands for ' + node.op);
        if (node.op === '%') {
          if (nonZeroConstantNumber(node.right) === undefined) {
            throw new Error('RTDB % requires a non-zero constant divisor');
          }
          return makeTerm('(' + l.text + ' % ' + r.text + ')', 'number', mergeGuards(l.guards, r.guards, arithGuards(l)));
        }
        const exprText = '(' + l.text + ' ' + node.op + ' ' + r.text + ')';
        const arith = { op: node.op, a: l, b: r } as const;
        const rawNumVal = l.numVal !== undefined && r.numVal !== undefined
          ? (node.op === '+' ? l.numVal + r.numVal : node.op === '-' ? l.numVal - r.numVal : l.numVal * r.numVal)
          : undefined;
        return makeTerm(exprText, 'number', mergeGuards(l.guards, r.guards), { arith, numVal: rawNumVal });
      }
      throw new Error('Unsupported RTDB binary operator: ' + node.op);
    }
    if (node.type === 'isExpr') return emitBool(node, 'pos', env);
    if (node.type === 'ternary') {
      features.add('conditional');
      const condPos = emitBool(node.condition, 'pos', env);
      const condNeg = emitBool(node.condition, 'neg', env);
      let yes = emitValue(node.consequent, expectedKind, env);
      let no = emitValue(node.alternate, expectedKind, env);
      if (yes.kind === 'boolean' && no.kind === 'boolean') return emitBool(node, 'pos', env);
      if (yes.kind === 'unknown' && (no.kind === 'number' || no.kind === 'string')) {
        yes = emitValue(node.consequent, no.kind, env);
      } else if (no.kind === 'unknown' && (yes.kind === 'number' || yes.kind === 'string')) {
        no = emitValue(node.alternate, yes.kind, env);
      }
      if (yes.kind !== no.kind || (yes.kind !== 'number' && yes.kind !== 'string')) {
        throw new Error('Unsupported RTDB ternary value types');
      }
      const pureCond = Boolean(condPos.pureWhenGuarded && condNeg.pureWhenGuarded && sameGuards(condPos.guards, condNeg.guards));
      const condTest = pureCond ? condPos.text : withGuards(condPos);
      const condGuards = pureCond ? condPos.guards : ['(' + condTest + ' || ' + withGuards(condNeg) + ')'];
      const branchGuard = sameGuards(yes.guards, no.guards)
        ? yes.guards
        : ['(' + condTest + ' ? ' + (yes.guards.length ? guardPrefix(yes.guards) : 'true') + ' : ' + (no.guards.length ? guardPrefix(no.guards) : 'true') + ')'];
      return makeTerm(
        '(' + condTest + ' ? ' + yes.text + ' : ' + no.text + ')',
        yes.kind,
        mergeGuards(condGuards, branchGuard),
        yes.kind === 'number' ? { arith: { op: '?:', a: yes, b: no, cond: condTest } } : undefined,
      );
    }
    throw new Error('Unsupported RTDB expression: ' + node.type);
  }

  function emitBool(node: Expression, pol: Polarity, env: ReadonlyMap<string, LetEntry> = rootEnv): RtdbTerm {
    if (node.type === 'identifier') {
      const local = env.get(node.name);
      if (local) {
        let cached = boolCache.get(local);
        if (!cached) { cached = {}; boolCache.set(local, cached); }
        if (!cached[pol]) cached[pol] = emitBool(local.expr, pol, local.env);
        return cached[pol]!;
      }
    }
    if (node.type === 'literal' && typeof node.value === 'boolean') {
      return makeTerm(String(pol === 'pos' ? node.value : !node.value), 'boolean', [], { pureWhenGuarded: true });
    }
    if (node.type === 'unaryOp' && node.op === '!') {
      features.add('!');
      return emitBool(node.operand, flip(pol), env);
    }
    if (node.type === 'binaryOp' && (node.op === '&&' || node.op === '||')) {
      features.add(node.op);
      const emitAnd = (node.op === '&&' && pol === 'pos') || (node.op === '||' && pol === 'neg');
      const l = withGuards(emitBool(node.left, pol, env));
      const r = withGuards(emitBool(node.right, pol, env));
      return makeTerm('(' + l + (emitAnd ? ' && ' : ' || ') + r + ')', 'boolean');
    }
    if (node.type === 'ternary') {
      features.add('conditional');
      const cPos = withGuards(emitBool(node.condition, 'pos', env));
      const cNeg = withGuards(emitBool(node.condition, 'neg', env));
      const tRes = withGuards(emitBool(node.consequent, pol, env));
      const fRes = withGuards(emitBool(node.alternate, pol, env));
      return makeTerm('(' + cPos + ' ? ' + tRes + ' : (' + cNeg + ' && ' + fRes + '))', 'boolean');
    }
    if (node.type === 'isExpr') {
      features.add('is ' + node.typeName);
      const inner = emitValue(node.value, undefined, env);
      if (inner.snapshotNode) {
        const n = inner.snapshotNode;
        if (node.typeName === 'int' || node.typeName === 'number' || node.typeName === 'string' || node.typeName === 'bool') {
          const pred = node.typeName === 'int' ? integerCheck(n)
            : n + (node.typeName === 'number' ? '.isNumber()' : node.typeName === 'string' ? '.isString()' : '.isBoolean()');
          if (pol === 'pos') return makeTerm(pred, 'boolean');
          if (!inner.isRootBinding) throw new Error('Negated is ' + node.typeName + ' on child snapshot is unsound for missing vs null');
          return makeTerm('(!' + pred + ')', 'boolean');
        }
        if (node.typeName === 'null') {
          if (!inner.isRootBinding) throw new Error('is null on child snapshot cannot distinguish missing key from null');
          return makeTerm(pol === 'pos' ? '(!' + n + '.exists())' : n + '.exists()', 'boolean');
        }
        throw new Error('Unsupported RTDB type test: is ' + node.typeName);
      }
      const mapped = node.typeName === 'bool' ? 'boolean' : node.typeName;
      if (inner.kind === mapped && mapped === 'boolean') {
        if (node.value.type === 'literal') return makeTerm(String(pol === 'pos'), 'boolean', [], { pureWhenGuarded: true });
        if (pol === 'neg') return makeTerm('false', 'boolean');
        return makeTerm(`(${withGuards(emitBool(node.value, 'pos', env))} || ${withGuards(emitBool(node.value, 'neg', env))})`, 'boolean');
      }
      if (inner.kind === mapped && (mapped === 'number' || mapped === 'string')) {
        return makeTerm(String(pol === 'pos'), 'boolean', mergeGuards(inner.guards, arithGuards(inner)), { pureWhenGuarded: true });
      }
      throw new Error('Unsupported RTDB type test: is ' + node.typeName);
    }
    if (node.type === 'binaryOp' && (node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=')) {
      features.add(node.op);
      const op = pol === 'pos' ? node.op : negateCmp(node.op);
      const hint = inferLiteralKind(node.left) ?? inferLiteralKind(node.right);
      const rawL = emitValue(node.left, hint === 'string' || hint === 'number' ? hint : undefined, env);
      const rawR = emitValue(node.right, hint === 'string' || hint === 'number' ? hint : undefined, env);
      if (rawL.kind === 'unknown' && rawR.kind === 'unknown' && rawL.snapshotNode && rawR.snapshotNode) {
        const a = rawL.snapshotNode;
        const b = rawR.snapshotNode;
        return makeTerm(
          `((${a}.isNumber() && ${b}.isNumber() && (${a}.val() ${op} ${b}.val())) || (${a}.isString() && ${b}.isString() && (${a}.val() ${op} ${b}.val())))`,
          'boolean',
        );
      }
      const targetKind = rawL.kind === 'string' || rawR.kind === 'string' ? 'string' : 'number';
      const l = narrow(rawL, targetKind);
      const r = narrow(rawR, targetKind);
      if (!l || !r) throw new Error('Unsupported RTDB ordering operands for ' + node.op);
      return makeTerm('(' + l.text + ' ' + op + ' ' + r.text + ')', 'boolean', mergeGuards(l.guards, r.guards, arithGuards(l), arithGuards(r)), { pureWhenGuarded: true });
    }
    if (node.type === 'binaryOp' && (node.op === '==' || node.op === '!=')) {
      features.add(node.op);
      const effectivePol = node.op === '==' ? pol : flip(pol);
      const leftBool = isDefinitelyBoolean(node.left, env);
      const rightBool = isDefinitelyBoolean(node.right, env);
      const boolPair = (a: Expression, b: Expression) => {
        const lp = withGuards(emitBool(a, 'pos', env)), ln = withGuards(emitBool(a, 'neg', env));
        const rp = withGuards(emitBool(b, 'pos', env)), rn = withGuards(emitBool(b, 'neg', env));
        return makeTerm(effectivePol === 'pos' ? `((${lp} && ${rp}) || (${ln} && ${rn}))` : `((${lp} && ${rn}) || (${ln} && ${rp}))`, 'boolean');
      };
      const boolSnap = (bNode: Expression, other: RtdbTerm) => {
        const bp = withGuards(emitBool(bNode, 'pos', env)), bn = withGuards(emitBool(bNode, 'neg', env));
        const n = other.snapshotNode!, strict = other.kind === 'boolean' || effectivePol === 'pos';
        const exist = other.isRootBinding ? '' : `${n}.exists() && `;
        const onTrue = strict ? `(${n}.isBoolean() && (${n}.val() == ${effectivePol === 'pos' ? 'true' : 'false'}))` : `(${exist}(${n}.val() != true))`;
        const onFalse = strict ? `(${n}.isBoolean() && (${n}.val() == ${effectivePol === 'pos' ? 'false' : 'true'}))` : `(${exist}(${n}.val() != false))`;
        return makeTerm(`((${bp} && ${onTrue}) || (${bn} && ${onFalse}))`, 'boolean');
      };
      if (leftBool && rightBool) {
        if (node.right.type === 'literal' && typeof node.right.value === 'boolean') return emitBool(node.left, node.right.value ? effectivePol : flip(effectivePol), env);
        if (node.left.type === 'literal' && typeof node.left.value === 'boolean') return emitBool(node.right, node.left.value ? effectivePol : flip(effectivePol), env);
        return boolPair(node.left, node.right);
      }
      const rawL = leftBool ? undefined : emitValue(node.left, undefined, env);
      const rawR = rightBool ? undefined : emitValue(node.right, undefined, env);
      if (leftBool || rightBool) {
        const other = leftBool ? rawR! : rawL!;
        if (other.kind === 'boolean' && !other.pureWhenGuarded) return boolPair(node.left, node.right);
        if ((other.kind === 'boolean' || other.kind === 'unknown') && other.snapshotNode) return boolSnap(leftBool ? node.left : node.right, other);
        throw new Error('Unsupported RTDB equality between boolean and ' + other.kind);
      }
      const lhs = rawL!, rhs = rawR!, cmpOp = effectivePol === 'pos' ? '==' : '!=';
      const lUnsafe = lhs.kind === 'boolean' && !lhs.pureWhenGuarded;
      const rUnsafe = rhs.kind === 'boolean' && !rhs.pureWhenGuarded;
      if (lhs.kind === 'null' || rhs.kind === 'null') {
        const other = lhs.kind === 'null' ? rhs : lhs;
        if (other.kind === 'null') return makeTerm(String(effectivePol === 'pos'), 'boolean', [], { pureWhenGuarded: true });
        if (other.kind === 'boolean' && !other.pureWhenGuarded) {
          if (effectivePol === 'pos') return makeTerm('false', 'boolean');
          const expr = lhs.kind === 'null' ? node.right : node.left;
          return makeTerm(`(${withGuards(emitBool(expr, 'pos', env))} || ${withGuards(emitBool(expr, 'neg', env))})`, 'boolean');
        }
        if (other.snapshotNode && !other.typedLeaf) {
          if (effectivePol === 'neg') return makeTerm(other.snapshotNode + '.exists()', 'boolean');
          if (!other.isRootBinding) throw new Error('Null equality on child snapshot cannot distinguish missing key from null');
          return makeTerm('(!' + other.snapshotNode + '.exists())', 'boolean');
        }
        return makeTerm(String(effectivePol === 'neg'), 'boolean', mergeGuards(other.guards, arithGuards(other)), { pureWhenGuarded: true });
      }
      if ((lUnsafe && rhs.kind === 'boolean') || (rUnsafe && lhs.kind === 'boolean')) return boolPair(node.left, node.right);
      if (lUnsafe && rhs.kind === 'unknown' && rhs.snapshotNode) return boolSnap(node.left, rhs);
      if (rUnsafe && lhs.kind === 'unknown' && lhs.snapshotNode) return boolSnap(node.right, lhs);
      if (lhs.kind === 'unknown' && lhs.snapshotNode && (rhs.kind === 'number' || rhs.kind === 'string' || rhs.kind === 'boolean')) {
        const res = emitUntypedScalarEq(lhs, rhs, effectivePol, true);
        return makeTerm(res.text, 'boolean', mergeGuards(res.guards, arithGuards(rhs)), { pureWhenGuarded: true });
      }
      if (rhs.kind === 'unknown' && rhs.snapshotNode && (lhs.kind === 'number' || lhs.kind === 'string' || lhs.kind === 'boolean')) {
        const res = emitUntypedScalarEq(rhs, lhs, effectivePol, false);
        return makeTerm(res.text, 'boolean', mergeGuards(res.guards, arithGuards(lhs)), { pureWhenGuarded: true });
      }
      if (lhs.kind === 'unknown' && rhs.kind === 'unknown' && lhs.snapshotNode && rhs.snapshotNode) {
        const g = mergeGuards([scalarGuard(lhs.snapshotNode), scalarGuard(rhs.snapshotNode)]);
        return makeTerm(`(${lhs.snapshotNode}.val() ${cmpOp} ${rhs.snapshotNode}.val())`, 'boolean', g, { pureWhenGuarded: true });
      }
      if (lhs.kind === rhs.kind && (lhs.kind === 'number' || lhs.kind === 'string' || lhs.kind === 'boolean')) {
        return makeTerm(`(${lhs.text} ${cmpOp} ${rhs.text})`, 'boolean', mergeGuards(lhs.guards, rhs.guards, arithGuards(lhs), arithGuards(rhs)), { pureWhenGuarded: true });
      }
      throw new Error('Unsupported RTDB equality between ' + lhs.kind + ' and ' + rhs.kind);
    }
    const value = narrow(emitValue(node, 'boolean', env), 'boolean');
    if (!value) throw new Error('RTDB validation requires a boolean result');
    if (pol === 'pos') return value;
    if (value.snapshotNode) {
      return makeTerm('(' + value.snapshotNode + '.val() == false)', 'boolean', value.guards, { pureWhenGuarded: true });
    }
    return makeTerm('(!' + value.text + ')', 'boolean', value.guards);
  }

  try {
    for (const binding of lets) {
      const snapshot = new Map(rootEnv);
      emitValue(binding.value, undefined, snapshot);
      rootEnv.set(binding.name, { expr: binding.value, env: snapshot });
    }
    const result = emitBool(expr, 'pos', rootEnv);
    const predicate = checkLength(withGuards(result));
    const parsed = parseRtdbExpressionTree(predicate);
    if (!parsed.ok) {
      problems.add('Generated RTDB predicate failed to parse: ' + parsed.message);
    } else {
      for (const err of validateRtdbExpression(predicate, 'validate')) {
        problems.add('Generated RTDB predicate failed type check: ' + err.message);
      }
    }
    return {
      inputs: [...inputs],
      features: [...features],
      problems: [...problems],
      predicate: problems.size ? undefined : predicate,
    };
  } catch (error) {
    if (!problems.size) problems.add(error instanceof Error ? error.message : String(error));
    return { inputs: [...inputs], features: [...features], problems: [...problems], predicate: undefined };
  }
}

export function emitRtdbFunctionPredicate(fn: FunctionDef, bindings: RtdbBindings, defaultLeafType: 'number' | 'any' = 'number'): string {
  if (Object.keys(bindings).length !== fn.parameters.length ||
      fn.parameters.some((name) => !Object.hasOwn(bindings, name))) {
    throw new Error('RTDB parameter bindings must match');
  }
  const result = lowerRtdbExpression(fn.body, bindings, { defaultLeafType }, fn.lets);
  if (!result.predicate) throw new Error(result.problems.join('; ') || 'Unsupported RTDB expression');
  return result.predicate;
}

/** Strict conjunctive placement check: the policy must hold on EVERY branch (no || or ?: bypass). */
export function hasRequiredConjunct(expr: RtdbExpressionTree, wantedCanonical: string): boolean {
  if (JSON.stringify(expr) === wantedCanonical) return true;
  if (expr.type === 'binary' && expr.operator === '&&') {
    return hasRequiredConjunct(expr.left, wantedCanonical) || hasRequiredConjunct(expr.right, wantedCanonical);
  }
  return false;
}
