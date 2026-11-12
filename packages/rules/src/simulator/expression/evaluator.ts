/**
 * Item 4.2.2 / 4.2.3 — AST evaluator.
 *
 * `evaluate(node, env)` walks an AST produced by `parser.parse` and
 * resolves it against a captured read-set, producing an `EvalValue`.
 * The evaluator's contract:
 *
 *  - Strict types. Every operator rejects operand types it doesn't
 *    explicitly support — no implicit coercion. Mirrors how Firestore
 *    rules evaluate, so an expression that throws here is one that
 *    would also be rejected in production.
 *
 *  - `==` / `!=` admit cross-type compares (returning false / true).
 *    All other comparisons (`<`, `<=`, `>`, `>=`) require same-type
 *    operands. Rationale: the natural null-guard
 *    `$src == null ? "missing" : $src.name` would otherwise throw
 *    when `$src` is non-null.
 *
 *  - `&&` / `||` short-circuit. The right-hand side is not
 *    evaluated if the left settles the result. This mirrors rules
 *    eval AND prevents null-access throws on a branch the rule-side
 *    would have skipped.
 *
 *  - Sentinels (`@name(...)`) produce a passthrough object whose
 *    shape matches `simulator/converters/{fieldvalue,timestamp}.ts`.
 *    A sentinel is a valid top-level result but throws if used as
 *    an operator operand — `$a + @increment(1)` is sentinel-misuse.
 *
 *  - NaN and Infinity never escape this function. Arithmetic that
 *    produces them throws `division-by-zero`.
 *
 *  - Field access on a missing object key returns `null` (not
 *    undefined; not a throw). Field access on null target throws
 *    `null-access`. Agents guard with a ternary.
 *
 *  - References (`$alias`) throw `unknown-reference` if the alias
 *    is not in the captured read map (typo defense). A doc that
 *    didn't exist at read time is `null` in the map — not absent.
 */
import {
  type AstNode,
  type BinaryNode,
  type FieldAccessNode,
  type IndexAccessNode,
  type LogicalNode,
  type ReferenceNode,
  type SentinelNode,
  type TernaryNode,
  type UnaryNode,
} from './types.js';
import {
  EvalError,
  isSentinelValue,
  typeMismatch,
  type EvalEnv,
  type EvalValue,
  type SentinelValue,
} from './eval-errors.js';

export function evaluate(node: AstNode, env: EvalEnv): EvalValue {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'reference':
      return resolveReference(node, env);
    case 'sentinel':
      return resolveSentinel(node, env);
    case 'unary':
      return evalUnary(node, env);
    case 'binary':
      return evalBinary(node, env);
    case 'logical':
      return evalLogical(node, env);
    case 'ternary':
      return evalTernary(node, env);
    case 'fieldAccess':
      return evalFieldAccess(node, env);
    case 'indexAccess':
      return evalIndexAccess(node, env);
  }
}

// ---------------------------------------------------------------------
// References — `$alias`.
// ---------------------------------------------------------------------

function resolveReference(node: ReferenceNode, env: EvalEnv): EvalValue {
  if (!Object.prototype.hasOwnProperty.call(env.reads, node.alias)) {
    throw new EvalError(
      'unknown-reference',
      `unknown alias '$${node.alias}' (not in reads). Hint: aliases are case-sensitive; sentinels use '@' not '$'.`,
      node.pos,
    );
  }
  // The map's value is `EvalObject | null`. `null` means the doc
  // was missing at read time — that's a valid value the agent can
  // null-check with `$alias == null ? ... : ...`.
  return env.reads[node.alias] ?? null;
}

// ---------------------------------------------------------------------
// Sentinels — `@name(args)`.
// Args evaluated eagerly; nested sentinels are rejected so we don't
// produce illegal shapes.
// ---------------------------------------------------------------------

function resolveSentinel(node: SentinelNode, env: EvalEnv): SentinelValue {
  // Parser already validated the name and arity, but we re-evaluate
  // args here. Guard against sentinel-as-arg.
  const argValues = node.args.map((a) => {
    const v = evaluate(a, env);
    if (isSentinelValue(v)) {
      throw new EvalError(
        'sentinel-misuse',
        `sentinel '@${(v as SentinelValue).__type}' cannot be a sentinel argument`,
        a.pos,
      );
    }
    return v;
  });

  switch (node.name) {
    case 'serverTimestamp':
      return { __type: 'serverTimestamp' };
    case 'deleteField':
      return { __type: 'deleteField' };
    case 'increment': {
      const v = argValues[0];
      if (typeof v !== 'number') {
        throw typeMismatch(
          node,
          `'@increment' expects a numeric argument, got ${describeValue(v)}`,
        );
      }
      // Reject NaN/Infinity defensively even though the lexer rules
      // out NaN literals — the arg could be the result of arithmetic.
      assertFiniteNumber(v, node);
      return { __type: 'increment', value: v };
    }
    case 'arrayUnion':
      return { __type: 'arrayUnion', values: argValues };
    case 'arrayRemove':
      return { __type: 'arrayRemove', values: argValues };
  }
}

