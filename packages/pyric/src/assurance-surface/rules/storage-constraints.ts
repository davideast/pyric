/**
 * Cloud Storage security-rule upload metadata constraint and literal hint
 * extraction for `RuleSurface`.
 *
 * Extracts:
 * - `StorageMetadataConstraint` (`contentTypePattern`, inclusive `maxSizeBytes`,
 *   `requiredCustomMetadataKeys`, and `ownerMetadataKey`) over boolean control flow.
 * - Incoming custom-metadata `ValueHint`s (`request.resource.metadata.<k> == <literal>`).
 */
import type { Expression } from '../../rules/internal/index.js';
import type {
  StorageMetadataConstraint,
  StorageMetadataConstraintArm,
} from './rule-surface.js';
import {
  classifyTernaryBranches,
  inlineRuleCall,
  isRequestMemberChain,
  resolveRuleExpr,
  type RuleAstScope,
} from './rules-ast-utils.js';
import type { OwnerCondition } from './types.js';
import type { ValueHint } from './value-hints.js';

interface ConstraintSummary {
  readonly impossible: boolean;
  readonly contentTypes?: string[];
  readonly maxSizeBytes?: number;
  readonly requiredKeys: Set<string>;
}

export interface PropProjection {
  readonly object: Expression;
  readonly objScope: RuleAstScope;
  readonly prop: string;
}

function emptySummary(): ConstraintSummary {
  return { impossible: false, requiredKeys: new Set() };
}

function impossibleSummary(): ConstraintSummary {
  return { impossible: true, requiredKeys: new Set() };
}

function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripOuterAnchors(pattern: string): string {
  if (pattern.startsWith('^') && pattern.endsWith('$') && !pattern.endsWith('\\$')) {
    return pattern.slice(1, -1);
  }
  return pattern;
}

function formatContentTypePatterns(patterns: readonly string[]): string {
  if (patterns.length === 1) return patterns[0]!;
  return `^(?:${patterns.map(stripOuterAnchors).join('|')})$`;
}

function conjoinContentTypePatterns(left: readonly string[], right: readonly string[]): string[] {
  const leftPattern = formatContentTypePatterns(left);
  const rightPattern = formatContentTypePatterns(right);
  if (leftPattern === rightPattern) return [leftPattern];
  return [`^(?=(?:${stripOuterAnchors(leftPattern)})$)(?:${stripOuterAnchors(rightPattern)})$`];
}

function andSummary(left: ConstraintSummary, right: ConstraintSummary): ConstraintSummary {
  if (left.impossible || right.impossible) return impossibleSummary();
  let contentTypes: string[] | undefined;
  if (left.contentTypes && right.contentTypes) {
    contentTypes = conjoinContentTypePatterns(left.contentTypes, right.contentTypes);
  } else if (left.contentTypes) {
    contentTypes = [...left.contentTypes];
  } else if (right.contentTypes) {
    contentTypes = [...right.contentTypes];
  }

  let maxSizeBytes: number | undefined;
  if (left.maxSizeBytes !== undefined && right.maxSizeBytes !== undefined) {
    maxSizeBytes = Math.min(left.maxSizeBytes, right.maxSizeBytes);
  } else if (left.maxSizeBytes !== undefined) {
    maxSizeBytes = left.maxSizeBytes;
  } else if (right.maxSizeBytes !== undefined) {
    maxSizeBytes = right.maxSizeBytes;
  }

  const requiredKeys = new Set<string>([...left.requiredKeys, ...right.requiredKeys]);
  const out: {
    impossible: boolean;
    contentTypes?: string[];
    maxSizeBytes?: number;
    requiredKeys: Set<string>;
  } = { impossible: false, requiredKeys };
  if (contentTypes !== undefined) out.contentTypes = contentTypes;
  if (maxSizeBytes !== undefined) out.maxSizeBytes = maxSizeBytes;
  return out;
}

