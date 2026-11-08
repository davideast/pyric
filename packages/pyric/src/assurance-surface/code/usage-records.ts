/**
 * Plain-data intermediate records linking evaluated refs and queries to
 * {@link AccessSite} consumers without retaining TypeScript AST nodes across
 * multi-program scans.
 */
import ts from 'typescript';
import {
  parseResourcePattern,
  renderResourcePattern,
  type AssuranceService,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type { Evaluator } from './evaluator.js';
import { STEP_BUDGET } from './operation-specs.js';
import { renderPath } from './paths.js';
import type { RefKind, SdkQueryConstraint } from './service-models/types.js';
import type { RecordedConstruction } from './sites.js';
import type { AccessResolution, AccessSite, PathVariable } from './types.js';
import { alternatives, constraintKey, nodeId, ownRecordValue, type AVal } from './values.js';

type RefVal = Extract<AVal, { k: 'ref' }>;

export interface TracedRefRecord {
  readonly pattern: ResourcePattern;
  readonly refKind: RefKind;
  readonly resolution: AccessResolution;
  readonly reason?: string;
  readonly pathVariables: readonly PathVariable[];
  readonly source: string;
  readonly through?: string;
  readonly admin?: boolean;
  readonly consumer?: string;
  readonly nodeKey?: string;
  readonly specializedNodeKey?: string;
}

export interface TracedQueryRecord {
  readonly anchorKey: string;
  readonly coversKeys: readonly string[];
  readonly baseRef: TracedRefRecord;
  readonly branchConstraints: readonly (readonly SdkQueryConstraint[])[];
  readonly source: string;
  readonly through?: string;
  readonly consumer?: string;
}

export interface SiteUsageEntry {
  readonly refRecord: TracedRefRecord;
  readonly queryRecord?: TracedQueryRecord;
}

export interface ProgramUsageRecords {
  readonly refs: readonly TracedRefRecord[];
  readonly queries: readonly TracedQueryRecord[];
  readonly coveredQueryKeys: ReadonlySet<string>;
}

/** Per-site ref/query lineage, keyed by winning AccessSite instances. */
export const SITE_USAGE = new WeakMap<AccessSite, readonly SiteUsageEntry[]>();

export function constraintListKey(list: readonly SdkQueryConstraint[]): string {
  return list.map(constraintKey).join('&&');
}

export function refIdentityKey(rec: TracedRefRecord): string {
  const rendered = renderResourcePattern(rec.pattern);
  let adminTag = '';
  if (rec.admin) adminTag = 'a';
  return `${rec.pattern.service}|${rec.pattern.resourceId}|${rec.refKind}|${rendered}|${rec.source}|${rec.through ?? ''}|${adminTag}`;
}

function resolveRefAttribution(
  ref: RefVal,
  fallbackNode: ts.Node,
  callerThrough: string | undefined,
  sourceOf: (node: ts.Node) => string,
): { source: string; through?: string; nodeKey?: string; specializedNodeKey?: string } {
  const builtNode = ref.built[ref.built.length - 1];
  if (ref.fromCallers && callerThrough !== undefined) {
    let through = callerThrough;
    let specializedNodeKey: string | undefined;
    if (builtNode) {
      through = sourceOf(builtNode);
      specializedNodeKey = nodeId(builtNode);
    }
    return {
      source: sourceOf(fallbackNode),
      through,
      specializedNodeKey,
    };
  }
  const originNode = builtNode ?? fallbackNode;
  let nodeKey: string | undefined;
  if (builtNode) {
    nodeKey = nodeId(builtNode);
  }
  return {
    source: sourceOf(originNode),
    nodeKey,
  };
}

function materializeRefRecord(
  ref: RefVal,
  fallbackNode: ts.Node,
  callerThrough: string | undefined,
  consumer: string | undefined,
  force: (v: AVal) => AVal,
  sourceOf: (node: ts.Node) => string,
): TracedRefRecord {
  const baseTarget = ref.baseRef ?? ref;
  const { path, variables } = renderPath(baseTarget.service, baseTarget.segments, force);
  const pattern = parseResourcePattern(baseTarget.service, path, baseTarget.resourceId);
  const resolution: AccessResolution = baseTarget.notes.length > 0 ? 'partial' : 'resolved';
  const attr = resolveRefAttribution(baseTarget, fallbackNode, callerThrough, sourceOf);
  const out: {
    pattern: ResourcePattern;
    refKind: RefKind;
    resolution: AccessResolution;
    reason?: string;
    pathVariables: readonly PathVariable[];
    source: string;
    through?: string;
    admin?: boolean;
    consumer?: string;
    nodeKey?: string;
    specializedNodeKey?: string;
  } = {
    pattern,
    refKind: baseTarget.refKind,
    resolution,
    pathVariables: variables,
    source: attr.source,
  };
  if (baseTarget.notes.length > 0) out.reason = baseTarget.notes.join('; ');
  if (attr.through !== undefined) out.through = attr.through;
  if (baseTarget.admin || ref.admin) out.admin = true;
  if (consumer !== undefined) out.consumer = consumer;
  if (attr.nodeKey !== undefined) out.nodeKey = attr.nodeKey;
  if (attr.specializedNodeKey !== undefined) out.specializedNodeKey = attr.specializedNodeKey;
  return out;
}

function resolveIdentifierDecl(
  expr: ts.Expression | undefined,
  ev: Evaluator,
): { sym: ts.Symbol; decl: ts.Declaration; mutable: boolean } | undefined {
  if (!expr) return undefined;
  let cur: ts.Expression = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur)) return undefined;
  const sym0 = ev.refs.symbolOf(cur);
  if (!sym0) return undefined;
  const sym = ev.refs.resolveAlias(sym0);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (!sym || !decl) return undefined;
  return { sym, decl, mutable: ev.refs.assignmentsTo(sym).length > 0 };
}

