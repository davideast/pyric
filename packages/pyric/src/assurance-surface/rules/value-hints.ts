/**
 * Literal values the rules expect a written field to have
 * (`newData.val() == 'design'`, `newData.child('state').val() === 'online'`,
 * `request.resource.data.status == 'open'`), so synthesized probe payloads
 * pass validation and probes test authorization instead.
 */
import type { Expression, FunctionDef, MatchBlock } from '../../rules/internal/index.js';
import { parseRtdbExpressionTree, type RtdbExpressionTree } from '../../rules/internal/rtdb.js';
import { extractServiceHeader } from '../../sandbox/internal/resource-pattern-header.js';
import type { AccessService } from '../code/types.js';
import {
  classifyTernaryBranches,
  formatMatchSegment,
  inlineRuleCall,
  isRequestMemberChain,
  parseRulesAstWithMultiMatch,
  resolveRuleExpr,
  type RuleAstScope,
} from './rules-ast-utils.js';

/** A hinted value for a field at a rule path. `field` is `.` for the node's own value. */
export interface ValueHint {
  service: AccessService;
  path: string;
  field: string;
  value: string | number | boolean;
  wildcardBucket?: boolean;
}

/** Hints from a single parsed RTDB rule expression at `path`. */
export function rtdbExpressionValueHints(tree: RtdbExpressionTree, path: string): ValueHint[] {
  const out: ValueHint[] = [];
  collectRtdb(tree, path, false, out);
  return out;
}

/** Hints from RTDB rules: every positive `newData...val() == literal` comparison. */
export function rtdbValueHints(rulesJson: unknown): ValueHint[] {
  const out: ValueHint[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === '.validate' || key === '.write') && typeof value === 'string') {
        const parsed = parseRtdbExpressionTree(value);
        if (parsed.ok) collectRtdb(parsed.tree, path.join('/'), false, out);
      } else if (!key.startsWith('.')) {
        walk(value, [...path, key]);
      }
    }
  };
  walk((rulesJson as { rules?: unknown } | null)?.rules, []);
  return out;
}

function newDataField(t: RtdbExpressionTree): string | undefined {
  if (t.type !== 'call' || t.method !== 'val') return undefined;
  const segs: string[] = [];
  let cur = t.receiver;
  while (cur.type === 'call' && cur.method === 'child' && cur.args[0]?.type === 'string') {
    segs.unshift(cur.args[0].value);
    cur = cur.receiver;
  }
  if (cur.type === 'identifier' && cur.name === 'newData') {
    if (segs.length > 0) return segs.join('/');
    return '.';
  }
  return undefined;
}

function rtdbLiteral(t: RtdbExpressionTree): string | number | boolean | undefined {
  if (t.type === 'string') return t.value;
  if (t.type === 'boolean') return t.value;
  if (t.type === 'number') return Number(t.raw);
  return undefined;
}

function rtdbBooleanLiteral(t: RtdbExpressionTree): boolean | undefined {
  if (t.type === 'boolean') return t.value;
  return undefined;
}

function collectRtdb(t: RtdbExpressionTree, path: string, negated: boolean, out: ValueHint[]): void {
  if (t.type === 'unary') {
    if (t.operator === '!') {
      collectRtdb(t.argument, path, !negated, out);
    } else {
      collectRtdb(t.argument, path, negated, out);
    }
    return;
  }

  if (t.type === 'binary') {
    const isEq = t.operator === '==' || t.operator === '===';
    const isNeq = t.operator === '!=' || t.operator === '!==';
    if (isEq || isNeq) {
      const leftField = newDataField(t.left);
      const field = leftField ?? newDataField(t.right);
      if (field) {
        let other = t.left;
        if (leftField) other = t.right;
        const lit = rtdbLiteral(other);
        const isPositiveEq = (isEq && !negated) || (isNeq && negated);
        if (lit !== undefined && isPositiveEq) {
          out.push({ service: 'rtdb', path, field, value: lit });
        }
        return;
      }
      if (t.left.type === 'boolean' || t.right.type === 'boolean') {
        let boolVal = false;
        let target = t.left;
        if (t.left.type === 'boolean') {
          boolVal = t.left.value;
          target = t.right;
        } else if (t.right.type === 'boolean') {
          boolVal = t.right.value;
          target = t.left;
        }
        const flips = (isEq && !boolVal) || (isNeq && boolVal);
        let nextNegated = negated;
        if (flips) nextNegated = !negated;
        collectRtdb(target, path, nextNegated, out);
        return;
      }
      return;
    }
    collectRtdb(t.left, path, negated, out);
    collectRtdb(t.right, path, negated, out);
    return;
  }

  if (t.type === 'ternary') {
    const plan = classifyTernaryBranches(
      rtdbBooleanLiteral(t.consequent),
      rtdbBooleanLiteral(t.alternate),
      negated,
    );
    if (plan.conditionNegated === undefined) return;
    collectRtdb(t.test, path, plan.conditionNegated, out);
    if (plan.visitConsequent) collectRtdb(t.consequent, path, negated, out);
    if (plan.visitAlternate) collectRtdb(t.alternate, path, negated, out);
  }
}