function orSummary(left: ConstraintSummary, right: ConstraintSummary): ConstraintSummary {
  if (left.impossible && right.impossible) return impossibleSummary();
  if (left.impossible) return right;
  if (right.impossible) return left;

  let contentTypes: string[] | undefined;
  if (left.contentTypes && right.contentTypes) {
    contentTypes = [...new Set([...left.contentTypes, ...right.contentTypes])];
  }

  let maxSizeBytes: number | undefined;
  if (left.maxSizeBytes !== undefined && right.maxSizeBytes !== undefined) {
    maxSizeBytes = Math.max(left.maxSizeBytes, right.maxSizeBytes);
  }

  const requiredKeys = new Set<string>();
  for (const key of left.requiredKeys) {
    if (right.requiredKeys.has(key)) requiredKeys.add(key);
  }

  const out: {
    impossible: boolean;
    contentTypes?: string[];
    maxSizeBytes?: number;
    requiredKeys: Set<string>;
  } = { impossible: false, requiredKeys };
  if (contentTypes !== undefined) out.contentTypes = contentTypes;
  if (maxSizeBytes !== undefined) out.maxSizeBytes = maxSizeBytes;
  return out;
}

export function isUnshadowedIdent(expr: Expression, scope: RuleAstScope, name: string): boolean {
  const r = resolveRuleExpr(expr, scope);
  return r.expr.type === 'identifier' && r.expr.name === name && !r.scope.vars.has(name);
}

export function propOf(expr: Expression, scope: RuleAstScope): PropProjection | undefined {
  const r = resolveRuleExpr(expr, scope);
  if (r.expr.type === 'memberAccess') {
    return { object: r.expr.object, objScope: r.scope, prop: r.expr.property };
  }
  if (r.expr.type === 'bracketAccess') {
    const idx = resolveRuleExpr(r.expr.index, r.scope).expr;
    if (idx.type === 'literal' && typeof idx.value === 'string') {
      return { object: r.expr.object, objScope: r.scope, prop: idx.value };
    }
  }
  return undefined;
}

function isRequestResource(expr: Expression, scope: RuleAstScope): boolean {
  const res = propOf(expr, scope);
  return Boolean(res && res.prop === 'resource' && isUnshadowedIdent(res.object, res.objScope, 'request'));
}

function isRequestResourceProp(expr: Expression, scope: RuleAstScope, prop: string): boolean {
  const p = propOf(expr, scope);
  if (!p || p.prop !== prop) return false;
  return isRequestResource(p.object, p.objScope);
}

function isRequestResourceMetadata(expr: Expression, scope: RuleAstScope): boolean {
  return isRequestResourceProp(expr, scope, 'metadata');
}

function isRequestResourceMetadataKeys(expr: Expression, scope: RuleAstScope): boolean {
  const r = resolveRuleExpr(expr, scope);
  if (r.expr.type !== 'methodCall' || r.expr.method !== 'keys' || r.expr.args.length !== 0) {
    return false;
  }
  return isRequestResourceMetadata(r.expr.object, r.scope);
}

function incomingMetadataDirectKey(expr: Expression, scope: RuleAstScope): string | undefined {
  const p = propOf(expr, scope);
  if (!p) return undefined;
  if (isRequestResourceMetadata(p.object, p.objScope)) return p.prop;
  return undefined;
}

function incomingMetadataGetCall(
  expr: Expression,
  scope: RuleAstScope,
): { key: string; defaultExpr?: Expression; callScope: RuleAstScope } | undefined {
  const r = resolveRuleExpr(expr, scope);
  if (r.expr.type !== 'methodCall' || r.expr.method !== 'get' || !r.expr.args[0]) return undefined;
  if (!isRequestResourceMetadata(r.expr.object, r.scope)) return undefined;
  const keyArg = resolveRuleExpr(r.expr.args[0], r.scope).expr;
  if (keyArg.type !== 'literal' || typeof keyArg.value !== 'string') return undefined;
  return { key: keyArg.value, defaultExpr: r.expr.args[1], callScope: r.scope };
}

export function scalarLiteral(
  expr: Expression,
  scope: RuleAstScope,
): string | number | boolean | null | undefined {
  const r = resolveRuleExpr(expr, scope).expr;
  if (r.type !== 'literal') return undefined;
  if (
    r.value === null
    || typeof r.value === 'string'
    || typeof r.value === 'number'
    || typeof r.value === 'boolean'
  ) {
    return r.value;
  }
  return undefined;
}

function stringListElements(expr: Expression, scope: RuleAstScope): string[] | undefined {
  const r = resolveRuleExpr(expr, scope);
  if (r.expr.type !== 'listLiteral') return undefined;
  const out: string[] = [];
  for (const el of r.expr.elements) {
    const val = scalarLiteral(el, r.scope);
    if (typeof val !== 'string') return undefined;
    out.push(val);
  }
  return out;
}

