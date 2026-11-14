/**
 * AST projection, literal, numeric, and resource/header member-chain helpers
 * for Cloud Storage metadata constraint extraction.
 */
import type { Expression } from '../../rules/internal/index.js';
import type { StorageHttpHeaderKey } from '../code/types.js';
import {
  isRequestMemberChain,
  resolveRuleExpr,
  type RuleAstScope,
} from './rules-ast-utils.js';

export const STORAGE_HTTP_HEADER_KEYS: readonly StorageHttpHeaderKey[] = [
  'cacheControl',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
];

const STORAGE_HTTP_HEADER_SET = new Set<string>(STORAGE_HTTP_HEADER_KEYS);

export type HttpHeaderConjunctMap = ReadonlyMap<StorageHttpHeaderKey, readonly (readonly string[])[]>;

export function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripOuterAnchors(pattern: string): string {
  if (pattern.startsWith('^') && pattern.endsWith('$') && !pattern.endsWith('\\$')) {
    return pattern.slice(1, -1);
  }
  return pattern;
}

export function formatContentTypePatterns(patterns: readonly string[]): string {
  if (patterns.length === 1) return patterns[0]!;
  return `^(?:${patterns.map(stripOuterAnchors).join('|')})$`;
}

const MAX_DISTRIBUTED_CONJUNCTS = 64;

export function mergeConjunctLists(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[],
): (readonly string[])[] {
  const out: (readonly string[])[] = left.map((c) => [...c]);
  for (const c of right) {
    const sig = c.join('||');
    if (!out.some((existing) => existing.join('||') === sig)) {
      out.push([...c]);
    }
  }
  return out;
}

export function distributeOrConjunctLists(
  arms: readonly (readonly (readonly string[])[])[],
): (readonly string[])[] {
  const uniqueBySig = new Map<string, readonly (readonly string[])[]>();
  for (const arm of arms) {
    if (arm.length === 0) return [];
    const sig = arm.map((c) => c.join('||')).join('&&');
    if (!uniqueBySig.has(sig)) uniqueBySig.set(sig, arm);
  }
  const uniqueArms = [...uniqueBySig.values()];
  if (uniqueArms.length === 0) return [];
  if (uniqueArms.length === 1) return uniqueArms[0]!.map((c) => [...c]);

  let acc: (readonly string[])[] = uniqueArms[0]!.map((c) => [...c]);
  for (let i = 1; i < uniqueArms.length; i += 1) {
    const nextArm = uniqueArms[i]!;
    if (acc.length * nextArm.length > MAX_DISTRIBUTED_CONJUNCTS) {
      const nextSigs = new Set(nextArm.map((c) => c.join('||')));
      acc = acc.filter((c) => nextSigs.has(c.join('||')));
      if (acc.length === 0) return [];
      continue;
    }
    const distributed: (readonly string[])[] = [];
    const seenSigs = new Set<string>();
    for (const aDisjuncts of acc) {
      for (const bDisjuncts of nextArm) {
        const merged = [...new Set([...aDisjuncts, ...bDisjuncts])];
        const sig = merged.join('||');
        if (!seenSigs.has(sig)) {
          seenSigs.add(sig);
          distributed.push(merged);
        }
      }
    }
    acc = distributed;
  }
  return acc;
}

export function mergeHttpHeaderMaps(
  left: HttpHeaderConjunctMap,
  right: HttpHeaderConjunctMap,
): Map<StorageHttpHeaderKey, readonly (readonly string[])[]> {
  const out = new Map<StorageHttpHeaderKey, readonly (readonly string[])[]>();
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const l = left.get(key);
    const r = right.get(key);
    if (l && r) out.set(key, mergeConjunctLists(l, r));
    else if (l) out.set(key, l.map((c) => [...c]));
    else if (r) out.set(key, r.map((c) => [...c]));
  }
  return out;
}

interface PropProjection {
  readonly object: Expression;
  readonly objScope: RuleAstScope;
  readonly prop: string;
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

export function isRequestResource(expr: Expression, scope: RuleAstScope): boolean {
  const res = propOf(expr, scope);
  return Boolean(
    res && res.prop === 'resource' && isUnshadowedIdent(res.object, res.objScope, 'request'),
  );
}

export function isRequestResourceProp(
  expr: Expression,
  scope: RuleAstScope,
  prop: string,
): boolean {
  const p = propOf(expr, scope);
  if (!p || p.prop !== prop) return false;
  return isRequestResource(p.object, p.objScope);
}

export function incomingHttpHeaderKey(
  expr: Expression,
  scope: RuleAstScope,
): StorageHttpHeaderKey | undefined {
  const p = propOf(expr, scope);
  if (!p || !STORAGE_HTTP_HEADER_SET.has(p.prop)) return undefined;
  if (isRequestResource(p.object, p.objScope)) return p.prop as StorageHttpHeaderKey;
  return undefined;
}

export function storedHttpHeaderKey(
  expr: Expression,
  scope: RuleAstScope,
): StorageHttpHeaderKey | undefined {
  const p = propOf(expr, scope);
  if (!p || !STORAGE_HTTP_HEADER_SET.has(p.prop)) return undefined;
  if (isUnshadowedIdent(p.object, p.objScope, 'resource')) return p.prop as StorageHttpHeaderKey;
  return undefined;
}

export function isRequestResourceMetadata(expr: Expression, scope: RuleAstScope): boolean {
  return isRequestResourceProp(expr, scope, 'metadata');
}

export function isRequestResourceMetadataKeys(expr: Expression, scope: RuleAstScope): boolean {
  const r = resolveRuleExpr(expr, scope);
  if (r.expr.type !== 'methodCall' || r.expr.method !== 'keys' || r.expr.args.length !== 0) {
    return false;
  }
  return isRequestResourceMetadata(r.expr.object, r.scope);
}

export function incomingMetadataDirectKey(
  expr: Expression,
  scope: RuleAstScope,
): string | undefined {
  const p = propOf(expr, scope);
  if (!p) return undefined;
  if (isRequestResourceMetadata(p.object, p.objScope)) return p.prop;
  return undefined;
}

export function incomingMetadataGetCall(
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

export function stringListElements(expr: Expression, scope: RuleAstScope): string[] | undefined {
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

export function recordGetRequiredKey(
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