export function mergeSiteUsage(target: AccessSite, source: AccessSite): void {
  if (target === source) return;
  const extra = SITE_USAGE.get(source);
  if (!extra || extra.length === 0) return;
  const prev = SITE_USAGE.get(target) ?? [];
  SITE_USAGE.set(target, [...prev, ...extra]);
}

function resolveSiteQueryAnchor(
  siteRefs: readonly RefVal[],
  ref: RefVal,
  refExpr: ts.Expression | undefined,
  sourceNode: ts.Node,
  ev: Evaluator,
  sourceOf: (node: ts.Node) => string,
): { anchorKey: string; originNode: ts.Node } | undefined {
  const queryCalls: ts.CallExpression[] = [];
  let hasUnqueriedBranch = false;
  for (const r of siteRefs) {
    const qc = r.queryCall ?? r.firstQueryCall;
    if (qc) queryCalls.push(qc);
    else hasUnqueriedBranch = true;
  }
  if (queryCalls.length === 0) return undefined;
  const identInfo = resolveIdentifierDecl(refExpr, ev);
  const firstCall = queryCalls[0]!;
  const allSameRootCall = !hasUnqueriedBranch && queryCalls.every((c) => c === firstCall);
  if (identInfo && (identInfo.mutable || !allSameRootCall)) {
    let anchorKey = `var:${nodeId(identInfo.decl)}`;
    if (identInfo.mutable) anchorKey = `${anchorKey}@${sourceOf(sourceNode)}`;
    const rootCall = ref.firstQueryCall ?? firstCall;
    return { anchorKey, originNode: rootCall };
  }
  if (!allSameRootCall) {
    return { anchorKey: `call:${nodeId(refExpr ?? sourceNode)}`, originNode: firstCall };
  }
  const ownCall = ref.queryCall ?? ref.firstQueryCall ?? firstCall;
  return { anchorKey: `call:${nodeId(ownCall)}`, originNode: ownCall };
}

export function attachSiteUsage(
  site: AccessSite,
  ref: RefVal,
  siteRefs: readonly RefVal[],
  refExpr: ts.Expression | undefined,
  sourceNode: ts.Node,
  through: string | undefined,
  ev: Evaluator,
  force: (v: AVal) => AVal,
  sourceOf: (node: ts.Node) => string,
): void {
  const consumer = `${site.op}@${site.source}`;
  const refRecord = materializeRefRecord(ref, sourceNode, through, consumer, force, sourceOf);
  let queryRecord: TracedQueryRecord | undefined;
  const queryAnchor = resolveSiteQueryAnchor(siteRefs, ref, refExpr, sourceNode, ev, sourceOf);
  if (queryAnchor !== undefined) {
    let anchorKey = queryAnchor.anchorKey;
    if (ref.fromCallers && through !== undefined) {
      anchorKey = `${anchorKey}@${site.source}`;
    }
    let querySource = sourceOf(queryAnchor.originNode);
    let queryThrough: string | undefined;
    if (ref.fromCallers && through !== undefined) {
      querySource = site.source;
      queryThrough = sourceOf(queryAnchor.originNode);
    }
    const coversKeys: string[] = [];
    for (const b of ref.built) {
      coversKeys.push(nodeId(b));
    }
    const qRec: {
      anchorKey: string;
      coversKeys: readonly string[];
      baseRef: TracedRefRecord;
      branchConstraints: readonly (readonly SdkQueryConstraint[])[];
      source: string;
      through?: string;
      consumer?: string;
    } = {
      anchorKey,
      coversKeys,
      baseRef: refRecord,
      branchConstraints: [ref.constraints ?? []],
      source: querySource,
      consumer,
    };
    if (queryThrough !== undefined) qRec.through = queryThrough;
    queryRecord = qRec;
  }
  const prev = SITE_USAGE.get(site) ?? [];
  SITE_USAGE.set(site, [...prev, { refRecord, queryRecord }]);
}