// ---------------------------------------------------------------------
// Unary — `-x`, `!x`.
// ---------------------------------------------------------------------

function evalUnary(node: UnaryNode, env: EvalEnv): EvalValue {
  const v = evaluate(node.operand, env);
  rejectSentinelOperand(v, node);
  if (node.op === '-') {
    if (typeof v !== 'number') {
      throw typeMismatch(node, `unary '-' expects a number, got ${describeValue(v)}`);
    }
    const r = -v;
    assertFiniteNumber(r, node);
    return r;
  }
  // node.op === '!'
  if (typeof v !== 'boolean') {
    throw typeMismatch(node, `unary '!' expects a boolean, got ${describeValue(v)}`);
  }
  return !v;
}

// ---------------------------------------------------------------------
// Binary arithmetic + comparison.
// ---------------------------------------------------------------------

function evalBinary(node: BinaryNode, env: EvalEnv): EvalValue {
  const left = evaluate(node.left, env);
  const right = evaluate(node.right, env);
  rejectSentinelOperand(left, node);
  rejectSentinelOperand(right, node);

  switch (node.op) {
    case '+':
      if (typeof left === 'number' && typeof right === 'number') {
        const r = left + right;
        assertFiniteNumber(r, node);
        return r;
      }
      if (typeof left === 'string' && typeof right === 'string') {
        return left + right;
      }
      throw typeMismatch(
        node,
        `'+' expects (number, number) or (string, string); got (${describeValue(left)}, ${describeValue(right)})`,
      );
    case '-':
    case '*':
    case '/':
    case '%': {
      if (typeof left !== 'number' || typeof right !== 'number') {
        throw typeMismatch(
          node,
          `'${node.op}' expects (number, number); got (${describeValue(left)}, ${describeValue(right)})`,
        );
      }
      let r: number;
      switch (node.op) {
        case '-': r = left - right; break;
        case '*': r = left * right; break;
        case '/': r = left / right; break;
        case '%': r = left % right; break;
      }
      assertFiniteNumber(r, node);
      return r;
    }
    case '==':
      return strictEqual(node, left, right);
    case '!=':
      return !strictEqual(node, left, right);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return orderedCompare(node, left, right);
  }
}

function strictEqual(node: BinaryNode, left: EvalValue, right: EvalValue): boolean {
  // Same-type compare for primitives. Cross-type → false.
  // Object/array equality has no defined semantics here — rather
  // than silently return false (masks `$a == $b` bugs), throw.
  if (left === null || right === null) return left === right;
  const lt = typeof left;
  const rt = typeof right;
  if (lt !== rt) return false;
  if (lt === 'number' || lt === 'string' || lt === 'boolean') {
    return left === right;
  }
  throw typeMismatch(
    node,
    `equality between objects/arrays is not supported (compare specific fields instead)`,
  );
}

function orderedCompare(node: BinaryNode, left: EvalValue, right: EvalValue): boolean {
  const ok = (typeof left === 'number' && typeof right === 'number')
    || (typeof left === 'string' && typeof right === 'string');
  if (!ok) {
    throw typeMismatch(
      node,
      `'${node.op}' expects matching number/number or string/string operands; got (${describeValue(left)}, ${describeValue(right)})`,
    );
  }
  switch (node.op) {
    case '<':  return (left as number | string) < (right as number | string);
    case '<=': return (left as number | string) <= (right as number | string);
    case '>':  return (left as number | string) > (right as number | string);
    case '>=': return (left as number | string) >= (right as number | string);
    default: throw new Error(`unreachable`);
  }
}

// ---------------------------------------------------------------------
// Logical — `&&`, `||`. SHORT-CIRCUIT.
// Right-hand side is NOT evaluated if left settles the result.
// ---------------------------------------------------------------------

