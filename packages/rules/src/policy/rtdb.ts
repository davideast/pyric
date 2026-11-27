// Unified RTDB lowering target for pure policy functions and transitions.
// Unifies numeric predicates, exact safe-integer increments, and general
// numeric/boolean/string/null comparisons over data/newData snapshots.
// Uses dual-polarity local guards to preserve CEL short-circuiting and prevent
// fail-open negation or runtime-error drift under RTDB's 2-valued semantics.
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
}

const KEY_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_MAX_LENGTH = 16384;
const SAFE_INT_MAX = 9007199254740991;
const SAFE_INT_MIN = -9007199254740991;

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
  for (const list of lists) {
    for (const guard of list) {
      if (!seen.has(guard)) {
        seen.add(guard);
        out.push(guard);
      }
    }
  }
  return out;
}

function guardPrefix(guards: readonly string[]): string {
  return guards.length === 1 ? guards[0]! : '(' + guards.join(' && ') + ')';
}

function withGuards(term: RtdbTerm): string {
  if (!term.guards.length) return term.text;
  return '(' + [...term.guards, term.text].join(' && ') + ')';
}

function safeStringLiteral(value: string): string | undefined {
  if (/[\r\n\u2028\u2029]/.test(value)) return undefined;
  return JSON.stringify(value);
}

function integerCheck(nodeExpr: string, min = SAFE_INT_MIN, max = SAFE_INT_MAX): string {
  return `(${nodeExpr}.isNumber() && ${nodeExpr}.val() >= ${min} && ${nodeExpr}.val() <= ${max} && ${nodeExpr}.val() % 1 == 0)`;
}

function scalarGuard(nodeExpr: string): string {
  return `(${nodeExpr}.isNumber() || ${nodeExpr}.isString() || ${nodeExpr}.isBoolean())`;
}

function flip(pol: Polarity): Polarity {
  return pol === 'pos' ? 'neg' : 'pos';
}