function findConstructionHolderSymbol(call: ts.CallExpression, ev: Evaluator): ts.Symbol | undefined {
  let cur: ts.Node = call;
  while (
    cur.parent
    && (ts.isParenthesizedExpression(cur.parent)
      || ts.isAsExpression(cur.parent)
      || ts.isNonNullExpression(cur.parent))
  ) {
    cur = cur.parent;
  }
  const p = cur.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
    return ev.checker.getSymbolAtLocation(p.name);
  }
  if (
    p
    && ts.isBinaryExpression(p)
    && p.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && p.right === cur
    && ts.isIdentifier(p.left)
  ) {
    const sym0 = ev.refs.symbolOf(p.left);
    if (!sym0) return undefined;
    return ev.refs.resolveAlias(sym0);
  }
  return undefined;
}

function unresolvedBaseRef(
  service: AssuranceService,
  refKind: RefKind,
  call: ts.CallExpression,
  reason: string,
  sourceOf: (node: ts.Node) => string,
  admin?: boolean,
): TracedRefRecord {
  const out: {
    pattern: ResourcePattern;
    refKind: RefKind;
    resolution: AccessResolution;
    reason: string;
    pathVariables: readonly PathVariable[];
    source: string;
    admin?: boolean;
    nodeKey: string;
  } = {
    pattern: parseResourcePattern(service, ''),
    refKind,
    resolution: 'unresolved',
    reason,
    pathVariables: [],
    source: sourceOf(call),
    nodeKey: nodeId(call),
  };
  if (admin) out.admin = true;
  return out;
}

function evaluateStandaloneConstraints(
  call: ts.CallExpression,
  ev: Evaluator,
  force: (v: AVal) => AVal,
): SdkQueryConstraint[] {
  const out: SdkQueryConstraint[] = [];
  for (let i = 1; i < call.arguments.length; i++) {
    const argExpr = call.arguments[i]!;
    if (ts.isSpreadElement(argExpr)) {
      out.push({ kind: 'unknown' });
      continue;
    }
    const alts = alternatives(force(ev.eval(argExpr)));
    const first = alts.find((a): a is Extract<AVal, { k: 'constraint' }> => a.k === 'constraint');
    if (first) out.push(first.value);
    else out.push({ kind: 'unknown' });
  }
  return out;
}

function dedupeBranchLists(
  lists: readonly (readonly SdkQueryConstraint[])[],
): (readonly SdkQueryConstraint[])[] {
  const seen = new Set<string>();
  const out: (readonly SdkQueryConstraint[])[] = [];
  for (const list of lists) {
    const key = constraintListKey(list);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(list);
  }
  return out;
}