export function evalNumericExpr(expr: Expression, scope: RuleAstScope): number | undefined {
  const r = resolveRuleExpr(expr, scope);
  const e = r.expr;
  const s = r.scope;
  if (e.type === 'literal' && typeof e.value === 'number') return e.value;
  if (e.type === 'unaryOp') {
    const inner = evalNumericExpr(e.operand, s);
    if (inner === undefined) return undefined;
    if (e.op === '-') return -inner;
    if (e.op === '+') return inner;
    return undefined;
  }
  if (e.type === 'binaryOp') {
    const left = evalNumericExpr(e.left, s);
    const right = evalNumericExpr(e.right, s);
    if (left === undefined || right === undefined) return undefined;
    switch (e.op) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        if (right === 0) return undefined;
        if (Number.isInteger(left) && Number.isInteger(right)) return Math.trunc(left / right);
        return left / right;
      case '%':
        if (right === 0) return undefined;
        return left % right;
      default:
        return undefined;
    }
  }
  return undefined;
}

function negateComparisonOp(op: string): string {
  switch (op) {
    case '<':
      return '>=';
    case '<=':
      return '>';
    case '>':
      return '<=';
    case '>=':
      return '<';
    default:
      return op;
  }
}

function recordGetRequiredKey(
  getCall: { key: string; defaultExpr?: Expression; callScope: RuleAstScope } | undefined,
  otherExpr: Expression,
  otherLit: string | number | boolean | null | undefined,
  scope: RuleAstScope,
  keys: Set<string>,
): void {
  if (!getCall) return;
  let defVal: string | number | boolean | null | undefined = null;
  if (getCall.defaultExpr) defVal = scalarLiteral(getCall.defaultExpr, getCall.callScope);
  const requiresNonEmpty =
    (typeof otherLit === 'string' && otherLit.length > 0)
    || isRequestMemberChain(otherExpr, scope, ['request', 'auth', 'uid']);
  if ((defVal === null || defVal === '') && requiresNonEmpty) {
    keys.add(getCall.key);
  }
}

