/**
 * Cloud Storage security-rule owner inference (`storageOwnerConditions`) and
 * `RuleSurfaceEntry` projection (`projectStorageRulesSource`).
 *
 * Supports `service firebase.storage` and `service cloud.storage`, multiple
 * top-level `match /b/<bucket>/o` blocks (wildcard `{bucket}` or concrete
 * bucket names), nested `match` path concatenation, and lexical helper
 * `function` expansion with `let` bindings, parameter shadowing, and cycle guards.
 */
import {
  assembleExpression,
  type AllowRule,
  type Expression,
  type FunctionDef,
  type MatchBlock,
} from '../../rules/internal/index.js';
import { extractServiceHeader } from '../../sandbox/internal/resource-pattern-header.js';
import {
  parseResourcePattern,
  renderResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type { CrossServiceLookup, RuleSurfaceEntry, StorageMetadataConstraint } from './rule-surface.js';
import {
  expandRuleOps,
  formatMatchSegment,
  inlineRuleCall,
  isOverbroadAuthOnlyRulesExpr,
  isRequestMemberChain,
  parseRulesAstWithMultiMatch,
  resolveRuleExpr,
  type RuleAstScope,
} from './rules-ast-utils.js';
import {
  extractStorageAllowValueHints,
  extractStorageMetadataConstraint,
  isUnshadowedIdent,
  propOf,
  scalarLiteral,
} from './storage-constraints.js';
import { extractStorageCrossServiceReads } from './storage-cross-service.js';
import type { OwnerCondition, OwnerKind, OwnerRelation } from './types.js';
import type { ValueHint } from './value-hints.js';

const WRITE_OPS = new Set(['write', 'create', 'update', 'delete']);

interface StorageOwnerCtx {
  readonly pattern: ResourcePattern;
  readonly scopedPath: string;
  readonly ops: readonly string[];
  readonly source: string;
  readonly out: OwnerCondition[];
  readonly required: boolean;
  readonly negated: boolean;
}

function isStorageServiceName(name: string): boolean {
  return name === 'firebase.storage' || name === 'cloud.storage' || /storage/.test(name);
}

export function renderScopedStoragePath(pattern: ResourcePattern): string {
  const body = renderResourcePattern(pattern);
  if (pattern.resourceId === '(default)') return body;
  if (body.length === 0) return `/b/${pattern.resourceId}/o`;
  return `/b/${pattern.resourceId}/o/${body}`;
}

function safeAssemble(expr: Expression): string {
  try {
    return assembleExpression(expr);
  } catch {
    return expr.type;
  }
}

function isAuthUid(expr: Expression, scope: RuleAstScope): boolean {
  return isRequestMemberChain(expr, scope, ['request', 'auth', 'uid']);
}

function metadataFieldTarget(
  expr: Expression,
  scope: RuleAstScope,
): { kind: 'storedField' | 'incomingField'; key: string } | undefined {
  const resolved = resolveRuleExpr(expr, scope);
  let metaExpr: Expression | undefined;
  let metaScope: RuleAstScope = resolved.scope;
  let key: string | undefined;

  if (
    resolved.expr.type === 'methodCall'
    && resolved.expr.method === 'get'
    && resolved.expr.args[0]
  ) {
    const keyLit = scalarLiteral(resolved.expr.args[0], resolved.scope);
    if (typeof keyLit === 'string') {
      key = keyLit;
      metaExpr = resolved.expr.object;
      metaScope = resolved.scope;
    }
  } else {
    const p = propOf(resolved.expr, resolved.scope);
    if (p) {
      key = p.prop;
      metaExpr = p.object;
      metaScope = p.objScope;
    }
  }

  if (!metaExpr || key === undefined) return undefined;
  const metaProp = propOf(metaExpr, metaScope);
  if (!metaProp || metaProp.prop !== 'metadata') return undefined;

  if (isUnshadowedIdent(metaProp.object, metaProp.objScope, 'resource')) {
    return { kind: 'storedField', key };
  }
  const reqRes = propOf(metaProp.object, metaProp.objScope);
  if (
    reqRes
    && reqRes.prop === 'resource'
    && isUnshadowedIdent(reqRes.object, reqRes.objScope, 'request')
  ) {
    return { kind: 'incomingField', key };
  }
  return undefined;
}

function pushCondition(
  ctx: StorageOwnerCtx,
  kind: OwnerKind,
  field: string,
  relation: OwnerRelation,
  whole: Expression,
  location: string | undefined,
  varIndex?: number,
): void {
  const condition: OwnerCondition = {
    service: 'storage',
    path: ctx.scopedPath,
    ops: [...ctx.ops],
    kind,
    field,
    relation,
    required: ctx.required,
    source: ctx.source,
    expression: safeAssemble(whole),
  };
  if (varIndex !== undefined) condition.varIndex = varIndex;
  if (location !== undefined) condition.location = location;
  ctx.out.push(condition);
}

function recordStorageUidTarget(
  other: Expression,
  scope: RuleAstScope,
  relation: OwnerRelation,
  whole: Expression,
  ctx: StorageOwnerCtx,
): void {
  const r = resolveRuleExpr(other, scope);
  if (
    r.expr.type === 'identifier'
    && r.scope.wildcards.has(r.expr.name)
    && !r.scope.vars.has(r.expr.name)
  ) {
    const varName = r.expr.name;
    const foundIndex = ctx.pattern.segments.findIndex(
      (seg) => (seg.kind === 'var' || seg.kind === 'rest') && seg.name === varName,
    );
    if (foundIndex >= 0) {
      let fieldToken = `{${varName}}`;
      if (ctx.pattern.segments[foundIndex]?.kind === 'rest') fieldToken = `{${varName}=**}`;
      pushCondition(ctx, 'pathVar', fieldToken, relation, whole, undefined, foundIndex);
    }
    return;
  }

  const meta = metadataFieldTarget(r.expr, r.scope);
  if (meta) {
    pushCondition(
      ctx,
      meta.kind,
      meta.key,
      relation,
      whole,
      `${ctx.scopedPath}#${meta.key}`,
    );
  }
}

function visitStorageOwnerExpr(
  expr: Expression,
  scope: RuleAstScope,
  ctx: StorageOwnerCtx,
): void {
  const r = resolveRuleExpr(expr, scope);
  const e = r.expr;
  const s = r.scope;

  if (e.type === 'unaryOp') {
    if (e.op === '!') {
      visitStorageOwnerExpr(e.operand, s, { ...ctx, negated: !ctx.negated });
    } else {
      visitStorageOwnerExpr(e.operand, s, { ...ctx, required: false });
    }
    return;
  }

  if (e.type === 'binaryOp') {
    if (e.op === '&&') {
      let branchCtx = ctx;
      if (ctx.negated) branchCtx = { ...ctx, required: false };
      visitStorageOwnerExpr(e.left, s, branchCtx);
      visitStorageOwnerExpr(e.right, s, branchCtx);
      return;
    }
    if (e.op === '||') {
      let branchCtx: StorageOwnerCtx = { ...ctx, required: false };
      if (ctx.negated) branchCtx = ctx;
      visitStorageOwnerExpr(e.left, s, branchCtx);
      visitStorageOwnerExpr(e.right, s, branchCtx);
      return;
    }
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
        let nextNeg = ctx.negated;
        if (flips) nextNeg = !ctx.negated;
        visitStorageOwnerExpr(target, s, { ...ctx, negated: nextNeg });
        return;
      }
      const isPosEq = (e.op === '==' && !ctx.negated) || (e.op === '!=' && ctx.negated);
      if (!isPosEq) return;
      if (isAuthUid(e.left, s)) recordStorageUidTarget(e.right, s, 'equals', e, ctx);
      else if (isAuthUid(e.right, s)) recordStorageUidTarget(e.left, s, 'equals', e, ctx);
    }
    return;
  }

  if (e.type === 'ternary') {
    if (!ctx.negated && scalarLiteral(e.alternate, s) === false) {
      visitStorageOwnerExpr(e.condition, s, ctx);
      visitStorageOwnerExpr(e.consequent, s, ctx);
      return;
    }
    if (!ctx.negated && scalarLiteral(e.consequent, s) === false) {
      visitStorageOwnerExpr(e.condition, s, { ...ctx, negated: true });
      visitStorageOwnerExpr(e.alternate, s, ctx);
      return;
    }
    const branchCtx: StorageOwnerCtx = { ...ctx, required: false };
    visitStorageOwnerExpr(e.condition, s, branchCtx);
    visitStorageOwnerExpr(e.consequent, s, branchCtx);
    visitStorageOwnerExpr(e.alternate, s, branchCtx);
    return;
  }

  if (e.type === 'inExpr') {
    if (!ctx.negated && isAuthUid(e.element, s)) {
      recordStorageUidTarget(e.collection, s, 'contains', e, ctx);
    }
    return;
  }

  if (e.type === 'methodCall') {
    if (
      !ctx.negated
      && (e.method === 'hasAny' || e.method === 'hasAll')
      && e.args.some(
        (arg) => arg.type === 'listLiteral' && arg.elements.some((el) => isAuthUid(el, s)),
      )
    ) {
      recordStorageUidTarget(e.object, s, 'contains', e, ctx);
    }
    return;
  }

  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (inlined) visitStorageOwnerExpr(inlined.expr, inlined.scope, ctx);
  }
}

