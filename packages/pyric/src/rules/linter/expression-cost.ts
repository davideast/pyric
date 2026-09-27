/**
 * Static estimate of the expressions a Firestore Security Rules request
 * evaluates, in the units of production's per-request limit ("the maximum of
 * 1000 expressions to evaluate").
 *
 * The cost model comes from production measurements recorded in
 * `test/rules/linter/fixtures/expression-cost/captures.json` (method in
 * LINTER_SPEC.md, EXPRESSION_BUDGET):
 *
 *  - Every evaluated expression node costs 1: identifiers, literals, member,
 *    index and slice access, method and function calls, comparisons,
 *    arithmetic, `!`, `in`, `is`, and list and map literals.
 *  - `&&` and `||` cost 1, plus 1 when they go on to evaluate their right
 *    operand. A short-circuited operand costs nothing.
 *  - A ternary costs 2 plus its condition and the branch it takes.
 *  - A path literal costs 1 plus 1 per segment; an interpolated segment
 *    costs its expression.
 *  - A user function call costs 1 plus its arguments, each `let` binding
 *    (1 plus its value, evaluated eagerly whether or not the body reads it),
 *    and its body. Calls are not memoized: every call pays again.
 *  - The limit is per request. Allow rules for the request's method are
 *    evaluated in source order and evaluation stops at the first that grants,
 *    so a granted request also pays for every earlier rule that denied.
 *
 * The estimate is the most expensive evaluation path consistent with what is
 * statically known. Branch outcomes are unknown, so a conjunction that must be
 * false is costed as failing at its most expensive conjunct and a disjunction
 * that must be true as succeeding at its most expensive disjunct. Equality
 * facts narrow this: when a granting rule requires `request.resource.data.kind
 * == 'a'`, an earlier rule gated on `request.resource.data.kind == 'b'` is
 * costed as failing at that gate, and a branch whose gate contradicts the
 * facts of the branch that must hold is costed as failing at its gate.
 */
import type { AllowRule, Expression, FirestoreRules, FunctionDef, MatchBlock } from '../grammar/FirestoreAST.js';
import { expressionFingerprint } from './ast-utils.js';

/** Production's per-request evaluation limit. */
export const EXPRESSION_LIMIT = 1000;

export interface RuleCostEstimate {
  /** Index in `collectAllRules` order (depth-first, source order). */
  ruleIndex: number;
  /** Full path of the enclosing match blocks. */
  matchPath: string;
  /** The rule's own match block path as authored, and its position there. */
  blockPath: string;
  blockRuleIndex: number;
  line?: number;
  operations: string[];
  /** Estimated expressions a request this rule grants evaluates, including
   *  the earlier rules for the same method that deny it first. Null when no
   *  evaluation of the condition can be true under its own equality facts. */
  grantCost: number | null;
}

export interface BlockCostEstimate {
  matchPath: string;
  blockPath: string;
  method: string;
  /** Estimated expressions a request evaluates when every rule for the
   *  method denies it. */
  denyCost: number;
}

export interface ExpressionCostEstimates {
  rules: RuleCostEstimate[];
  blocks: BlockCostEstimate[];
}

const METHODS = ['get', 'list', 'create', 'update', 'delete'] as const;

function coversMethod(rule: AllowRule, method: string): boolean {
  return rule.operations.some((op) =>
    op === method
    || (op === 'read' && (method === 'get' || method === 'list'))
    || (op === 'write' && (method === 'create' || method === 'update' || method === 'delete')));
}

type Want = 'T' | 'F' | 'A';
/** Equality facts: fingerprint of a request/resource path → literal value key. */
type Facts = ReadonlyMap<string, string>;
const NO_FACTS: Facts = new Map();