function summarizeBinaryComparison(
  e: Extract<Expression, { type: 'binaryOp' }>,
  s: RuleAstScope,
  negated: boolean,
): ConstraintSummary {
  const out = emptySummary();
  if (e.op === '==' || e.op === '!=') {
    const leftLit = scalarLiteral(e.left, s);
    const rightLit = scalarLiteral(e.right, s);
    if (typeof leftLit === 'boolean' || typeof rightLit === 'boolean') {
      let boolVal = false;
      let target = e.left;
      if (typeof leftLit === 'boolean') {
        boolVal = leftLit;
        target = e.right;
      } else if (typeof rightLit === 'boolean') {
        boolVal = rightLit;
        target = e.left;
      }
      const flips = (e.op === '==' && !boolVal) || (e.op === '!=' && boolVal);
      let nextNeg = negated;
      if (flips) nextNeg = !negated;
      return summarizeConstraints(target, s, nextNeg);
    }

    const isPosEq = (e.op === '==' && !negated) || (e.op === '!=' && negated);
    const isPosNeq = (e.op === '!=' && !negated) || (e.op === '==' && negated);
    if (isPosEq) {
      if ((isRequestResource(e.left, s) && rightLit === null) || (isRequestResource(e.right, s) && leftLit === null)) {
        return impossibleSummary();
      }
      if (isRequestResourceProp(e.left, s, 'contentType') && typeof rightLit === 'string') {
        return { impossible: false, contentTypes: [`^${escapeRegexLiteral(rightLit)}$`], requiredKeys: new Set() };
      }
      if (isRequestResourceProp(e.right, s, 'contentType') && typeof leftLit === 'string') {
        return { impossible: false, contentTypes: [`^${escapeRegexLiteral(leftLit)}$`], requiredKeys: new Set() };
      }
      let exactSize: number | undefined;
      if (isRequestResourceProp(e.left, s, 'size')) exactSize = evalNumericExpr(e.right, s);
      else if (isRequestResourceProp(e.right, s, 'size')) exactSize = evalNumericExpr(e.left, s);
      if (exactSize !== undefined && Number.isInteger(exactSize) && exactSize >= 0) {
        return { impossible: false, maxSizeBytes: exactSize, requiredKeys: new Set() };
      }

      const leftKey = incomingMetadataDirectKey(e.left, s);
      if (leftKey !== undefined && rightLit !== null) out.requiredKeys.add(leftKey);
      const rightKey = incomingMetadataDirectKey(e.right, s);
      if (rightKey !== undefined && leftLit !== null) out.requiredKeys.add(rightKey);

      recordGetRequiredKey(incomingMetadataGetCall(e.left, s), e.right, rightLit, s, out.requiredKeys);
      recordGetRequiredKey(incomingMetadataGetCall(e.right, s), e.left, leftLit, s, out.requiredKeys);
      return out;
    }

    if (isPosNeq) {
      const leftKey = incomingMetadataDirectKey(e.left, s);
      if (leftKey !== undefined && rightLit === null) out.requiredKeys.add(leftKey);
      const rightKey = incomingMetadataDirectKey(e.right, s);
      if (rightKey !== undefined && leftLit === null) out.requiredKeys.add(rightKey);
    }
    return out;
  }

  let op = e.op;
  if (negated) op = negateComparisonOp(e.op);
  if (isRequestResourceProp(e.left, s, 'size')) {
    const bound = evalNumericExpr(e.right, s);
    if (bound !== undefined && Number.isFinite(bound)) {
      if (op === '<') return { impossible: false, maxSizeBytes: Math.ceil(bound) - 1, requiredKeys: new Set() };
      if (op === '<=') return { impossible: false, maxSizeBytes: Math.floor(bound), requiredKeys: new Set() };
    }
  }
  if (isRequestResourceProp(e.right, s, 'size')) {
    const bound = evalNumericExpr(e.left, s);
    if (bound !== undefined && Number.isFinite(bound)) {
      if (op === '>') return { impossible: false, maxSizeBytes: Math.ceil(bound) - 1, requiredKeys: new Set() };
      if (op === '>=') return { impossible: false, maxSizeBytes: Math.floor(bound), requiredKeys: new Set() };
    }
  }
  const leftResolved = resolveRuleExpr(e.left, s);
  if (
    leftResolved.expr.type === 'methodCall'
    && leftResolved.expr.method === 'size'
    && (op === '>' || op === '>=')
  ) {
    const key = incomingMetadataDirectKey(leftResolved.expr.object, leftResolved.scope);
    if (key !== undefined) out.requiredKeys.add(key);
  }
  return out;
}