export function storageAllowOwnerConditions(
  allow: AllowRule,
  fallbackLine: number | undefined,
  pattern: ResourcePattern,
  functions: readonly (readonly FunctionDef[])[],
  wildcards: ReadonlySet<string>,
  file: string,
): OwnerCondition[] {
  const out: OwnerCondition[] = [];
  const scope: RuleAstScope = {
    vars: new Map(),
    functions,
    wildcards,
    depth: 0,
  };
  const line = allow.loc?.line ?? fallbackLine;
  let ruleSource = file;
  if (line !== undefined) ruleSource = `${file}:${line}`;
  const ctx: StorageOwnerCtx = {
    pattern,
    scopedPath: renderScopedStoragePath(pattern),
    ops: expandRuleOps(allow.operations),
    source: ruleSource,
    out,
    required: true,
    negated: false,
  };
  visitStorageOwnerExpr(allow.condition, scope, ctx);
  return out;
}

export function projectStorageRulesSource(
  source: string,
  file: string,
  explicitBucket?: string,
): RuleSurfaceEntry[] {
  const services = parseRulesAstWithMultiMatch(source);
  const out: RuleSurfaceEntry[] = [];

  const walk = (
    match: MatchBlock,
    parentSegments: readonly string[],
    functions: readonly (readonly FunctionDef[])[],
    wildcards: ReadonlySet<string>,
  ): void => {
    const fullPath = [...parentSegments];
    const nextWildcards = new Set(wildcards);
    for (const seg of match.path.segments) {
      fullPath.push(formatMatchSegment(seg));
      if (seg.type !== 'literal') nextWildcards.add(seg.name);
    }
    const scopeFns = [...functions, match.functions];
    const rawRulePath = `/${fullPath.join('/')}`;
    const header = extractServiceHeader('storage', rawRulePath);
    const hasValidHeader = header.headerKind === 'concrete' || header.headerKind === 'wildcard';
    const isWildcardBucket = explicitBucket === undefined && header.headerKind === 'wildcard';

    if (match.allows.length > 0 && hasValidHeader) {
      const pattern = parseResourcePattern('storage', rawRulePath, explicitBucket);
      const scopedPath = renderScopedStoragePath(pattern);

      for (const allow of match.allows) {
        const ops = expandRuleOps(allow.operations);
        const line = allow.loc?.line ?? match.loc?.line;
        let ruleSource = file;
        if (line !== undefined) ruleSource = `${file}:${line}`;
        const scope: RuleAstScope = {
          vars: new Map(),
          functions: scopeFns,
          wildcards: nextWildcards,
          depth: 0,
        };
        const ownerConditions = storageAllowOwnerConditions(
          allow,
          match.loc?.line,
          pattern,
          scopeFns,
          nextWildcards,
          file,
        );
        const valueHints = extractStorageAllowValueHints(allow.condition, scope, scopedPath);
        if (isWildcardBucket) {
          for (const cond of ownerConditions) cond.wildcardBucket = true;
          for (const hint of valueHints) hint.wildcardBucket = true;
        }
        const storageMetadata = extractStorageMetadataConstraint(
          allow.condition,
          scope,
          ownerConditions,
        );
        const crossServiceReads = extractStorageCrossServiceReads(allow.condition, scope);

        const entry: {
          pattern: ResourcePattern;
          ops: readonly string[];
          ownerConditions: readonly OwnerCondition[];
          valueHints: readonly ValueHint[];
          storageMetadata?: StorageMetadataConstraint;
          crossServiceReads: readonly CrossServiceLookup[];
          overbroadAuthOnlyWrite?: boolean;
          wildcardBucket?: boolean;
          source: string;
        } = {
          pattern,
          ops,
          ownerConditions,
          valueHints,
          crossServiceReads,
          source: ruleSource,
        };
        if (isWildcardBucket) entry.wildcardBucket = true;
        if (storageMetadata !== undefined) entry.storageMetadata = storageMetadata;
        if (ops.some((op) => WRITE_OPS.has(op))) {
          entry.overbroadAuthOnlyWrite = isOverbroadAuthOnlyRulesExpr(allow.condition, scope);
        }
        out.push(entry);
      }
    }

    for (const child of match.children) {
      walk(child, fullPath, scopeFns, nextWildcards);
    }
  };

  for (const svc of services) {
    if (!isStorageServiceName(svc.name)) continue;
    for (const topMatch of svc.matches) {
      walk(topMatch, [], svc.functions, new Set());
    }
  }
  return out;
}

/** Collect owner conditions from Cloud Storage rules source. Returns `[]` on invalid syntax. */
export function storageOwnerConditions(
  source: string,
  file: string,
  explicitBucket?: string,
): OwnerCondition[] {
  return projectStorageRulesSource(source, file, explicitBucket).flatMap(
    (entry) => entry.ownerConditions,
  );
}

/** Collect positive `request.resource.metadata.<k> == <literal>` hints from Storage rules. */
export function storageValueHints(source: string, explicitBucket?: string): ValueHint[] {
  return projectStorageRulesSource(source, 'storage.rules', explicitBucket).flatMap(
    (entry) => entry.valueHints,
  );
}
