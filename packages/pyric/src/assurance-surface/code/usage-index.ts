/**
 * Unified static SDK usage IR (`SdkUsageIndex`): browser-clean TypeScript
 * program scan emitting promoted `SdkRef[]`, `SdkQuery[]` with filter operands
 * and branch alternatives, `AccessSite[]` operations, and embedded rules.
 */
import type ts from 'typescript';
import {
  renderResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import { findEmbeddedRules, type EmbeddedRules } from './embedded-rules.js';
import { Evaluator } from './evaluator.js';
import { posixRelative, posixResolve, toPosixPath } from './posix-path.js';
import { isExcludedPath, iteratePrograms, resolveScanRoot } from './program.js';
import { ReferenceIndex } from './references.js';
import { SdkTable } from './sdk-imports.js';
import type {
  ConstraintOperand,
  RefKind,
  SdkQueryConstraint,
  SdkServiceModel,
} from './service-models/types.js';
import { SiteCollector } from './sites.js';
import { mergeResults, type CollectorResult } from './specialization.js';
import type {
  AccessResolution,
  AccessSite,
  ExtractAccessSitesOptions,
  PathVariable,
} from './types.js';
import {
  constraintListKey,
  refIdentityKey,
  SITE_USAGE,
  type TracedQueryRecord,
  type TracedRefRecord,
} from './usage-records.js';

export type {
  AssuranceService,
  ConstraintOperand,
  ConstraintSpec,
  FieldValueName,
  HandleFactorySpec,
  OpSpec,
  ReceiverFactorySpec,
  RefConstructorSpec,
  RefKind,
  SdkQueryConstraint,
  SdkServiceModel,
} from './service-models/types.js';

export type ExtractSdkUsageOptions = ExtractAccessSitesOptions;

export interface SdkRef {
  readonly id: string;
  readonly pattern: ResourcePattern;
  readonly refKind: RefKind;
  readonly resolution: AccessResolution;
  readonly reason?: string;
  readonly pathVariables: readonly PathVariable[];
  readonly consumedBy: readonly string[];
  readonly source: string;
  readonly through?: string;
}

export interface SdkQuery {
  readonly id: string;
  readonly baseRef: SdkRef;
  readonly constraints: readonly SdkQueryConstraint[];
  /** Enumerated branch alternatives when a query variable is conditionally reassigned (`if (filter) q = query(q, ...)`). */
  readonly branches?: readonly (readonly SdkQueryConstraint[])[];
  readonly consumedBy: readonly string[];
  readonly source: string;
  readonly through?: string;
}

export interface SdkUsageIndex {
  readonly refs: readonly SdkRef[];
  readonly queries: readonly SdkQuery[];
  readonly operations: readonly AccessSite[];
  readonly embeddedRules: readonly EmbeddedRules[];
  readonly filesScanned: number;
  readonly projects: readonly string[];
}

export type SdkUsagePass<TResult, TContext = void> = (
  usage: SdkUsageIndex,
  context: TContext,
) => TResult;

export function extractSdkUsage(options: ExtractSdkUsageOptions): SdkUsageIndex {
  const root = resolveScanRoot(options.root, options.files !== undefined);
  const presets = options.presets ?? [];
  const excludes = presets.flatMap((p) => p.exclude ?? []);
  const sdk = new SdkTable(presets, options.serviceModels);
  const results: CollectorResult[] = [];
  const embeddedRules: EmbeddedRules[] = [];
  let filesScanned = 0;

  const normRel = (p: string): string => posixRelative(root, p);
  const normRoot = (r: string): string => normRel(posixResolve(root, r));
  const clientPrefixes = (options.clientRoots ?? []).map(normRoot);
  const serverPrefixes = (options.serverRoots ?? []).map(normRoot);
  const matchesPrefix = (rel: string, prefix: string): boolean => {
    if (prefix === '') return !rel.startsWith('..');
    return rel === prefix || rel.startsWith(`${prefix}/`);
  };
  const isServer = (sf: ts.SourceFile): boolean => {
    const rel = normRel(sf.fileName);
    return serverPrefixes.some((sr) => matchesPrefix(rel, sr));
  };
  const isClientOwned = (sf: ts.SourceFile): boolean => {
    const rel = normRel(sf.fileName);
    if (serverPrefixes.some((sr) => matchesPrefix(rel, sr))) return false;
    if (clientPrefixes.length > 0 && !clientPrefixes.some((cr) => matchesPrefix(rel, cr))) return false;
    return true;
  };
  const isClientOwnedPath = (path: string): boolean => {
    const rel = normRel(path);
    if (serverPrefixes.some((sr) => matchesPrefix(rel, sr))) return false;
    if (clientPrefixes.length > 0 && !clientPrefixes.some((cr) => matchesPrefix(rel, cr))) return false;
    return true;
  };

  const projects: string[] = [];
  for (const p of iteratePrograms(root, options.files, excludes, (rootNames) => rootNames.some(isClientOwnedPath))) {
    projects.push(p.config);
    const inProject = p.program.getSourceFiles().filter((sf) => isInProject(root, sf, excludes) && !isServer(sf));
    const clientFiles = p.files.filter(isClientOwned);
    if (clientFiles.length === 0) continue;
    const ev = new Evaluator(p.checker, new ReferenceIndex(p.checker, inProject), sdk);
    const collector = new SiteCollector(ev, root, options.includeReads ?? true);
    const owned = new Set(clientFiles);
    for (const sf of clientFiles) {
      collector.scanFile(sf, true);
    }
    for (const sf of inProject) {
      if (!owned.has(sf)) {
        collector.scanFile(sf, false);
      }
    }
    results.push(collector.finish());
    const gc = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun?.gc;
    if (gc) gc(false);

    embeddedRules.push(...findEmbeddedRules(ev, clientFiles, root));
    filesScanned += clientFiles.length;
  }

  const operations = mergeResults(results);
  operations.sort(compareSites);
  const { refs, queries } = assembleRefsAndQueries(results, operations);

  return {
    refs,
    queries,
    operations,
    embeddedRules,
    filesScanned,
    projects,
  };
}

interface RefAccumulator {
  readonly record: TracedRefRecord;
  readonly consumers: Set<string>;
}

interface QueryAccumulator {
  readonly anchorKey: string;
  readonly baseKey: string;
  readonly source: string;
  readonly through?: string;
  readonly branches: Map<string, readonly SdkQueryConstraint[]>;
  readonly consumers: Set<string>;
}

function refTargetKey(rec: TracedRefRecord): string {
  const rendered = renderResourcePattern(rec.pattern);
  return `${rec.pattern.service}|${rec.pattern.resourceId}|${rec.refKind}|${rendered}`;
}

function assembleRefsAndQueries(
  results: readonly CollectorResult[],
  operations: readonly AccessSite[],
): { refs: SdkRef[]; queries: SdkQuery[] } {
  const refMap = new Map<string, RefAccumulator>();
  const queryMap = new Map<string, QueryAccumulator>();
  const specializedRefNodes = new Set<string>();
  const specializedQueryNodes = new Set<string>();
  const coveredQueryByTarget = new Set<string>();
  const consumedQueryByTarget = new Set<string>();

  const upsertRef = (rec: TracedRefRecord): string => {
    const key = refIdentityKey(rec);
    let acc = refMap.get(key);
    if (!acc) {
      acc = { record: rec, consumers: new Set<string>() };
      refMap.set(key, acc);
    }
    if (rec.consumer !== undefined) acc.consumers.add(rec.consumer);
    if (rec.specializedNodeKey !== undefined) specializedRefNodes.add(rec.specializedNodeKey);
    return key;
  };

  const upsertQuery = (qRec: TracedQueryRecord, baseKey: string): void => {
    const mapKey = `${qRec.anchorKey}|${baseKey}`;
    let acc = queryMap.get(mapKey);
    if (!acc) {
      acc = {
        anchorKey: qRec.anchorKey,
        baseKey,
        source: qRec.source,
        through: qRec.through,
        branches: new Map<string, readonly SdkQueryConstraint[]>(),
        consumers: new Set<string>(),
      };
      queryMap.set(mapKey, acc);
    }
    for (const branch of qRec.branchConstraints) {
      const bKey = constraintListKey(branch);
      if (!acc.branches.has(bKey)) acc.branches.set(bKey, branch);
    }
    if (qRec.consumer !== undefined) acc.consumers.add(qRec.consumer);
  };

  for (const site of operations) {
    for (const entry of SITE_USAGE.get(site) ?? []) {
      const baseKey = upsertRef(entry.refRecord);
      if (entry.queryRecord) {
        const tKey = refTargetKey(entry.refRecord);
        for (const ck of entry.queryRecord.coversKeys) {
          consumedQueryByTarget.add(`${ck}|${tKey}`);
          if (entry.queryRecord.through !== undefined) specializedQueryNodes.add(ck);
          if (`call:${ck}` !== entry.queryRecord.anchorKey) {
            coveredQueryByTarget.add(`${ck}|${tKey}`);
          }
        }
        upsertQuery(entry.queryRecord, baseKey);
      }
    }
  }

  // Cross-program coverage: if an inner wrapper query is inlined into an outer query, mark it covered.
  const allStandaloneQueries: TracedQueryRecord[] = [];
  const standaloneNodeSets: { anchorKey: string; targetKey: string; keys: Set<string> }[] = [];
  for (const r of results) {
    for (const qRec of r.usage?.queries ?? []) {
      const tKey = refTargetKey(qRec.baseRef);
      allStandaloneQueries.push(qRec);
      standaloneNodeSets.push({
        anchorKey: qRec.anchorKey,
        targetKey: tKey,
        keys: new Set(qRec.coversKeys),
      });
      for (const ck of qRec.coversKeys) {
        if (`call:${ck}` !== qRec.anchorKey) coveredQueryByTarget.add(`${ck}|${tKey}`);
      }
    }
  }

  for (const r of results) {
    for (const refRec of r.usage?.refs ?? []) {
      if (refRec.nodeKey && specializedRefNodes.has(refRec.nodeKey)) continue;
      upsertRef(refRec);
    }
  }

  for (const qRec of allStandaloneQueries) {
    const candidateBaseKey = refIdentityKey(qRec.baseRef);
    const mapKey = `${qRec.anchorKey}|${candidateBaseKey}`;
    if (queryMap.has(mapKey)) continue;
    const tKey = refTargetKey(qRec.baseRef);
    if (qRec.anchorKey.startsWith('call:')) {
      const rawNodeKey = qRec.anchorKey.slice('call:'.length);
      if (coveredQueryByTarget.has(`${rawNodeKey}|${tKey}`)) continue;
      if (specializedQueryNodes.has(rawNodeKey)) continue;
    }
    if (
      qRec.coversKeys.length > 0
      && qRec.coversKeys.every(
        (ck) => consumedQueryByTarget.has(`${ck}|${tKey}`) || specializedQueryNodes.has(ck),
      )
    ) {
      continue;
    }
    const isStrictSubsetOfAnother =
      qRec.coversKeys.length > 0
      && standaloneNodeSets.some(
        (other) =>
          other.targetKey === tKey
          && other.anchorKey !== qRec.anchorKey
          && other.keys.size > qRec.coversKeys.length
          && qRec.coversKeys.every((ck) => other.keys.has(ck)),
      );
    if (isStrictSubsetOfAnother) continue;
    const baseKey = upsertRef(qRec.baseRef);
    upsertQuery(qRec, baseKey);
  }

  const builtRefsByKey = new Map<string, SdkRef>();
  const sortedRefEntries = [...refMap.entries()].sort(([, a], [, b]) => compareRefRecords(a.record, b.record));
  const usedRefIds = new Set<string>();
  const refs: SdkRef[] = [];

  for (const [key, acc] of sortedRefEntries) {
    const rec = acc.record;
    const rendered = renderResourcePattern(rec.pattern);
    const baseId = `ref:${rec.pattern.service}:${rec.pattern.resourceId}:${rec.refKind}:${rendered}@${rec.source}`;
    const id = allocateUniqueId(baseId, usedRefIds);
    const consumedBy = [...acc.consumers].sort();
    const out: {
      id: string;
      pattern: ResourcePattern;
      refKind: RefKind;
      resolution: AccessResolution;
      reason?: string;
      pathVariables: readonly PathVariable[];
      consumedBy: readonly string[];
      source: string;
      through?: string;
    } = {
      id,
      pattern: rec.pattern,
      refKind: rec.refKind,
      resolution: rec.resolution,
      pathVariables: rec.pathVariables,
      consumedBy,
      source: rec.source,
    };
    if (rec.reason !== undefined) out.reason = rec.reason;
    if (rec.through !== undefined) out.through = rec.through;
    builtRefsByKey.set(key, out);
    refs.push(out);
  }

  const sortedQueries = [...queryMap.values()].sort(compareQueryAccumulators);
  const usedQueryIds = new Set<string>();
  const queries: SdkQuery[] = [];

  for (const acc of sortedQueries) {
    const baseRef = builtRefsByKey.get(acc.baseKey);
    if (!baseRef) continue;
    const branchList = [...acc.branches.values()];
    const primary = branchList[0] ?? [];
    const rendered = renderResourcePattern(baseRef.pattern);
    const baseId = `query:${baseRef.pattern.service}:${baseRef.pattern.resourceId}:${rendered}@${acc.source}`;
    const id = allocateUniqueId(baseId, usedQueryIds);
    const consumedBy = [...acc.consumers].sort();
    const out: {
      id: string;
      baseRef: SdkRef;
      constraints: readonly SdkQueryConstraint[];
      branches?: readonly (readonly SdkQueryConstraint[])[];
      consumedBy: readonly string[];
      source: string;
      through?: string;
    } = {
      id,
      baseRef,
      constraints: primary,
      consumedBy,
      source: acc.source,
    };
    if (branchList.length > 1) out.branches = branchList;
    if (acc.through !== undefined) out.through = acc.through;
    queries.push(out);
  }

  return { refs, queries };
}

function allocateUniqueId(baseId: string, used: Set<string>): string {
  if (!used.has(baseId)) {
    used.add(baseId);
    return baseId;
  }
  let suffix = 2;
  while (used.has(`${baseId}#${suffix}`)) {
    suffix += 1;
  }
  const unique = `${baseId}#${suffix}`;
  used.add(unique);
  return unique;
}

function isInProject(root: string, sf: ts.SourceFile, excludes: string[]): boolean {
  const filePath = toPosixPath(sf.fileName);
  if (sf.isDeclarationFile || filePath.includes('/node_modules/')) return false;
  const rel = posixRelative(root, filePath);
  if (rel.startsWith('..')) return false;
  return !isExcludedPath(rel, excludes);
}

function compareSites(a: AccessSite, b: AccessSite): number {
  const [fa, la] = splitSource(a.source);
  const [fb, lb] = splitSource(b.source);
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (la !== lb) return la - lb;
  if (a.op !== b.op) return a.op < b.op ? -1 : 1;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function compareRefRecords(a: TracedRefRecord, b: TracedRefRecord): number {
  const [fa, la] = splitSource(a.source);
  const [fb, lb] = splitSource(b.source);
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (la !== lb) return la - lb;
  if (a.pattern.service !== b.pattern.service) return a.pattern.service < b.pattern.service ? -1 : 1;
  if (a.pattern.resourceId !== b.pattern.resourceId) {
    return a.pattern.resourceId < b.pattern.resourceId ? -1 : 1;
  }
  if (a.refKind !== b.refKind) return a.refKind < b.refKind ? -1 : 1;
  const pa = renderResourcePattern(a.pattern);
  const pb = renderResourcePattern(b.pattern);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return 0;
}

function compareQueryAccumulators(a: QueryAccumulator, b: QueryAccumulator): number {
  const [fa, la] = splitSource(a.source);
  const [fb, lb] = splitSource(b.source);
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (la !== lb) return la - lb;
  if (a.anchorKey !== b.anchorKey) return a.anchorKey < b.anchorKey ? -1 : 1;
  if (a.baseKey !== b.baseKey) return a.baseKey < b.baseKey ? -1 : 1;
  return 0;
}

function splitSource(source: string): [string, number] {
  const i = source.lastIndexOf(':');
  return [source.slice(0, i), Number(source.slice(i + 1))];
}