/** Hints from a single Firestore `allow` condition at `docPath`. */
export function firestoreAllowValueHints(
  condition: Expression,
  functions: readonly (readonly FunctionDef[])[],
  docPath: string,
  wildcards: ReadonlySet<string> = new Set(),
): ValueHint[] {
  const out: ValueHint[] = [];
  const scope: RuleAstScope = {
    vars: new Map(),
    functions,
    wildcards,
    depth: 0,
  };
  collectFs(condition, scope, docPath, false, out);
  return out;
}

/** Hints from Firestore rules: positive `request.resource.data.x == literal` checks. */
export function firestoreValueHints(source: string): ValueHint[] {
  const services = parseRulesAstWithMultiMatch(source);
  const out: ValueHint[] = [];

  const walk = (
    match: MatchBlock,
    parent: readonly string[],
    functions: readonly (readonly FunctionDef[])[],
    wildcards: ReadonlySet<string>,
  ): void => {
    const path = [...parent];
    const nextWildcards = new Set(wildcards);
    for (const seg of match.path.segments) {
      path.push(formatMatchSegment(seg));
      if (seg.type !== 'literal') nextWildcards.add(seg.name);
    }
    let docPath = path;
    if (path[0] === 'databases') docPath = path.slice(3);
    const scopeFns = [...functions, match.functions];
    const header = extractServiceHeader('firestore', `/${path.join('/')}`);
    const hasValidHeader = header.headerKind === 'concrete' || header.headerKind === 'wildcard';
    if (hasValidHeader && docPath.length > 0) {
      for (const allow of match.allows) {
        const scope: RuleAstScope = {
          vars: new Map(),
          functions: scopeFns,
          wildcards: nextWildcards,
          depth: 0,
        };
        collectFs(allow.condition, scope, docPath.join('/'), false, out);
      }
    }
    for (const child of match.children) walk(child, path, scopeFns, nextWildcards);
  };

  for (const service of services) {
    if (!/firestore/.test(service.name)) continue;
    for (const topMatch of service.matches) {
      walk(topMatch, [], service.functions, new Set());
    }
  }
  return out;
}

function incomingField(expr: Expression, scope: RuleAstScope): string | undefined {
  const fields: string[] = [];
  let cur = resolveRuleExpr(expr, scope);
  for (let i = 0; i < 16; i++) {
    const e = cur.expr;
    if (e.type === 'memberAccess') {
      if (e.property === 'data') {
        if (isRequestMemberChain(e.object, cur.scope, ['request', 'resource'])) {
          if (fields.length === 0) return undefined;
          return fields.reverse().join('.');
        }
      }
      fields.push(e.property);
      cur = resolveRuleExpr(e.object, cur.scope);
    } else if (e.type === 'bracketAccess' && e.index.type === 'literal' && typeof e.index.value === 'string') {
      fields.push(e.index.value);
      cur = resolveRuleExpr(e.object, cur.scope);
    } else {
      return undefined;
    }
  }
  return undefined;
}

function fsScalarLiteral(expr: Expression, scope: RuleAstScope): string | number | boolean | undefined {
  const resolved = resolveRuleExpr(expr, scope).expr;
  if (resolved.type !== 'literal') return undefined;
  if (typeof resolved.value === 'string' || typeof resolved.value === 'number' || typeof resolved.value === 'boolean') {
    return resolved.value;
  }
  return undefined;
}

function collectFs(expr: Expression, scope: RuleAstScope, path: string, negated: boolean, out: ValueHint[]): void {
  const { expr: e, scope: s } = resolveRuleExpr(expr, scope);
  if (e.type === 'unaryOp') {
    let nextNegated = negated;
    if (e.op === '!') nextNegated = !negated;
    collectFs(e.operand, s, path, nextNegated, out);
    return;
  }

  if (e.type === 'binaryOp') {
    if (e.op === '==' || e.op === '!=') {
      const leftField = incomingField(e.left, s);
      const field = leftField ?? incomingField(e.right, s);
      if (field) {
        let other = e.left;
        if (leftField) other = e.right;
        const lit = fsScalarLiteral(other, s);
        const isPositiveEq = (e.op === '==' && !negated) || (e.op === '!=' && negated);
        if (lit !== undefined && isPositiveEq) {
          out.push({ service: 'firestore', path, field, value: lit });
        }
        return;
      }
      const leftLit = fsScalarLiteral(e.left, s);
      const rightLit = fsScalarLiteral(e.right, s);
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
        let nextNegated = negated;
        if (flips) nextNegated = !negated;
        collectFs(target, s, path, nextNegated, out);
        return;
      }
      return;
    }
    collectFs(e.left, s, path, negated, out);
    collectFs(e.right, s, path, negated, out);
    return;
  }

  if (e.type === 'ternary') {
    const rawCons = fsScalarLiteral(e.consequent, s);
    const rawAlt = fsScalarLiteral(e.alternate, s);
    const plan = classifyTernaryBranches(
      typeof rawCons === 'boolean' ? rawCons : undefined,
      typeof rawAlt === 'boolean' ? rawAlt : undefined,
      negated,
    );
    if (plan.conditionNegated === undefined) return;
    collectFs(e.condition, s, path, plan.conditionNegated, out);
    if (plan.visitConsequent) collectFs(e.consequent, s, path, negated, out);
    if (plan.visitAlternate) collectFs(e.alternate, s, path, negated, out);
    return;
  }

  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (!inlined) return;
    collectFs(inlined.expr, inlined.scope, path, negated, out);
  }
}