function summarizeConstraints(
  expr: Expression,
  scope: RuleAstScope,
  negated: boolean,
): ConstraintSummary {
  const r = resolveRuleExpr(expr, scope);
  const e = r.expr;
  const s = r.scope;

  if (e.type === 'literal' && typeof e.value === 'boolean') {
    let val = e.value;
    if (negated) val = !val;
    if (val) return emptySummary();
    return impossibleSummary();
  }
  if (e.type === 'unaryOp') {
    if (e.op === '!') return summarizeConstraints(e.operand, s, !negated);
    return emptySummary();
  }
  if (e.type === 'binaryOp') {
    if ((e.op === '&&' && !negated) || (e.op === '||' && negated)) {
      return andSummary(
        summarizeConstraints(e.left, s, negated),
        summarizeConstraints(e.right, s, negated),
      );
    }
    if ((e.op === '||' && !negated) || (e.op === '&&' && negated)) {
      return orSummary(
        summarizeConstraints(e.left, s, negated),
        summarizeConstraints(e.right, s, negated),
      );
    }
    return summarizeBinaryComparison(e, s, negated);
  }
  if (e.type === 'ternary') {
    const posBranch = andSummary(
      summarizeConstraints(e.condition, s, false),
      summarizeConstraints(e.consequent, s, negated),
    );
    const negBranch = andSummary(
      summarizeConstraints(e.condition, s, true),
      summarizeConstraints(e.alternate, s, negated),
    );
    return orSummary(posBranch, negBranch);
  }
  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (!inlined) return emptySummary();
    return summarizeConstraints(inlined.expr, inlined.scope, negated);
  }
  if (negated) return emptySummary();

  if (e.type === 'methodCall') {
    if (e.method === 'matches' && isRequestResourceProp(e.object, s, 'contentType') && e.args[0]) {
      const pattern = scalarLiteral(e.args[0], s);
      if (typeof pattern === 'string') {
        return { impossible: false, contentTypes: [pattern], requiredKeys: new Set() };
      }
    }
    if ((e.method === 'hasAll' || e.method === 'hasAny') && isRequestResourceMetadataKeys(e.object, s) && e.args[0]) {
      const elems = stringListElements(e.args[0], s);
      if (elems && (e.method === 'hasAll' || elems.length === 1)) {
        return { impossible: false, requiredKeys: new Set(elems) };
      }
    }
    const metaKey = incomingMetadataDirectKey(e.object, s);
    if (metaKey !== undefined) {
      return { impossible: false, requiredKeys: new Set([metaKey]) };
    }
    return emptySummary();
  }

  if (e.type === 'inExpr') {
    const elemStr = scalarLiteral(e.element, s);
    if (
      typeof elemStr === 'string'
      && (isRequestResourceMetadata(e.collection, s) || isRequestResourceMetadataKeys(e.collection, s))
    ) {
      return { impossible: false, requiredKeys: new Set([elemStr]) };
    }
    if (isRequestResourceProp(e.element, s, 'contentType')) {
      const mimes = stringListElements(e.collection, s);
      if (mimes && mimes.length > 0) {
        return {
          impossible: false,
          contentTypes: mimes.map((m) => `^${escapeRegexLiteral(m)}$`),
          requiredKeys: new Set(),
        };
      }
    }
    const directKey = incomingMetadataDirectKey(e.element, s);
    if (directKey !== undefined) {
      return { impossible: false, requiredKeys: new Set([directKey]) };
    }
    return emptySummary();
  }

  if (e.type === 'isExpr' && e.typeName !== 'null') {
    const directKey = incomingMetadataDirectKey(e.value, s);
    if (directKey !== undefined) {
      return { impossible: false, requiredKeys: new Set([directKey]) };
    }
  }
  return emptySummary();
}

const MAX_STORAGE_DNF_ARMS = 16;

interface ConstraintArm {
  readonly contentTypeConjuncts: readonly (readonly string[])[];
  readonly maxSizeBytes?: number;
  readonly requiredKeys: ReadonlySet<string>;
}

function armFromSummary(summary: ConstraintSummary): ConstraintArm[] {
  if (summary.impossible) return [];
  const conjuncts: (readonly string[])[] = [];
  if (summary.contentTypes && summary.contentTypes.length > 0) {
    conjuncts.push([...summary.contentTypes]);
  }
  const arm: {
    contentTypeConjuncts: readonly (readonly string[])[];
    maxSizeBytes?: number;
    requiredKeys: ReadonlySet<string>;
  } = {
    contentTypeConjuncts: conjuncts,
    requiredKeys: new Set(summary.requiredKeys),
  };
  if (summary.maxSizeBytes !== undefined) {
    arm.maxSizeBytes = summary.maxSizeBytes;
  }
  return [arm];
}

function armSignature(arm: ConstraintArm): string {
  const ct = arm.contentTypeConjuncts.map((c) => c.join('||')).join('&&');
  const sz = arm.maxSizeBytes !== undefined ? String(arm.maxSizeBytes) : '';
  const keys = [...arm.requiredKeys].sort().join(',');
  return `${ct}#${sz}#${keys}`;
}

function dedupeArms(arms: readonly ConstraintArm[]): ConstraintArm[] {
  const seen = new Set<string>();
  const out: ConstraintArm[] = [];
  for (const arm of arms) {
    const sig = armSignature(arm);
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(arm);
    }
  }
  return out;
}