function evalLogical(node: LogicalNode, env: EvalEnv): EvalValue {
  const left = evaluate(node.left, env);
  if (typeof left !== 'boolean') {
    throw typeMismatch(
      node,
      `'${node.op}' expects boolean operands; left is ${describeValue(left)}`,
    );
  }
  if (node.op === '&&') {
    if (!left) return false;
  } else {
    if (left) return true;
  }
  const right = evaluate(node.right, env);
  if (typeof right !== 'boolean') {
    throw typeMismatch(
      node,
      `'${node.op}' expects boolean operands; right is ${describeValue(right)}`,
    );
  }
  return right;
}

// ---------------------------------------------------------------------
// Ternary — strict boolean condition.
// ---------------------------------------------------------------------

function evalTernary(node: TernaryNode, env: EvalEnv): EvalValue {
  const cond = evaluate(node.cond, env);
  if (typeof cond !== 'boolean') {
    throw typeMismatch(
      node,
      `ternary condition must be boolean, got ${describeValue(cond)}`,
    );
  }
  return cond
    ? evaluate(node.whenTrue, env)
    : evaluate(node.whenFalse, env);
}

// ---------------------------------------------------------------------
// Field / index access.
// ---------------------------------------------------------------------

function evalFieldAccess(node: FieldAccessNode, env: EvalEnv): EvalValue {
  const target = evaluate(node.target, env);
  if (target === null || target === undefined) {
    throw new EvalError(
      'null-access',
      `cannot access field '${node.field}' on null`,
      node.pos,
    );
  }
  if (typeof target !== 'object' || Array.isArray(target) || isSentinelValue(target)) {
    throw typeMismatch(
      node,
      `cannot access field '${node.field}' on ${describeValue(target)}`,
    );
  }
  // Missing field → null. Agents null-guard with a ternary.
  const obj = target as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, node.field)) return null;
  return obj[node.field] as EvalValue;
}

function evalIndexAccess(node: IndexAccessNode, env: EvalEnv): EvalValue {
  const target = evaluate(node.target, env);
  if (target === null || target === undefined) {
    throw new EvalError(
      'null-access',
      `cannot index null target`,
      node.pos,
    );
  }
  const index = evaluate(node.index, env);
  if (Array.isArray(target)) {
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      throw new EvalError(
        'invalid-index',
        `array index must be a non-negative integer, got ${describeValue(index)}`,
        node.pos,
      );
    }
    if (index < 0) {
      throw new EvalError(
        'invalid-index',
        `negative array index ${index} not supported (use length-based indexing in eval)`,
        node.pos,
      );
    }
    if (index >= target.length) return null;
    return target[index] as EvalValue;
  }
  if (typeof target === 'object' && !isSentinelValue(target)) {
    if (typeof index !== 'string') {
      throw new EvalError(
        'invalid-index',
        `object key must be a string, got ${describeValue(index)}`,
        node.pos,
      );
    }
    const obj = target as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, index)) return null;
    return obj[index] as EvalValue;
  }
  throw typeMismatch(
    node,
    `cannot index into ${describeValue(target)}`,
  );
}

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

function rejectSentinelOperand(v: EvalValue, node: AstNode): void {
  if (isSentinelValue(v)) {
    throw new EvalError(
      'sentinel-misuse',
      `sentinel '@${(v as SentinelValue).__type}' cannot be used as an operator operand`,
      node.pos,
    );
  }
}

function assertFiniteNumber(v: number, node: AstNode): void {
  if (!Number.isFinite(v)) {
    // Includes NaN, Infinity, -Infinity. Firestore can't store any.
    throw new EvalError(
      'division-by-zero',
      `arithmetic produced a non-finite value (${Number.isNaN(v) ? 'NaN' : 'Infinity'})`,
      node.pos,
    );
  }
}

/**
 * Format a value descriptor for type-mismatch error messages. Surfaces
 * just enough structure to point the agent at the offending shape
 * without dumping arbitrary user data into the error message.
 *
 * For plain objects, the descriptor lists up to 3 top-level keys —
 * agents debugging "got object" need to know *which* object, and
 * key-name leakage is far less sensitive than value leakage. Sentinel
 * shapes are surfaced as `sentinel '@<name>'`.
 */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object' && v !== null) {
    if (isSentinelValue(v)) {
      return `sentinel '@${v.__type}'`;
    }
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 0) return 'object {}';
    const sample = keys.slice(0, 3).join(', ');
    const ellipsis = keys.length > 3 ? ', …' : '';
    return `object {${sample}${ellipsis}}`;
  }
  return typeof v;
}