function factsKey(facts: Facts): string {
  if (facts.size === 0) return '';
  return [...facts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('|');
}

/** Merge two fact sets, or null when they assign one path two values. */
function mergeChecked(a: Facts, b: Facts): Facts | null {
  for (const [k, v] of b) {
    const existing = a.get(k);
    if (existing !== undefined && existing !== v) return null;
  }
  return merge(a, b);
}

function merge(a: Facts, b: Facts): Facts {
  if (b.size === 0) return a;
  if (a.size === 0) return b;
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

/** True when `expr` reads only request or resource state through literal keys,
 *  so its value is the same wherever in the ruleset it appears. */
function isGlobalPath(expr: Expression): boolean {
  switch (expr.type) {
    case 'identifier': return expr.name === 'request' || expr.name === 'resource';
    case 'memberAccess': return isGlobalPath(expr.object);
    case 'bracketAccess': return expr.index.type === 'literal' && isGlobalPath(expr.object);
    default: return false;
  }
}

function equalityOperands(expr: Expression): { path: string; literal: string } | null {
  if (expr.type !== 'binaryOp' || (expr.op !== '==' && expr.op !== '!=')) return null;
  if (expr.right.type === 'literal' && isGlobalPath(expr.left)) {
    return { path: expressionFingerprint(expr.left), literal: literalValue(expr.right) };
  }
  if (expr.left.type === 'literal' && isGlobalPath(expr.right)) {
    return { path: expressionFingerprint(expr.right), literal: literalValue(expr.left) };
  }
  return null;
}

/** Key of a literal's value: equal values share a key whatever their
 *  spelling, so `1` and `1.0`, or 'a' and "a", compare equal as in Rules. */
function literalValue(literal: Extract<Expression, { type: 'literal' }>): string {
  const { value } = literal;
  if (value instanceof Uint8Array) return `bytes:${[...value].join(',')}`;
  return `${typeof value}:${String(value)}`;
}

class Estimator {
  private readonly memo = new Map<Expression, Map<string, number | null>>();
  private readonly factMemo = new Map<Expression, Facts>();
  private depth = 0;

  constructor(private readonly fns: ReadonlyMap<string, FunctionDef>) {}

  /** Equality facts that hold whenever `expr` evaluates to true. */
  factsOf(expr: Expression): Facts {
    const hit = this.factMemo.get(expr);
    if (hit) return hit;
    let out: Facts = NO_FACTS;
    if (expr.type === 'binaryOp' && expr.op === '&&') {
      out = merge(this.factsOf(expr.left), this.factsOf(expr.right));
    } else if (expr.type === 'binaryOp' && expr.op === '==') {
      const eq = equalityOperands(expr);
      if (eq) out = new Map([[eq.path, eq.literal]]);
    } else if (expr.type === 'functionCall' && this.fns.has(expr.name) && this.depth < 20) {
      this.depth++;
      out = this.factsOf(this.fns.get(expr.name)!.body);
      this.depth--;
    }
    this.factMemo.set(expr, out);
    return out;
  }

  /** Known truth of a comparison under `facts`, or undefined. */
  private known(expr: Expression, facts: Facts): boolean | undefined {
    if (expr.type === 'inExpr' && expr.collection.type === 'listLiteral' && isGlobalPath(expr.element)) {
      const fact = facts.get(expressionFingerprint(expr.element));
      const items = expr.collection.elements;
      if (fact === undefined || !items.every((e) => e.type === 'literal')) return undefined;
      return items.some((e) => e.type === 'literal' && literalValue(e) === fact);
    }
    const eq = equalityOperands(expr);
    if (!eq || expr.type !== 'binaryOp') return undefined;
    const fact = facts.get(eq.path);
    if (fact === undefined) return undefined;
    const equal = fact === eq.literal;
    return expr.op === '==' ? equal : !equal;
  }

  /**
   * Most expensive evaluation of `expr` that yields `want` (`A` for any
   * outcome) under `facts`, or null when no such evaluation exists.
   */
  cost(expr: Expression, want: Want, facts: Facts): number | null {
    const key = `${want}#${factsKey(facts)}`;
    let byKey = this.memo.get(expr);
    if (!byKey) this.memo.set(expr, (byKey = new Map()));
    if (byKey.has(key)) return byKey.get(key)!;
    const value = this.compute(expr, want, facts);
    byKey.set(key, value);
    return value;
  }

  private any(expr: Expression, facts: Facts): number {
    return this.cost(expr, 'A', facts) ?? 0;
  }

  private compute(expr: Expression, want: Want, facts: Facts): number | null {
    if (want === 'A' && (isLogic(expr) || (expr.type === 'unaryOp' && expr.op === '!'))) {
      return maxOf(this.cost(expr, 'T', facts), this.cost(expr, 'F', facts));
    }
    switch (expr.type) {
      case 'literal':
      case 'identifier':
        return 1;
      case 'memberAccess':
        return 1 + this.any(expr.object, facts);
      case 'methodCall':
        return 1 + this.any(expr.object, facts) + sum(expr.args.map((a) => this.any(a, facts)));
      case 'bracketAccess':
        return 1 + this.any(expr.object, facts) + this.any(expr.index, facts);
      case 'sliceAccess':
        return 1 + this.any(expr.object, facts) + this.any(expr.start, facts) + this.any(expr.end, facts);
      case 'inExpr': {
        const truth = this.known(expr, facts);
        if (truth !== undefined && want !== 'A' && truth !== (want === 'T')) return null;
        return 1 + this.any(expr.element, facts) + this.any(expr.collection, facts);
      }
      case 'isExpr':
        return 1 + this.any(expr.value, facts);
      case 'listLiteral':
        return 1 + sum(expr.elements.map((e) => this.any(e, facts)));
      case 'mapLiteral':
        return 1 + sum(expr.entries.map((e) => this.any(e.key, facts) + this.any(e.value, facts)));
      case 'pathLiteral':
        return 1 + sum(expr.segments.map((s) => (typeof s === 'string' ? 1 : this.any(s, facts))));
      case 'unaryOp':
        if (expr.op === '!') {
          const inner = this.cost(expr.operand, want === 'T' ? 'F' : want === 'F' ? 'T' : 'A', facts);
          return inner === null ? null : 1 + inner;
        }
        return 1 + this.any(expr.operand, facts);
      case 'ternary': {
        const branch = (cond: 'T' | 'F', taken: Expression) => {
          const c = this.cost(expr.condition, cond, facts);
          if (c === null) return null;
          const scoped = cond === 'T' ? merge(facts, this.factsOf(expr.condition)) : facts;
          const t = this.cost(taken, want, scoped);
          return t === null ? null : c + t;
        };
        const best = maxOf(branch('T', expr.consequent), branch('F', expr.alternate));
        return best === null ? null : 2 + best;
      }
      case 'binaryOp':
        if (expr.op === '&&') return this.and(expr.left, expr.right, want as 'T' | 'F', facts);
        if (expr.op === '||') return this.or(expr.left, expr.right, want as 'T' | 'F', facts);
        {
          const truth = this.known(expr, facts);
          if (truth !== undefined && want !== 'A' && truth !== (want === 'T')) return null;
          return 1 + this.any(expr.left, facts) + this.any(expr.right, facts);
        }
      case 'functionCall': {
        const args = sum(expr.args.map((a) => this.any(a, facts)));
        const fn = this.fns.get(expr.name);
        if (!fn || this.depth >= 20) return 1 + args;
        this.depth++;
        try {
          const lets = sum(fn.lets.map((b) => 1 + this.any(b.value, facts)));
          const body = this.cost(fn.body, want, facts);
          return body === null ? null : 1 + args + lets + body;
        } finally {
          this.depth--;
        }
      }
    }
  }

  /** Cost of a left-associative conjunction failing at its first conjunct:
   *  every `&&` on the left spine is entered once and short-circuits. */
  private failAtGate(expr: Expression, facts: Facts): number | null {
    let spine = 0;
    let node = expr;
    while (node.type === 'binaryOp' && node.op === '&&') {
      spine++;
      node = node.left;
    }
    const gate = this.cost(node, 'F', facts);
    return gate === null ? null : spine + gate;
  }

  private and(a: Expression, b: Expression, want: 'T' | 'F', facts: Facts): number | null {
    const aTrue = this.cost(a, 'T', facts);
    const afterA = merge(facts, this.factsOf(a));
    if (want === 'T') {
      const bTrue = this.cost(b, 'T', afterA);
      return aTrue === null || bTrue === null ? null : 2 + aTrue + bTrue;
    }
    const aFalse = this.cost(a, 'F', facts);
    const bFalse = this.cost(b, 'F', afterA);
    return maxOf(
      aFalse === null ? null : 1 + aFalse,
      aTrue === null || bFalse === null ? null : 2 + aTrue + bFalse,
    );
  }

  private or(a: Expression, b: Expression, want: 'T' | 'F', facts: Facts): number | null {
    if (want === 'F') {
      // Both operands are false. Split on whether b's opening equality gate
      // holds: when it does, its facts also decide where a can fail.
      const gateFacts = this.factsOf(firstConjunct(b));
      if (gateFacts.size === 0) {
        const aFalse = this.cost(a, 'F', facts);
        const bFalse = this.cost(b, 'F', facts);
        return aFalse === null || bFalse === null ? null : 2 + aFalse + bFalse;
      }
      const gateFails = this.failAtGate(b, facts);
      const aAny = this.cost(a, 'F', facts);
      const held = mergeChecked(facts, gateFacts);
      const aHeld = held && this.cost(a, 'F', held);
      const bHeld = held && this.cost(b, 'F', held);
      return maxOf(
        aAny === null || gateFails === null ? null : 2 + aAny + gateFails,
        aHeld === null || bHeld === null || !held ? null : 2 + aHeld + bHeld,
      );
    }
    const aFalse = this.cost(a, 'F', facts);
    const aTrue = this.cost(a, 'T', facts);
    // When b must hold, its facts hold too, and they can decide where a fails.
    const bTrue = this.cost(b, 'T', facts);
    const aFalseGivenB = this.cost(a, 'F', merge(facts, this.factsOf(b)));
    return maxOf(
      aTrue === null ? null : 1 + aTrue,
      aFalseGivenB === null || bTrue === null ? null : 2 + aFalseGivenB + bTrue,
    );
  }
}

function isLogic(expr: Expression): boolean {
  return expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||');
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function maxOf(...values: (number | null)[]): number | null {
  let best: number | null = null;
  for (const v of values) if (v !== null && (best === null || v > best)) best = v;
  return best;
}

interface ScopedBlock {
  block: MatchBlock;
  path: string;
  fns: Map<string, FunctionDef>;
}

function walkBlocks(ast: FirestoreRules): ScopedBlock[] {
  const out: ScopedBlock[] = [];
  const base = new Map<string, FunctionDef>();
  for (const fn of ast.functions ?? []) base.set(fn.name, fn);
  for (const fn of ast.service.functions ?? []) base.set(fn.name, fn);
  const visit = (block: MatchBlock, parentPath: string, parentFns: Map<string, FunctionDef>) => {
    const fns = new Map(parentFns);
    for (const fn of block.functions) fns.set(fn.name, fn);
    const path = `${parentPath}${block.path.raw}`;
    out.push({ block, path, fns });
    for (const child of block.children) visit(child, path, fns);
  };
  visit(ast.service.match, '', base);
  return out;
}

/**
 * Estimate, for every allow rule, the expressions a request it grants
 * evaluates, and for every block and method, the expressions a denied
 * request evaluates. Rule indices follow `collectAllRules` order.
 */
export function estimateExpressionCosts(ast: FirestoreRules): ExpressionCostEstimates {
  const rules: RuleCostEstimate[] = [];
  const blocks: BlockCostEstimate[] = [];
  let ruleIndex = 0;
  for (const { block, path, fns } of walkBlocks(ast)) {
    const est = new Estimator(fns);
    const allows = block.allows;
    const indices = allows.map(() => ruleIndex++);
    const falseCost = (rule: AllowRule, facts: Facts) =>
      est.cost(rule.condition, 'F', facts);

    allows.forEach((rule, i) => {
      const grant = est.cost(rule.condition, 'T', NO_FACTS);
      const facts = est.factsOf(rule.condition);
      let worst: number | null = null;
      for (const method of METHODS) {
        if (grant === null || !coversMethod(rule, method)) continue;
        let total = grant;
        for (let j = 0; j < i; j++) {
          if (!coversMethod(allows[j]!, method)) continue;
          // An earlier rule that cannot be false under these facts would have
          // granted first; cost it at its most expensive false path without facts.
          total += falseCost(allows[j]!, facts) ?? falseCost(allows[j]!, NO_FACTS) ?? 0;
        }
        worst = Math.max(worst ?? 0, total);
      }
      rules.push({
        ruleIndex: indices[i]!,
        matchPath: path,
        blockPath: block.path.raw,
        blockRuleIndex: i,
        ...(rule.loc?.line !== undefined ? { line: rule.loc.line } : {}),
        operations: [...rule.operations],
        grantCost: worst,
      });
    });

    for (const method of METHODS) {
      const covering = allows.filter((r) => coversMethod(r, method));
      if (covering.length === 0) continue;
      // A denied request fails every rule. When rules open with equality
      // gates on the same field, the request holds one value of that field (or
      // none of them): cost every such assignment, with each rule failing at
      // its most expensive false path under it, and keep the largest.
      let worst = 0;
      for (const facts of gateAssignments(est, covering)) {
        let total = 0;
        for (const rule of covering) total += falseCost(rule, facts) ?? falseCost(rule, NO_FACTS) ?? 0;
        worst = Math.max(worst, total);
      }
      blocks.push({ matchPath: path, blockPath: block.path.raw, method, denyCost: worst });
    }
  }
  return { rules, blocks };
}

/**
 * Fact sets covering every value a request can hold for the field most of the
 * rules gate on: each gated value, plus a value none of the gates name.
 */
function gateAssignments(est: Estimator, rules: readonly AllowRule[]): Facts[] {
  const valuesByKey = new Map<string, Set<string>>();
  for (const rule of rules) {
    for (const [key, value] of est.factsOf(firstConjunct(rule.condition))) {
      if (!valuesByKey.has(key)) valuesByKey.set(key, new Set());
      valuesByKey.get(key)!.add(value);
    }
  }
  let key: string | undefined;
  for (const [k, values] of valuesByKey) if (!key || values.size > valuesByKey.get(key)!.size) key = k;
  if (!key) return [NO_FACTS];
  const values = [...valuesByKey.get(key)!];
  return [...values, 'unmatched'].map((value) => new Map([[key!, value]]));
}

function firstConjunct(expr: Expression): Expression {
  return expr.type === 'binaryOp' && expr.op === '&&' ? firstConjunct(expr.left) : expr;
}