function collapseArms(arms: readonly ConstraintArm[]): ConstraintArm {
  const first = arms[0]!;
  let allHaveCt = first.contentTypeConjuncts.length > 0;
  let allHaveSize = first.maxSizeBytes !== undefined;
  let maxSize = first.maxSizeBytes ?? 0;
  const sharedKeys = new Set<string>(first.requiredKeys);
  const unionDisjuncts: string[] = [];

  for (const arm of arms) {
    if (arm.contentTypeConjuncts.length === 0) {
      allHaveCt = false;
    } else if (allHaveCt) {
      const formatted = arm.contentTypeConjuncts.map((d) => formatContentTypePatterns(d));
      if (formatted.length === 1) {
        unionDisjuncts.push(formatted[0]!);
      } else {
        let acc: readonly string[] = [formatted[0]!];
        for (let i = 1; i < formatted.length; i += 1) {
          acc = conjoinContentTypePatterns(acc, [formatted[i]!]);
        }
        unionDisjuncts.push(...acc);
      }
    }
    if (arm.maxSizeBytes === undefined) {
      allHaveSize = false;
    } else if (arm.maxSizeBytes > maxSize) {
      maxSize = arm.maxSizeBytes;
    }
    for (const k of [...sharedKeys]) {
      if (!arm.requiredKeys.has(k)) sharedKeys.delete(k);
    }
  }

  const out: {
    contentTypeConjuncts: readonly (readonly string[])[];
    maxSizeBytes?: number;
    requiredKeys: ReadonlySet<string>;
  } = {
    contentTypeConjuncts:
      allHaveCt && unionDisjuncts.length > 0 ? [[...new Set(unionDisjuncts)]] : [],
    requiredKeys: sharedKeys,
  };
  if (allHaveSize) out.maxSizeBytes = maxSize;
  return out;
}

function andConstraintArms(
  left: readonly ConstraintArm[],
  right: readonly ConstraintArm[],
): ConstraintArm[] {
  if (left.length === 0 || right.length === 0) return [];
  const lhs = left.length * right.length > MAX_STORAGE_DNF_ARMS ? [collapseArms(left)] : left;
  const rhs =
    lhs.length * right.length > MAX_STORAGE_DNF_ARMS ? [collapseArms(right)] : right;

  const combined: ConstraintArm[] = [];
  for (const a of lhs) {
    for (const b of rhs) {
      const conjuncts: (readonly string[])[] = [...a.contentTypeConjuncts];
      for (const c of b.contentTypeConjuncts) {
        const sig = c.join('||');
        if (!conjuncts.some((existing) => existing.join('||') === sig)) {
          conjuncts.push(c);
        }
      }
      let maxSizeBytes: number | undefined;
      if (a.maxSizeBytes !== undefined && b.maxSizeBytes !== undefined) {
        maxSizeBytes = Math.min(a.maxSizeBytes, b.maxSizeBytes);
      } else if (a.maxSizeBytes !== undefined) {
        maxSizeBytes = a.maxSizeBytes;
      } else if (b.maxSizeBytes !== undefined) {
        maxSizeBytes = b.maxSizeBytes;
      }
      const requiredKeys = new Set<string>([...a.requiredKeys, ...b.requiredKeys]);
      const arm: {
        contentTypeConjuncts: readonly (readonly string[])[];
        maxSizeBytes?: number;
        requiredKeys: ReadonlySet<string>;
      } = {
        contentTypeConjuncts: conjuncts,
        requiredKeys,
      };
      if (maxSizeBytes !== undefined) arm.maxSizeBytes = maxSizeBytes;
      combined.push(arm);
    }
  }
  return dedupeArms(combined);
}

function orConstraintArms(
  left: readonly ConstraintArm[],
  right: readonly ConstraintArm[],
): ConstraintArm[] {
  if (left.length === 0) return [...right];
  if (right.length === 0) return [...left];
  const merged = dedupeArms([...left, ...right]);
  if (merged.length > MAX_STORAGE_DNF_ARMS) {
    return [collapseArms(merged)];
  }
  return merged;
}