function negateCmp(op: '<' | '<=' | '>' | '>='): '<' | '<=' | '>' | '>=' {
  switch (op) {
    case '<': return '>=';
    case '<=': return '>';
    case '>': return '<=';
    case '>=': return '<';
  }
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
    if (!parsed) {
      problems.add('Invalid RTDB snapshot binding for ' + key);
      continue;
    }
    normalized.set(key, parsed);
  }

  function checkLength(text: string): string {
    if (text.length > maxLength) throw new Error('RTDB predicate exceeds emission limit');
    return text;
  }

  function makeTerm(
    text: string,
    kind: ValueKind,
    guards: readonly string[] = [],
    extra?: Pick<RtdbTerm, 'snapshotNode' | 'isRootBinding' | 'typedLeaf'>,
  ): RtdbTerm {
    checkLength(text);
    let guardChars = 0;
    for (const g of guards) guardChars += g.length + 4;
    if (text.length + guardChars > maxLength) throw new Error('RTDB predicate exceeds emission limit');
    return { text, kind, guards, ...extra };
  }

  function resolveSnapshot(path: string): RtdbTerm | undefined {
    const exact = normalized.get(path);
    let binding = exact;
    let remaining: string[] = [];
    let isRootBinding = false;
    if (exact) {
      isRootBinding = true;
    } else {
      const parts = path.split('.');
      for (let i = parts.length - 1; i >= 1; i--) {
        const prefix = parts.slice(0, i).join('.');
        const found = normalized.get(prefix);
        if (found) {
          binding = found;
          remaining = parts.slice(i);
          break;
        }
      }
    }
    if (!binding) {
      problems.add('Missing binding: ' + path);
      return undefined;
    }
    if (checkTiming) {
      const root = path.split('.')[0];
      if ((root === 'before' && binding.snapshot !== 'data') ||
          (root === 'after' && binding.snapshot !== 'newData')) {
        problems.add('Wrong snapshot: ' + path + ' bound to ' + binding.snapshot);
        return undefined;
      }
    }
    if (!remaining.every((k) => KEY_SEGMENT.test(k))) {
      problems.add('Unsupported RTDB field ' + path);
      return undefined;
    }
    const childPath = [binding.path, ...remaining].filter(Boolean).join('/');
    const nodeExpr = binding.snapshot
      + (binding.parent ? '.parent()' : '')
      + (childPath ? '.child(' + JSON.stringify(childPath) + ')' : '');
    const hint = binding.type ?? defaultLeafType;
    if (hint === 'number') {
      return makeTerm(nodeExpr + '.val()', 'number', [nodeExpr + '.isNumber()'], {
        snapshotNode: nodeExpr, isRootBinding, typedLeaf: true,
      });
    }
    if (hint === 'string') {
      return makeTerm(nodeExpr + '.val()', 'string', [nodeExpr + '.isString()'], {
        snapshotNode: nodeExpr, isRootBinding, typedLeaf: true,
      });
    }
    if (hint === 'boolean') {
      return makeTerm('(' + nodeExpr + '.val() == true)', 'boolean', [nodeExpr + '.isBoolean()'], {
        snapshotNode: nodeExpr, isRootBinding, typedLeaf: true,
      });
    }
    return makeTerm(nodeExpr + '.val()', 'unknown', [], { snapshotNode: nodeExpr, isRootBinding, typedLeaf: false });
  }

  function narrow(term: RtdbTerm, kind: 'number' | 'string' | 'boolean'): RtdbTerm | undefined {
    if (term.kind === kind) return term;
    if (term.kind === 'unknown' && term.snapshotNode) {
      const check = kind === 'number' ? '.isNumber()' : kind === 'string' ? '.isString()' : '.isBoolean()';
      const text = kind === 'boolean' ? '(' + term.snapshotNode + '.val() == true)' : term.snapshotNode + '.val()';
      return makeTerm(text, kind, mergeGuards(term.guards, [term.snapshotNode + check]), {
        snapshotNode: term.snapshotNode, isRootBinding: term.isRootBinding, typedLeaf: true,
      });
    }
    return undefined;
  }

  const locals = new Map<string, RtdbTerm>();

  function emitValue(node: Expression, expectedKind?: 'number' | 'string' | 'boolean'): RtdbTerm {
    const path = field(node);
    if (path) {
      const local = locals.get(path);
      if (local) return expectedKind ? (narrow(local, expectedKind) ?? local) : local;
      inputs.add(path);
      const resolved = resolveSnapshot(path);
      if (!resolved) throw new Error('Unbound RTDB field ' + path);
      return expectedKind ? (narrow(resolved, expectedKind) ?? resolved) : resolved;
    }
    if (node.type === 'literal') {
      if (typeof node.value === 'boolean') return makeTerm(String(node.value), 'boolean');
      if (node.value === null) return makeTerm('null', 'null');
      if (typeof node.value === 'number') {
        if (!Number.isFinite(node.value) || Object.is(node.value, -0) || Math.abs(node.value) > SAFE_INT_MAX) {
          throw new Error('Unsupported RTDB numeric literal: ' + node.raw);
        }
        return makeTerm(String(node.value), 'number');
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
        const inner = narrow(emitValue(node.operand), 'number');
        if (!inner) throw new Error('Unsupported RTDB unary - operand');
        return makeTerm('(-' + inner.text + ')', 'number', inner.guards);
      }
      if (node.op === '!') return emitBool(node, 'pos');
    }
    if (node.type === 'methodCall') {
      if (node.method === 'size' && node.args.length === 0) {
        const recv = narrow(emitValue(node.object), 'string');
        if (!recv) throw new Error('RTDB .size() requires a string receiver');
        features.add('string.length');
        return makeTerm('(' + recv.text + '.length)', 'number', recv.guards);
      }
      throw new Error('Unsupported RTDB method call: ' + node.method);
    }
    if (node.type === 'binaryOp') {
      features.add(node.op);
      if (node.op === '&&' || node.op === '||' || node.op === '==' || node.op === '!=' ||
          node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') {
        return emitBool(node, 'pos');
      }
      if (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '%') {
        const hintKind = node.op === '+'
          ? (expectedKind ?? inferLiteralKind(node.left) ?? inferLiteralKind(node.right))
          : 'number';
        const rawLeft = emitValue(node.left, hintKind);
        const rawRight = emitValue(node.right, hintKind);
        if (node.op === '+' && (rawLeft.kind === 'string' || rawRight.kind === 'string')) {
          const l = narrow(rawLeft, 'string') ?? narrow(emitValue(node.left, 'string'), 'string');
          const r = narrow(rawRight, 'string') ?? narrow(emitValue(node.right, 'string'), 'string');
          if (!l || !r) throw new Error('RTDB + cannot mix string and non-string');
          return makeTerm('(' + l.text + ' + ' + r.text + ')', 'string', mergeGuards(l.guards, r.guards));
        }
        const l = narrow(rawLeft, 'number') ?? narrow(emitValue(node.left, 'number'), 'number');
        const r = narrow(rawRight, 'number') ?? narrow(emitValue(node.right, 'number'), 'number');
        if (!l || !r) throw new Error('Unsupported RTDB arithmetic operands for ' + node.op);
        if (node.op === '%') {
          // Guard against division-by-zero producing NaN in RTDB.
          const extra = node.right.type === 'literal' && typeof node.right.value === 'number' && node.right.value !== 0
            ? []
            : ['(' + r.text + ' != 0)'];
          return makeTerm('(' + l.text + ' % ' + r.text + ')', 'number', mergeGuards(l.guards, r.guards, extra));
        }
        return makeTerm('(' + l.text + ' ' + node.op + ' ' + r.text + ')', 'number', mergeGuards(l.guards, r.guards));
      }
      throw new Error('Unsupported RTDB binary operator: ' + node.op);
    }
    if (node.type === 'isExpr') return emitBool(node, 'pos');
    if (node.type === 'ternary') {
      features.add('conditional');
      const condPos = emitBool(node.condition, 'pos');
      const condNeg = emitBool(node.condition, 'neg');
      const yes = emitValue(node.consequent, expectedKind);
      const no = emitValue(node.alternate, expectedKind);
      if (yes.kind === 'boolean' && no.kind === 'boolean') return emitBool(node, 'pos');
      let resolvedYes = yes;
      let resolvedNo = no;
      if (yes.kind === 'unknown' && (no.kind === 'number' || no.kind === 'string')) {
        resolvedYes = emitValue(node.consequent, no.kind);
      } else if (no.kind === 'unknown' && (yes.kind === 'number' || yes.kind === 'string')) {
        resolvedNo = emitValue(node.alternate, yes.kind);
      }
      if (resolvedYes.kind !== resolvedNo.kind ||
          (resolvedYes.kind !== 'number' && resolvedYes.kind !== 'string')) {
        throw new Error('Unsupported RTDB ternary value types');
      }
      const condVal = withGuards(condPos);
      const condValid = '(' + condVal + ' || ' + withGuards(condNeg) + ')';
      const yesGuard = resolvedYes.guards.length ? guardPrefix(resolvedYes.guards) : 'true';
      const noGuard = resolvedNo.guards.length ? guardPrefix(resolvedNo.guards) : 'true';
      const branchGuard = yesGuard === 'true' && noGuard === 'true'
        ? []
        : ['(' + condVal + ' ? ' + yesGuard + ' : ' + noGuard + ')'];
      const guards = mergeGuards([condValid], branchGuard);
      return makeTerm('(' + condVal + ' ? ' + resolvedYes.text + ' : ' + resolvedNo.text + ')', resolvedYes.kind, guards);
    }
    throw new Error('Unsupported RTDB expression: ' + node.type);
  }

  function emitBool(node: Expression, pol: Polarity): RtdbTerm {
    if (node.type === 'literal' && typeof node.value === 'boolean') {
      return makeTerm(String(pol === 'pos' ? node.value : !node.value), 'boolean');
    }
    if (node.type === 'unaryOp' && node.op === '!') {
      features.add('!');
      return emitBool(node.operand, flip(pol));
    }
    if (node.type === 'binaryOp' && (node.op === '&&' || node.op === '||')) {
      features.add(node.op);
      const emitAnd = (node.op === '&&' && pol === 'pos') || (node.op === '||' && pol === 'neg');
      const l = withGuards(emitBool(node.left, pol));
      const r = withGuards(emitBool(node.right, pol));
      return makeTerm('(' + l + (emitAnd ? ' && ' : ' || ') + r + ')', 'boolean');
    }
    if (node.type === 'ternary') {
      features.add('conditional');
      const cPos = withGuards(emitBool(node.condition, 'pos'));
      const cNeg = withGuards(emitBool(node.condition, 'neg'));
      const tRes = withGuards(emitBool(node.consequent, pol));
      const fRes = withGuards(emitBool(node.alternate, pol));
      return makeTerm('(' + cPos + ' ? ' + tRes + ' : (' + cNeg + ' && ' + fRes + '))', 'boolean');
    }
    if (node.type === 'isExpr') {
      features.add('is ' + node.typeName);
      const inner = emitValue(node.value);
      if (inner.snapshotNode) {
        const n = inner.snapshotNode;
        if (node.typeName === 'int') {
          const pred = integerCheck(n);
          if (pol === 'pos') return makeTerm(pred, 'boolean');
          if (!inner.isRootBinding) throw new Error('Negated is int on child snapshot is unsound for missing vs null');
          return makeTerm('(!' + pred + ')', 'boolean');
        }
        if (node.typeName === 'number' || node.typeName === 'string' || node.typeName === 'bool') {
          const method = node.typeName === 'number' ? '.isNumber()'
            : node.typeName === 'string' ? '.isString()' : '.isBoolean()';
          if (pol === 'pos') return makeTerm(n + method, 'boolean');
          if (!inner.isRootBinding) throw new Error('Negated is ' + node.typeName + ' on child snapshot is unsound for missing vs null');
          return makeTerm('(!' + n + method + ')', 'boolean');
        }
        if (node.typeName === 'null') {
          if (!inner.isRootBinding) throw new Error('is null on child snapshot cannot distinguish missing key from null');
          return makeTerm(pol === 'pos' ? '(!' + n + '.exists())' : n + '.exists()', 'boolean');
        }
        throw new Error('Unsupported RTDB type test: is ' + node.typeName);
      }
      if (node.typeName === 'number' && inner.kind === 'number') {
        return makeTerm(String(pol === 'pos'), 'boolean', inner.guards);
      }
      if (node.typeName === 'string' && inner.kind === 'string') {
        return makeTerm(String(pol === 'pos'), 'boolean', inner.guards);
      }
      if (node.typeName === 'bool' && inner.kind === 'boolean') {
        return makeTerm(String(pol === 'pos'), 'boolean', inner.guards);
      }
      throw new Error('Unsupported RTDB type test: is ' + node.typeName);
    }
    if (node.type === 'binaryOp' && (node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=')) {
      features.add(node.op);
      const op = pol === 'pos' ? node.op : negateCmp(node.op);
      const hint = inferLiteralKind(node.left) ?? inferLiteralKind(node.right);
      const rawL = emitValue(node.left, hint === 'string' || hint === 'number' ? hint : undefined);
      const rawR = emitValue(node.right, hint === 'string' || hint === 'number' ? hint : undefined);
      if (rawL.kind === 'unknown' && rawR.kind === 'unknown' && rawL.snapshotNode && rawR.snapshotNode) {
        const a = rawL.snapshotNode;
        const b = rawR.snapshotNode;
        const numBranch = `(${a}.isNumber() && ${b}.isNumber() && (${a}.val() ${op} ${b}.val()))`;
        const strBranch = `(${a}.isString() && ${b}.isString() && (${a}.val() ${op} ${b}.val()))`;
        return makeTerm(`(${numBranch} || ${strBranch})`, 'boolean');
      }
      const targetKind = rawL.kind === 'string' || rawR.kind === 'string' ? 'string' : 'number';
      const l = narrow(rawL, targetKind);
      const r = narrow(rawR, targetKind);
      if (!l || !r) throw new Error('Unsupported RTDB ordering operands for ' + node.op);
      return makeTerm('(' + l.text + ' ' + op + ' ' + r.text + ')', 'boolean', mergeGuards(l.guards, r.guards));
    }
    if (node.type === 'binaryOp' && (node.op === '==' || node.op === '!=')) {
      features.add(node.op);
      const effectivePol = node.op === '==' ? pol : flip(pol);
      const rawL = emitValue(node.left);
      const rawR = emitValue(node.right);
      const cmpOp = effectivePol === 'pos' ? '==' : '!=';
      // Null comparisons
      if (rawL.kind === 'null' || rawR.kind === 'null') {
        const other = rawL.kind === 'null' ? rawR : rawL;
        if (other.kind === 'null') return makeTerm(String(effectivePol === 'pos'), 'boolean');
        if (other.snapshotNode && !other.typedLeaf) {
          if (effectivePol === 'neg') return makeTerm(other.snapshotNode + '.exists()', 'boolean');
          if (!other.isRootBinding) {
            throw new Error('Null equality on child snapshot cannot distinguish missing key from null');
          }
          return makeTerm('(!' + other.snapshotNode + '.exists())', 'boolean');
        }
        return makeTerm(String(effectivePol === 'neg'), 'boolean', other.guards);
      }
      // Untyped snapshot compared with known scalar
      if (rawL.kind === 'unknown' && rawL.snapshotNode && (rawR.kind === 'number' || rawR.kind === 'string' || rawR.kind === 'boolean')) {
        if (effectivePol === 'pos') {
          const l = narrow(rawL, rawR.kind)!;
          return makeTerm('(' + l.text + ' == ' + rawR.text + ')', 'boolean', mergeGuards(l.guards, rawR.guards));
        }
        const existGuard = rawL.isRootBinding ? [] : [rawL.snapshotNode + '.exists()'];
        return makeTerm('(' + rawL.snapshotNode + '.val() != ' + rawR.text + ')', 'boolean', mergeGuards(existGuard, rawR.guards));
      }
      if (rawR.kind === 'unknown' && rawR.snapshotNode && (rawL.kind === 'number' || rawL.kind === 'string' || rawL.kind === 'boolean')) {
        if (effectivePol === 'pos') {
          const r = narrow(rawR, rawL.kind)!;
          return makeTerm('(' + rawL.text + ' == ' + r.text + ')', 'boolean', mergeGuards(rawL.guards, r.guards));
        }
        const existGuard = rawR.isRootBinding ? [] : [rawR.snapshotNode + '.exists()'];
        return makeTerm('(' + rawL.text + ' != ' + rawR.snapshotNode + '.val())', 'boolean', mergeGuards(rawL.guards, existGuard));
      }
      // Two untyped snapshots: guard both as primitive scalars (objects lack structural == in RTDB).
      if (rawL.kind === 'unknown' && rawR.kind === 'unknown' && rawL.snapshotNode && rawR.snapshotNode) {
        const g = mergeGuards([scalarGuard(rawL.snapshotNode), scalarGuard(rawR.snapshotNode)]);
        return makeTerm('(' + rawL.snapshotNode + '.val() ' + cmpOp + ' ' + rawR.snapshotNode + '.val())', 'boolean', g);
      }
      // Same known scalar kind
      if (rawL.kind === rawR.kind && (rawL.kind === 'number' || rawL.kind === 'string' || rawL.kind === 'boolean')) {
        return makeTerm('(' + rawL.text + ' ' + cmpOp + ' ' + rawR.text + ')', 'boolean', mergeGuards(rawL.guards, rawR.guards));
      }
      throw new Error('Unsupported RTDB equality between ' + rawL.kind + ' and ' + rawR.kind);
    }
    const value = narrow(emitValue(node), 'boolean');
    if (!value) throw new Error('RTDB validation requires a boolean result');
    if (pol === 'pos') return value;
    if (value.snapshotNode) {
      return makeTerm('(' + value.snapshotNode + '.val() == false)', 'boolean', value.guards);
    }
    return makeTerm('(!' + value.text + ')', 'boolean', value.guards);
  }

  try {
    for (const binding of lets) {
      locals.set(binding.name, emitValue(binding.value));
    }
    const result = emitBool(expr, 'pos');
    const predicate = checkLength(withGuards(result));
    const parsed = parseRtdbExpressionTree(predicate);
    if (!parsed.ok) {
      problems.add('Generated RTDB predicate failed to parse: ' + parsed.message);
    } else {
      const typeErrors = validateRtdbExpression(predicate, 'validate');
      for (const err of typeErrors) {
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
    if (!problems.size) {
      problems.add(error instanceof Error ? error.message : String(error));
    }
    return { inputs: [...inputs], features: [...features], problems: [...problems], predicate: undefined };
  }
}

export function emitRtdbFunctionPredicate(fn: FunctionDef, bindings: RtdbBindings, defaultLeafType: 'number' | 'any' = 'number'): string {
  if (Object.keys(bindings).length !== fn.parameters.length ||
      fn.parameters.some((name) => !Object.hasOwn(bindings, name))) {
    throw new Error('RTDB parameter bindings must match');
  }
  const result = lowerRtdbExpression(fn.body, bindings, { defaultLeafType }, fn.lets);
  if (!result.predicate) {
    throw new Error(result.problems.join('; ') || 'Unsupported RTDB expression');
  }
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