export function collectProgramUsage(
  constructions: readonly RecordedConstruction[],
  ev: Evaluator,
  force: (v: AVal) => AVal,
  sourceOf: (node: ts.Node) => string,
): ProgramUsageRecords {
  const refs: TracedRefRecord[] = [];
  const queries: TracedQueryRecord[] = [];
  const coveredQueryKeys = new Set<string>();
  const queryCallsInProgram = new Set<string>();
  for (const c of constructions) {
    if (c.isQuery) queryCallsInProgram.add(nodeId(c.call));
  }

  const processedHolders = new Set<ts.Symbol>();

  for (const c of constructions) {
    ev.startBudget(STEP_BUDGET);
    if (!c.isQuery) {
      const v = force(ev.eval(c.call));
      const refAlts = alternatives(v).filter(
        (a): a is RefVal => a.k === 'ref' && a.service === c.service,
      );
      if (refAlts.length === 0) {
        const serviceModel = ev.sdk.serviceModel(c.service);
        const refSpec =
          ownRecordValue(serviceModel?.refConstructors, c.name)
          ?? ownRecordValue(serviceModel?.handleRefMethods, c.name);
        const refKind: RefKind = refSpec?.refKind ?? serviceModel?.defaultRefKind ?? 'doc';
        const untraced = alternatives(v)
          .filter((a): a is Extract<AVal, { k: 'unknown' }> => a.k === 'unknown')
          .map((a) => a.reason);
        const reason = untraced[0] ?? `${c.name}() path was not traced`;
        refs.push(unresolvedBaseRef(c.service, refKind, c.call, reason, sourceOf, c.admin));
        continue;
      }
      for (const r of refAlts) {
        refs.push(materializeRefRecord(r, c.call, undefined, undefined, force, sourceOf));
      }
      continue;
    }

    const holderSym = findConstructionHolderSymbol(c.call, ev);
    const holderDecl = holderSym?.valueDeclaration ?? holderSym?.declarations?.[0];
    const hasReassignments = holderSym !== undefined && ev.refs.assignmentsTo(holderSym).length > 0;
    if (hasReassignments && holderSym && holderDecl) {
      if (processedHolders.has(holderSym)) continue;
      processedHolders.add(holderSym);
      const finalVal = force(ev.symbolValue(holderSym, undefined));
      const queryAlts = alternatives(finalVal).filter(
        (a): a is RefVal => a.k === 'ref' && a.service === c.service,
      );
      if (queryAlts.length > 0 && queryAlts.some((a) => a.queryCall !== undefined)) {
        const byBase = new Map<string, { baseRef: TracedRefRecord; branches: (readonly SdkQueryConstraint[])[]; covers: Set<string>; source: string }>();
        for (const r of queryAlts) {
          const baseRec = materializeRefRecord(r, c.call, undefined, undefined, force, sourceOf);
          refs.push(baseRec);
          const bKey = refIdentityKey(baseRec);
          let group = byBase.get(bKey);
          if (!group) {
            const firstCall = r.firstQueryCall ?? c.call;
            group = { baseRef: baseRec, branches: [], covers: new Set<string>(), source: sourceOf(firstCall) };
            byBase.set(bKey, group);
          }
          group.branches.push(r.constraints ?? []);
          for (const b of r.built) {
            const bid = nodeId(b);
            if (queryCallsInProgram.has(bid)) {
              group.covers.add(bid);
              if (bid !== nodeId(c.call)) coveredQueryKeys.add(bid);
            }
          }
        }
        for (const [, group] of byBase) {
          queries.push({
            anchorKey: `var:${nodeId(holderDecl)}`,
            coversKeys: [...group.covers],
            baseRef: group.baseRef,
            branchConstraints: dedupeBranchLists(group.branches),
            source: group.source,
          });
        }
        continue;
      }
    }

    if (coveredQueryKeys.has(nodeId(c.call))) continue;
    const v = force(ev.eval(c.call));
    const queryAlts = alternatives(v).filter(
      (a): a is RefVal => a.k === 'ref' && a.service === c.service && a.queryCall !== undefined,
    );
    if (queryAlts.length === 0) {
      const untraced = alternatives(v)
        .filter((a): a is Extract<AVal, { k: 'unknown' }> => a.k === 'unknown')
        .map((a) => a.reason);
      const defaultKind: RefKind = ev.sdk.serviceModel(c.service)?.queryBaseRefKind ?? 'collection';
      const baseRec = unresolvedBaseRef(
        c.service,
        defaultKind,
        c.call,
        untraced[0] ?? 'query() base was not traced',
        sourceOf,
        c.admin,
      );
      queries.push({
        anchorKey: `call:${nodeId(c.call)}`,
        coversKeys: [nodeId(c.call)],
        baseRef: baseRec,
        branchConstraints: [evaluateStandaloneConstraints(c.call, ev, force)],
        source: sourceOf(c.call),
      });
      continue;
    }

    const byBase = new Map<string, { baseRef: TracedRefRecord; branches: (readonly SdkQueryConstraint[])[]; covers: Set<string> }>();
    for (const r of queryAlts) {
      const baseRec = materializeRefRecord(r, c.call, undefined, undefined, force, sourceOf);
      refs.push(baseRec);
      const bKey = refIdentityKey(baseRec);
      let group = byBase.get(bKey);
      if (!group) {
        group = { baseRef: baseRec, branches: [], covers: new Set<string>() };
        byBase.set(bKey, group);
      }
      group.branches.push(r.constraints ?? []);
      for (const b of r.built) {
        const bid = nodeId(b);
        if (queryCallsInProgram.has(bid)) {
          group.covers.add(bid);
          if (bid !== nodeId(c.call)) coveredQueryKeys.add(bid);
        }
      }
    }
    for (const [, group] of byBase) {
      queries.push({
        anchorKey: `call:${nodeId(c.call)}`,
        coversKeys: [...group.covers],
        baseRef: group.baseRef,
        branchConstraints: dedupeBranchLists(group.branches),
        source: sourceOf(c.call),
      });
    }
  }

  return { refs, queries, coveredQueryKeys };
}