function summarizeConstraintArms(
  expr: Expression,
  scope: RuleAstScope,
  negated: boolean,
): ConstraintArm[] {
  const r = resolveRuleExpr(expr, scope);
  const e = r.expr;
  const s = r.scope;

  if (e.type === 'literal' && typeof e.value === 'boolean') {
    const val = negated ? !e.value : e.value;
    return val ? [{ contentTypeConjuncts: [], requiredKeys: new Set() }] : [];
  }
  if (e.type === 'unaryOp') {
    if (e.op === '!') return summarizeConstraintArms(e.operand, s, !negated);
    return [{ contentTypeConjuncts: [], requiredKeys: new Set() }];
  }
  if (e.type === 'binaryOp') {
    if ((e.op === '&&' && !negated) || (e.op === '||' && negated)) {
      return andConstraintArms(
        summarizeConstraintArms(e.left, s, negated),
        summarizeConstraintArms(e.right, s, negated),
      );
    }
    if ((e.op === '||' && !negated) || (e.op === '&&' && negated)) {
      return orConstraintArms(
        summarizeConstraintArms(e.left, s, negated),
        summarizeConstraintArms(e.right, s, negated),
      );
    }
    if (e.op === '==' || e.op === '!=') {
      const leftLit = scalarLiteral(e.left, s);
      const rightLit = scalarLiteral(e.right, s);
      if (typeof leftLit === 'boolean' || typeof rightLit === 'boolean') {
        const boolVal = typeof leftLit === 'boolean' ? leftLit : (rightLit as boolean);
        const target = typeof leftLit === 'boolean' ? e.right : e.left;
        const flips = (e.op === '==' && !boolVal) || (e.op === '!=' && boolVal);
        return summarizeConstraintArms(target, s, flips ? !negated : negated);
      }
    }
    return armFromSummary(summarizeBinaryComparison(e, s, negated));
  }
  if (e.type === 'ternary') {
    const posBranch = andConstraintArms(
      summarizeConstraintArms(e.condition, s, false),
      summarizeConstraintArms(e.consequent, s, negated),
    );
    const negBranch = andConstraintArms(
      summarizeConstraintArms(e.condition, s, true),
      summarizeConstraintArms(e.alternate, s, negated),
    );
    return orConstraintArms(posBranch, negBranch);
  }
  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (!inlined) return [{ contentTypeConjuncts: [], requiredKeys: new Set() }];
    return summarizeConstraintArms(inlined.expr, inlined.scope, negated);
  }
  return armFromSummary(summarizeConstraints(expr, scope, negated));
}

function formatConjunctsPattern(
  conjuncts: readonly (readonly string[])[],
): string | undefined {
  if (conjuncts.length === 0) return undefined;
  let acc: readonly string[] = conjuncts[0]!;
  for (let i = 1; i < conjuncts.length; i += 1) {
    acc = conjoinContentTypePatterns(acc, conjuncts[i]!);
  }
  return formatContentTypePatterns(acc);
}

export function extractStorageMetadataConstraintArms(
  condition: Expression,
  scope: RuleAstScope,
  ownerConditions: readonly OwnerCondition[],
): readonly StorageMetadataConstraintArm[] | undefined {
  const arms = summarizeConstraintArms(condition, scope, false);
  if (arms.length === 0) return undefined;
  const incomingOwner = ownerConditions.find((c) => c.kind === 'incomingField');
  const storedOwner = ownerConditions.find((c) => c.kind === 'storedField');
  const ownerMetadataKey = incomingOwner?.field ?? storedOwner?.field;

  const formattedArms: StorageMetadataConstraintArm[] = arms.map((arm) => {
    const out: {
      contentTypePattern?: string;
      contentTypeConjuncts?: readonly (readonly string[])[];
      maxSizeBytes?: number;
      requiredCustomMetadataKeys?: readonly string[];
      ownerMetadataKey?: string;
    } = {};
    if (arm.contentTypeConjuncts.length > 0) {
      const pat = formatConjunctsPattern(arm.contentTypeConjuncts);
      if (pat !== undefined) out.contentTypePattern = pat;
      out.contentTypeConjuncts = arm.contentTypeConjuncts.map((c) => [...c]);
    }
    if (arm.maxSizeBytes !== undefined) {
      out.maxSizeBytes = arm.maxSizeBytes;
    }
    if (arm.requiredKeys.size > 0) {
      out.requiredCustomMetadataKeys = [...arm.requiredKeys].sort();
    }
    if (ownerMetadataKey !== undefined) {
      out.ownerMetadataKey = ownerMetadataKey;
    }
    return out;
  });

  const anyConstrained = formattedArms.some(
    (a) =>
      a.contentTypePattern !== undefined
      || a.maxSizeBytes !== undefined
      || a.requiredCustomMetadataKeys !== undefined
      || a.ownerMetadataKey !== undefined,
  );
  if (!anyConstrained) return undefined;
  return formattedArms;
}

