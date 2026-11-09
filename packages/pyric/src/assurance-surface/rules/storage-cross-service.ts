/**
 * Cross-service Firestore lookup (`firestore.get(...)` / `firestore.exists(...)`)
 * extraction from Cloud Storage security rules.
 *
 * Converts `$(...)` path interpolations into `ResourcePattern` wildcard segments
 * (`{auth.uid}`, `{auth.token.<claim>}`, `{<varName>}`), extracts accessed
 * `.data.<field>` paths and positive scalar `expectedValue`s, and excludes
 * negated ban-list checks (`!firestore.exists(...)`, `firestore.get(...) == null`).
 */
import type { Expression } from '../../rules/internal/index.js';
import { extractServiceHeader } from '../../sandbox/internal/resource-pattern-header.js';
import {
  parseResourcePattern,
  renderResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type { CrossServiceLookup } from './rule-surface.js';
import {
  classifyTernaryBranches,
  flipRelationalSides,
  inlineRuleCall,
  isRelationalOp,
  isRequestMemberChain,
  negateRelationalOp,
  resolveRuleExpr,
  satisfyingRelationalValue,
  type RelationalOp,
  type RuleAstScope,
} from './rules-ast-utils.js';
import { evalNumericExpr, isUnshadowedIdent, scalarLiteral } from './storage-constraints.js';

function parseFirestoreLookupPattern(
  argExpr: Expression,
  scope: RuleAstScope,
): ResourcePattern | undefined {
  const resolved = resolveRuleExpr(argExpr, scope);
  if (resolved.expr.type !== 'pathLiteral') return undefined;
  const parts: string[] = [];
  for (const seg of resolved.expr.segments) {
    if (typeof seg === 'string') {
      parts.push(...seg.split('/').filter((chunk) => chunk.length > 0));
      continue;
    }
    const sr = resolveRuleExpr(seg, resolved.scope);
    if (isRequestMemberChain(sr.expr, sr.scope, ['request', 'auth', 'uid'])) {
      parts.push('{auth.uid}');
      continue;
    }
    if (
      sr.expr.type === 'memberAccess'
      && isRequestMemberChain(sr.expr.object, sr.scope, ['request', 'auth', 'token'])
    ) {
      parts.push(`{auth.token.${sr.expr.property}}`);
      continue;
    }
    if (sr.expr.type === 'identifier') {
      parts.push(`{${sr.expr.name}}`);
      continue;
    }
    if (
      sr.expr.type === 'literal'
      && (typeof sr.expr.value === 'string' || typeof sr.expr.value === 'number')
    ) {
      parts.push(String(sr.expr.value));
      continue;
    }
    parts.push('{*}');
  }
  const rawPath = `/${parts.join('/')}`;
  const header = extractServiceHeader('firestore', rawPath);
  if (header.headerKind !== 'concrete' || header.headerResourceId !== '(default)') {
    return undefined;
  }
  const pattern = parseResourcePattern('firestore', rawPath);
  if (pattern.resourceId !== '(default)' || pattern.segments.length === 0) {
    return undefined;
  }
  return pattern;
}

function directFirestoreLookup(
  expr: Expression,
  scope: RuleAstScope,
): { kind: 'get' | 'exists'; pattern: ResourcePattern } | undefined {
  const r = resolveRuleExpr(expr, scope);
  if (r.expr.type !== 'methodCall' || !r.expr.args[0]) return undefined;
  if (r.expr.method !== 'get' && r.expr.method !== 'exists') return undefined;
  if (!isUnshadowedIdent(r.expr.object, r.scope, 'firestore')) return undefined;
  const pattern = parseFirestoreLookupPattern(r.expr.args[0], r.scope);
  if (!pattern) return undefined;
  return { kind: r.expr.method, pattern };
}

function firestoreGetFieldRead(
  expr: Expression,
  scope: RuleAstScope,
): { pattern: ResourcePattern; field: string } | undefined {
  const fields: string[] = [];
  let cur = resolveRuleExpr(expr, scope);
  for (let i = 0; i < 32; i += 1) {
    const e = cur.expr;
    if (e.type === 'memberAccess') {
      if (e.property === 'data') {
        if (fields.length === 0) return undefined;
        const lookup = directFirestoreLookup(e.object, cur.scope);
        if (lookup && lookup.kind === 'get') {
          return { pattern: lookup.pattern, field: fields.reverse().join('.') };
        }
        return undefined;
      }
      fields.push(e.property);
      cur = resolveRuleExpr(e.object, cur.scope);
      continue;
    }
    if (e.type === 'bracketAccess') {
      const idx = scalarLiteral(e.index, cur.scope);
      if (typeof idx !== 'string') return undefined;
      fields.push(idx);
      cur = resolveRuleExpr(e.object, cur.scope);
      continue;
    }
    if (e.type === 'methodCall' && e.method === 'get' && e.args[0]) {
      const key = scalarLiteral(e.args[0], cur.scope);
      if (typeof key !== 'string') return undefined;
      fields.push(key);
      cur = resolveRuleExpr(e.object, cur.scope);
      continue;
    }
    return undefined;
  }
  return undefined;
}

function nonCollidingScalarValue(lit: string | number | boolean): string | number | boolean {
  if (typeof lit === 'boolean') return !lit;
  if (typeof lit === 'number') return lit + 1;
  if (lit === 'active') return 'ok';
  return 'active';
}

function buildFieldEqualityLookup(
  fieldRead: { pattern: ResourcePattern; field: string },
  otherExpr: Expression,
  otherLit: string | number | boolean | null | undefined,
  scope: RuleAstScope,
  isPosEq: boolean,
  isPosNeq: boolean,
): CrossServiceLookup {
  const entry: {
    targetService: 'firestore';
    kind: 'get';
    pattern: ResourcePattern;
    field: string;
    expectedValue?: string | number | boolean;
    expectedAuth?: 'uid' | 'uid-list' | 'uid-not-in-list';
  } = {
    targetService: 'firestore',
    kind: 'get',
    pattern: fieldRead.pattern,
    field: fieldRead.field,
  };
  if (isPosEq && otherLit !== undefined && otherLit !== null) {
    entry.expectedValue = otherLit;
  } else if (isPosNeq && otherLit !== undefined && otherLit !== null) {
    entry.expectedValue = nonCollidingScalarValue(otherLit);
  }
  const otherResolved = resolveRuleExpr(otherExpr, scope);
  if (
    isPosEq
    && isRequestMemberChain(otherResolved.expr, otherResolved.scope, ['request', 'auth', 'uid'])
  ) {
    entry.expectedAuth = 'uid';
  }
  return entry;
}

function collectCrossServiceReads(
  expr: Expression,
  scope: RuleAstScope,
  negated: boolean,
  rawOut: CrossServiceLookup[],
): void {
  const r = resolveRuleExpr(expr, scope);
  const e = r.expr;
  const s = r.scope;

  if (e.type === 'unaryOp') {
    let nextNeg = negated;
    if (e.op === '!') nextNeg = !negated;
    collectCrossServiceReads(e.operand, s, nextNeg, rawOut);
    return;
  }

  if (e.type === 'binaryOp') {
    if (isRelationalOp(e.op)) {
      const leftField = firestoreGetFieldRead(e.left, s);
      const rightField = firestoreGetFieldRead(e.right, s);
      if (leftField && !rightField) {
        const bound = evalNumericExpr(e.right, s);
        if (bound !== undefined) {
          let effOp: RelationalOp = e.op;
          if (negated) effOp = negateRelationalOp(effOp);
          rawOut.push({
            targetService: 'firestore',
            kind: 'get',
            pattern: leftField.pattern,
            field: leftField.field,
            expectedValue: satisfyingRelationalValue(effOp, bound),
            comparisonOp: effOp,
          });
          collectCrossServiceReads(e.right, s, false, rawOut);
          return;
        }
      } else if (rightField && !leftField) {
        const bound = evalNumericExpr(e.left, s);
        if (bound !== undefined) {
          let effOp = flipRelationalSides(e.op);
          if (negated) effOp = negateRelationalOp(effOp);
          rawOut.push({
            targetService: 'firestore',
            kind: 'get',
            pattern: rightField.pattern,
            field: rightField.field,
            expectedValue: satisfyingRelationalValue(effOp, bound),
            comparisonOp: effOp,
          });
          collectCrossServiceReads(e.left, s, false, rawOut);
          return;
        }
      }
    }
    if (e.op === '==' || e.op === '!=') {
      const leftLit = scalarLiteral(e.left, s);
      const rightLit = scalarLiteral(e.right, s);
      const isPosEq = (e.op === '==' && !negated) || (e.op === '!=' && negated);
      const isPosNeq = (e.op === '!=' && !negated) || (e.op === '==' && negated);
      const leftField = firestoreGetFieldRead(e.left, s);
      const rightField = firestoreGetFieldRead(e.right, s);
      if (leftField) {
        rawOut.push(buildFieldEqualityLookup(leftField, e.right, rightLit, s, isPosEq, isPosNeq));
        collectCrossServiceReads(e.right, s, false, rawOut);
        return;
      }
      if (rightField) {
        rawOut.push(buildFieldEqualityLookup(rightField, e.left, leftLit, s, isPosEq, isPosNeq));
        collectCrossServiceReads(e.left, s, false, rawOut);
        return;
      }

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
        collectCrossServiceReads(target, s, nextNeg, rawOut);
        return;
      }

      const leftDirect = directFirestoreLookup(e.left, s);
      if (leftDirect && leftDirect.kind === 'get' && rightLit === null) {
        if (isPosNeq) rawOut.push({ targetService: 'firestore', kind: 'get', pattern: leftDirect.pattern });
        return;
      }
      const rightDirect = directFirestoreLookup(e.right, s);
      if (rightDirect && rightDirect.kind === 'get' && leftLit === null) {
        if (isPosNeq) rawOut.push({ targetService: 'firestore', kind: 'get', pattern: rightDirect.pattern });
        return;
      }
    }
    collectCrossServiceReads(e.left, s, negated, rawOut);
    collectCrossServiceReads(e.right, s, negated, rawOut);
    return;
  }

  if (e.type === 'ternary') {
    const rawCons = scalarLiteral(e.consequent, s);
    const rawAlt = scalarLiteral(e.alternate, s);
    const plan = classifyTernaryBranches(
      typeof rawCons === 'boolean' ? rawCons : undefined,
      typeof rawAlt === 'boolean' ? rawAlt : undefined,
      negated,
    );
    if (plan.conditionNegated === undefined) return;
    collectCrossServiceReads(e.condition, s, plan.conditionNegated, rawOut);
    if (plan.visitConsequent) collectCrossServiceReads(e.consequent, s, negated, rawOut);
    if (plan.visitAlternate) collectCrossServiceReads(e.alternate, s, negated, rawOut);
    return;
  }

  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (inlined) collectCrossServiceReads(inlined.expr, inlined.scope, negated, rawOut);
    return;
  }

  const fieldRead = firestoreGetFieldRead(e, s);
  if (fieldRead) {
    const entry: {
      targetService: 'firestore';
      kind: 'get';
      pattern: ResourcePattern;
      field: string;
      expectedValue?: boolean;
    } = {
      targetService: 'firestore',
      kind: 'get',
      pattern: fieldRead.pattern,
      field: fieldRead.field,
    };
    if (negated) entry.expectedValue = false;
    rawOut.push(entry);
    return;
  }

  const direct = directFirestoreLookup(e, s);
  if (direct) {
    if (direct.kind === 'exists' && negated) return;
    rawOut.push({ targetService: 'firestore', kind: direct.kind, pattern: direct.pattern });
    return;
  }

  if (e.type === 'methodCall') {
    if ((e.method === 'hasAny' || e.method === 'hasAll') && e.args[0]) {
      const objField = firestoreGetFieldRead(e.object, s);
      const argRes = resolveRuleExpr(e.args[0], s);
      if (objField && argRes.expr.type === 'listLiteral') {
        const hasUid = argRes.expr.elements.some((el) =>
          isRequestMemberChain(el, argRes.scope, ['request', 'auth', 'uid']),
        );
        const scalars: (string | number | boolean)[] = [];
        for (const el of argRes.expr.elements) {
          const lit = scalarLiteral(el, argRes.scope);
          if (lit !== undefined && lit !== null) scalars.push(lit);
        }
        if (hasUid) {
          let expectedAuth: 'uid-list' | 'uid-not-in-list' = 'uid-list';
          if (negated) expectedAuth = 'uid-not-in-list';
          rawOut.push({
            targetService: 'firestore',
            kind: 'get',
            pattern: objField.pattern,
            field: objField.field,
            expectedAuth,
          });
          if (!negated && e.method === 'hasAll' && scalars.length > 0) {
            rawOut.push({
              targetService: 'firestore',
              kind: 'get',
              pattern: objField.pattern,
              field: objField.field,
              expectedValue: scalars,
            });
          }
          return;
        }
        if (negated) {
          rawOut.push({
            targetService: 'firestore',
            kind: 'get',
            pattern: objField.pattern,
            field: objField.field,
            expectedValue: [],
          });
          return;
        }
        if (scalars.length > 0 || argRes.expr.elements.length === 0) {
          let listVal: readonly (string | number | boolean)[] = [];
          if (scalars.length > 0) {
            listVal = e.method === 'hasAll' ? scalars : [scalars[0]!];
          }
          rawOut.push({
            targetService: 'firestore',
            kind: 'get',
            pattern: objField.pattern,
            field: objField.field,
            expectedValue: listVal,
          });
          return;
        }
      }
    }
    collectCrossServiceReads(e.object, s, false, rawOut);
    for (const arg of e.args) collectCrossServiceReads(arg, s, false, rawOut);
  } else if (e.type === 'memberAccess') {
    collectCrossServiceReads(e.object, s, false, rawOut);
  } else if (e.type === 'bracketAccess') {
    collectCrossServiceReads(e.object, s, false, rawOut);
    collectCrossServiceReads(e.index, s, false, rawOut);
  } else if (e.type === 'inExpr') {
    const elemResolved = resolveRuleExpr(e.element, s);
    const colField = firestoreGetFieldRead(e.collection, s);
    if (
      colField
      && isRequestMemberChain(elemResolved.expr, elemResolved.scope, ['request', 'auth', 'uid'])
    ) {
      let expectedAuth: 'uid-list' | 'uid-not-in-list' = 'uid-list';
      if (negated) expectedAuth = 'uid-not-in-list';
      rawOut.push({
        targetService: 'firestore',
        kind: 'get',
        pattern: colField.pattern,
        field: colField.field,
        expectedAuth,
      });
      return;
    }
    if (colField) {
      const elemLit = scalarLiteral(e.element, s);
      if (elemLit !== undefined && elemLit !== null) {
        rawOut.push({
          targetService: 'firestore',
          kind: 'get',
          pattern: colField.pattern,
          field: colField.field,
          expectedValue: negated ? [] : [elemLit],
        });
        return;
      }
    }
    if (!negated) {
      const elemField = firestoreGetFieldRead(e.element, s);
      const colResolved = resolveRuleExpr(e.collection, s);
      if (elemField && colResolved.expr.type === 'listLiteral') {
        let firstScalar: string | number | boolean | undefined;
        for (const item of colResolved.expr.elements) {
          const lit = scalarLiteral(item, colResolved.scope);
          if (lit !== undefined && lit !== null) {
            firstScalar = lit;
            break;
          }
        }
        const entry: {
          targetService: 'firestore';
          kind: 'get';
          pattern: ResourcePattern;
          field: string;
          expectedValue?: string | number | boolean;
        } = {
          targetService: 'firestore',
          kind: 'get',
          pattern: elemField.pattern,
          field: elemField.field,
        };
        if (firstScalar !== undefined) entry.expectedValue = firstScalar;
        rawOut.push(entry);
        return;
      }
    }
    collectCrossServiceReads(e.element, s, false, rawOut);
    collectCrossServiceReads(e.collection, s, false, rawOut);
  } else if (e.type === 'isExpr') {
    collectCrossServiceReads(e.value, s, false, rawOut);
  } else if (e.type === 'listLiteral') {
    for (const el of e.elements) collectCrossServiceReads(el, s, false, rawOut);
  }
}

function patternIdentity(pattern: ResourcePattern): string {
  return `${pattern.resourceId}:${renderResourcePattern(pattern)}`;
}

export function extractStorageCrossServiceReads(
  condition: Expression,
  scope: RuleAstScope,
): CrossServiceLookup[] {
  const raw: CrossServiceLookup[] = [];
  collectCrossServiceReads(condition, scope, false, raw);

  const getPatternsWithFields = new Set<string>();
  for (const item of raw) {
    if (item.kind === 'get' && item.field !== undefined) {
      getPatternsWithFields.add(patternIdentity(item.pattern));
    }
  }

  const seen = new Set<string>();
  const out: CrossServiceLookup[] = [];
  for (const item of raw) {
    const pid = patternIdentity(item.pattern);
    if (item.kind === 'get' && item.field === undefined && getPatternsWithFields.has(pid)) {
      continue;
    }
    const key = `${item.kind}|${pid}|${item.field ?? ''}|${JSON.stringify(item.expectedValue ?? null)}|${item.comparisonOp ?? ''}|${item.expectedAuth ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