export function extractStorageMetadataConstraint(
  condition: Expression,
  scope: RuleAstScope,
  ownerConditions: readonly OwnerCondition[],
): StorageMetadataConstraint | undefined {
  const summary = summarizeConstraints(condition, scope, false);
  const incomingOwner = ownerConditions.find((c) => c.kind === 'incomingField');
  const storedOwner = ownerConditions.find((c) => c.kind === 'storedField');
  const ownerMetadataKey = incomingOwner?.field ?? storedOwner?.field;

  const out: {
    contentTypePattern?: string;
    maxSizeBytes?: number;
    requiredCustomMetadataKeys?: readonly string[];
    ownerMetadataKey?: string;
  } = {};

  if (!summary.impossible) {
    if (summary.contentTypes && summary.contentTypes.length > 0) {
      out.contentTypePattern = formatContentTypePatterns(summary.contentTypes);
    }
    if (summary.maxSizeBytes !== undefined) {
      out.maxSizeBytes = summary.maxSizeBytes;
    }
    if (summary.requiredKeys.size > 0) {
      out.requiredCustomMetadataKeys = [...summary.requiredKeys].sort();
    }
  }
  if (ownerMetadataKey !== undefined) {
    out.ownerMetadataKey = ownerMetadataKey;
  }

  if (
    out.contentTypePattern === undefined
    && out.maxSizeBytes === undefined
    && out.requiredCustomMetadataKeys === undefined
    && out.ownerMetadataKey === undefined
  ) {
    return undefined;
  }
  return out;
}

export function extractStorageAllowValueHints(
  condition: Expression,
  scope: RuleAstScope,
  scopedObjectPath: string,
): ValueHint[] {
  const out: ValueHint[] = [];
  const seen = new Set<string>();
  const addHint = (key: string | undefined, lit: string | number | boolean | null | undefined): void => {
    if (key === undefined || lit === undefined || lit === null) return;
    const dedupeKey = `${key}|${typeof lit}:${String(lit)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push({ service: 'storage', path: scopedObjectPath, field: key, value: lit });
  };

  const walk = (expr: Expression, s: RuleAstScope, negated: boolean): void => {
    const { expr: e, scope: rs } = resolveRuleExpr(expr, s);
    if (e.type === 'unaryOp') {
      let nextNeg = negated;
      if (e.op === '!') nextNeg = !negated;
      walk(e.operand, rs, nextNeg);
      return;
    }
    if (e.type === 'binaryOp') {
      if (e.op === '==' || e.op === '!=') {
        const leftLit = scalarLiteral(e.left, rs);
        const rightLit = scalarLiteral(e.right, rs);
        if (typeof leftLit === 'boolean' || typeof rightLit === 'boolean') {
          let boolVal = false;
          let target = e.left;
          if (typeof leftLit === 'boolean') {
            boolVal = leftLit;
            target = e.right;
          } else if (typeof rightLit === 'boolean') {
            boolVal = rightLit;
            target = e.left;
          }
          const flips = (e.op === '==' && !boolVal) || (e.op === '!=' && boolVal);
          let nextNeg = negated;
          if (flips) nextNeg = !negated;
          walk(target, rs, nextNeg);
          return;
        }
        if ((e.op === '==' && !negated) || (e.op === '!=' && negated)) {
          addHint(incomingMetadataDirectKey(e.left, rs), rightLit);
          addHint(incomingMetadataDirectKey(e.right, rs), leftLit);
        }
        return;
      }
      walk(e.left, rs, negated);
      walk(e.right, rs, negated);
      return;
    }
    if (e.type === 'ternary') {
      const rawCons = scalarLiteral(e.consequent, rs);
      const rawAlt = scalarLiteral(e.alternate, rs);
      const plan = classifyTernaryBranches(
        typeof rawCons === 'boolean' ? rawCons : undefined,
        typeof rawAlt === 'boolean' ? rawAlt : undefined,
        negated,
      );
      if (plan.conditionNegated === undefined) return;
      walk(e.condition, rs, plan.conditionNegated);
      if (plan.visitConsequent) walk(e.consequent, rs, negated);
      if (plan.visitAlternate) walk(e.alternate, rs, negated);
      return;
    }
    if (e.type === 'functionCall') {
      const inlined = inlineRuleCall(e, rs);
      if (inlined) walk(inlined.expr, inlined.scope, negated);
    }
  };

  walk(condition, scope, false);
  return out;
}
