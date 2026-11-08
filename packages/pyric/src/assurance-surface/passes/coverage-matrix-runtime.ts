/**
 * Runtime observation extraction and hybrid `partial` path concretization for
 * `coverageMatrixPass`, joining `SandboxSnapshot` state and `sandbox.history()`
 * events with static `ResourcePattern` templates.
 */
import type { DiagnosticRuntimeSite } from '../../sandbox/internal/assurance-diagnostic.js';
import {
  DEFAULT_RESOURCE_ID,
  extractServiceHeader,
  normalizeExplicitResourceId,
  resolveConcreteResourceId,
} from '../../sandbox/internal/resource-pattern-header.js';
import {
  matchesConcrete,
  type AssuranceService,
  type PatternSegment,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type { SandboxSnapshot } from '../../sandbox/internal/snapshot-codec.js';
import type { SandboxEvent } from '../../sandbox/types/events.js';

export type SandboxHistoryEvent = SandboxEvent;

export interface CoverageMatrixRuntimeInput {
  readonly snapshot?: SandboxSnapshot;
  readonly history?: readonly SandboxHistoryEvent[];
  readonly defaultBucket?: string;
}

export interface RuntimePathObservation {
  readonly service: AssuranceService;
  readonly resourceId: string;
  readonly concretePath: string;
  readonly segments: readonly string[];
  readonly source: string;
  readonly isCollectionPrefix?: boolean;
}

export interface ConcretizedPatternResult {
  readonly pattern: ResourcePattern;
  readonly runtimeSite?: DiagnosticRuntimeSite;
}

const MAX_RTDB_WALK_DEPTH = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAssuranceService(service: string): service is AssuranceService {
  return service === 'firestore' || service === 'rtdb' || service === 'storage';
}

function splitConcreteSegments(rawBody: string): string[] {
  return rawBody
    .trim()
    .split('/')
    .filter((segment) => segment.length > 0);
}

function appendObservation(
  out: RuntimePathObservation[],
  seen: Set<string>,
  service: AssuranceService,
  explicitResourceId: string | undefined,
  rawPath: string,
  source: string,
  isCollectionPrefix = false,
): void {
  const header = extractServiceHeader(service, rawPath);
  const resourceId =
    resolveConcreteResourceId(service, explicitResourceId, header)
    ?? normalizeExplicitResourceId(service, explicitResourceId)
    ?? DEFAULT_RESOURCE_ID;
  const segments = splitConcreteSegments(header.bodyPath);
  if (segments.length === 0) return;

  const concretePath = segments.join('/');
  let prefixFlag = '0';
  if (isCollectionPrefix) prefixFlag = '1';
  const dedupeKey = `${service}|${resourceId}|${concretePath}|${prefixFlag}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);

  const obs: {
    service: AssuranceService;
    resourceId: string;
    concretePath: string;
    segments: readonly string[];
    source: string;
    isCollectionPrefix?: boolean;
  } = {
    service,
    resourceId,
    concretePath,
    segments,
    source,
  };
  if (isCollectionPrefix) obs.isCollectionPrefix = true;
  out.push(obs);
}

function walkRtdbSnapshotTree(
  node: unknown,
  prefix: readonly string[],
  resourceId: string,
  source: string,
  out: RuntimePathObservation[],
  seen: Set<string>,
): void {
  if (node === null || node === undefined) return;
  if (prefix.length > MAX_RTDB_WALK_DEPTH) return;

  let effective: unknown = node;
  if (isPlainObject(node) && Object.hasOwn(node, '.value')) {
    effective = node['.value'];
    if (effective === null || effective === undefined) return;
  }

  if (prefix.length > 0) {
    appendObservation(out, seen, 'rtdb', resourceId, prefix.join('/'), source);
  }

  if (!isPlainObject(effective)) return;
  const childKeys = Object.keys(effective).sort();
  for (const key of childKeys) {
    if (key.length === 0 || key.startsWith('.')) continue;
    walkRtdbSnapshotTree(effective[key], [...prefix, key], resourceId, source, out, seen);
  }
}

function detailStringField(
  detail: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  if (!detail || !Object.hasOwn(detail, key)) return undefined;
  const val = detail[key];
  if (typeof val === 'string' && val.length > 0) return val;
  return undefined;
}

function collectSnapshotObservations(
  snapshot: SandboxSnapshot,
  defaultBucket: string | undefined,
  out: RuntimePathObservation[],
  seen: Set<string>,
): void {
  for (const dbKey of Object.keys(snapshot.firestore).sort()) {
    const docs = snapshot.firestore[dbKey];
    if (!docs) continue;
    const resourceId = normalizeExplicitResourceId('firestore', dbKey) ?? DEFAULT_RESOURCE_ID;
    const source = `snapshot:firestore:${resourceId}`;
    for (const docPath of Object.keys(docs).sort()) {
      appendObservation(out, seen, 'firestore', resourceId, docPath, source);
    }
  }

  for (const instanceKey of Object.keys(snapshot.rtdb).sort()) {
    const tree = snapshot.rtdb[instanceKey];
    const resourceId = normalizeExplicitResourceId('rtdb', instanceKey) ?? DEFAULT_RESOURCE_ID;
    const source = `snapshot:rtdb:${resourceId}`;
    walkRtdbSnapshotTree(tree, [], resourceId, source, out, seen);
  }

  for (const bucketKey of Object.keys(snapshot.storage).sort()) {
    const objects = snapshot.storage[bucketKey];
    if (!objects) continue;
    let resourceId = normalizeExplicitResourceId('storage', bucketKey) ?? DEFAULT_RESOURCE_ID;
    if (resourceId === DEFAULT_RESOURCE_ID && defaultBucket !== undefined) {
      resourceId = defaultBucket;
    }
    const source = `snapshot:storage:${resourceId}`;
    for (const obj of objects) {
      appendObservation(out, seen, 'storage', resourceId, obj.path, source);
    }
  }
}

function explicitEventResourceId(
  service: AssuranceService,
  instance: string | undefined,
  detail: Readonly<Record<string, unknown>> | undefined,
  defaultBucket: string | undefined,
): string | undefined {
  if (service === 'rtdb') return instance;
  if (service === 'storage') {
    return detailStringField(detail, 'bucket') ?? defaultBucket;
  }
  return detailStringField(detail, 'databaseId');
}

function collectHistoryEventObservation(
  event: SandboxHistoryEvent,
  defaultBucket: string | undefined,
  out: RuntimePathObservation[],
  seen: Set<string>,
): void {
  const source = `history:${event.kind}:${event.id}`;
  if (event.kind === 'request' || event.kind === 'write') {
    const dbId = detailStringField(event.detail, 'databaseId');
    const segCount = splitConcreteSegments(extractServiceHeader('firestore', event.path).bodyPath).length;
    const isColl = event.kind === 'request' && event.method === 'list' && segCount % 2 === 1;
    appendObservation(out, seen, 'firestore', dbId, event.path, source, isColl);
    return;
  }

  if (
    event.kind === 'snapshot_delivery'
    || event.kind === 'snapshot_suppressed'
    || event.kind === 'listener_attach'
    || event.kind === 'listener_detach'
    || event.kind === 'listener_errored'
  ) {
    if (event.target.kind === 'doc') {
      appendObservation(out, seen, 'firestore', undefined, event.target.path, source);
    } else if (!event.target.collectionGroup) {
      appendObservation(out, seen, 'firestore', undefined, event.target.collection, source, true);
    }
    if (event.kind === 'snapshot_delivery' && event.sample?.docs) {
      for (const doc of event.sample.docs) {
        appendObservation(out, seen, 'firestore', undefined, doc.path, source);
      }
    }
    return;
  }

  if (event.kind === 'operation' || event.kind === 'commit' || event.kind === 'runtime_error') {
    if (!isAssuranceService(event.service) || !event.path) return;
    let instance: string | undefined;
    if (Object.hasOwn(event, 'instance')) {
      instance = (event as { instance?: string }).instance;
    }
    const resId = explicitEventResourceId(event.service, instance, event.detail, defaultBucket);
    const segCount = splitConcreteSegments(extractServiceHeader(event.service, event.path).bodyPath).length;
    const isColl = event.service === 'firestore' && segCount % 2 === 1;
    appendObservation(out, seen, event.service, resId, event.path, source, isColl);
    return;
  }

  if (event.kind === 'service_mutation') {
    if ((event.service === 'rtdb' || event.service === 'storage') && event.path) {
      let instance: string | undefined;
      if (event.service === 'rtdb') instance = event.instance;
      const resId = explicitEventResourceId(event.service, instance, event.detail, defaultBucket);
      appendObservation(out, seen, event.service, resId, event.path, source);
    }
    return;
  }

  if (event.kind === 'listener') {
    if (isAssuranceService(event.service) && event.target.path) {
      const resId = explicitEventResourceId(event.service, event.instance, event.detail, defaultBucket);
      const segCount = splitConcreteSegments(extractServiceHeader(event.service, event.target.path).bodyPath).length;
      const isColl = event.service === 'firestore' && segCount % 2 === 1;
      appendObservation(out, seen, event.service, resId, event.target.path, source, isColl);
    }
  }
}

export function collectRuntimeObservations(
  runtime: CoverageMatrixRuntimeInput | undefined,
): RuntimePathObservation[] {
  if (!runtime) return [];
  const defaultBucket = normalizeExplicitResourceId('storage', runtime.defaultBucket);
  const out: RuntimePathObservation[] = [];
  const seen = new Set<string>();

  if (runtime.snapshot) {
    collectSnapshotObservations(runtime.snapshot, defaultBucket, out, seen);
  }
  if (runtime.history) {
    for (const event of runtime.history) {
      collectHistoryEventObservation(event, defaultBucket, out, seen);
    }
  }
  return out;
}

function extractAffixInnerValue(
  seg: Extract<PatternSegment, { readonly kind: 'var' }>,
  concreteSeg: string,
): string | null {
  const prefix = seg.prefix ?? '';
  const suffix = seg.suffix ?? '';
  if (prefix.length === 0 && suffix.length === 0) {
    if (concreteSeg.length === 0) return null;
    return concreteSeg;
  }
  if (
    concreteSeg.length < prefix.length + suffix.length
    || !concreteSeg.startsWith(prefix)
    || !concreteSeg.endsWith(suffix)
  ) {
    return null;
  }
  return concreteSeg.slice(prefix.length, concreteSeg.length - suffix.length);
}

function observationMatchesScope(
  pattern: ResourcePattern,
  obs: RuntimePathObservation,
  allowDefaultFallback: boolean,
): boolean {
  if (pattern.service !== obs.service) return false;
  if (pattern.resourceId === obs.resourceId) return true;
  if (
    pattern.service === 'storage'
    && (pattern.resourceId === DEFAULT_RESOURCE_ID || obs.resourceId === DEFAULT_RESOURCE_ID)
  ) {
    return true;
  }
  if (allowDefaultFallback && pattern.resourceId === DEFAULT_RESOURCE_ID) {
    return true;
  }
  return false;
}

const MAX_CONCRETIZED_CANDIDATES = 8;

interface ScoredConcretization {
  readonly score: number;
  readonly key: string;
  readonly result: ConcretizedPatternResult;
}

export function concretizeSitePatterns(
  pattern: ResourcePattern,
  observations: readonly RuntimePathObservation[],
  allowDefaultFallback = false,
): readonly ConcretizedPatternResult[] {
  if (pattern.segments.length === 0 || observations.length === 0) {
    return [{ pattern }];
  }
  const hasLiteralAnchor = pattern.segments.some((seg) => seg.kind === 'lit');
  if (!hasLiteralAnchor) {
    return [{ pattern }];
  }

  const byPatternKey = new Map<string, ScoredConcretization>();

  const recordCandidate = (
    candidatePattern: ResourcePattern,
    obs: RuntimePathObservation,
    score: number,
  ): void => {
    const rendered = candidatePattern.segments
      .map((s) => {
        if (s.kind === 'lit') return s.text;
        if (s.kind === 'rest') return `{${s.name}=**}`;
        return `${s.prefix ?? ''}{${s.name}}${s.suffix ?? ''}`;
      })
      .join('/');
    const key = `${candidatePattern.service}|${candidatePattern.resourceId}|${rendered}`;
    const existing = byPatternKey.get(key);
    if (existing !== undefined && existing.score >= score) return;
    byPatternKey.set(key, {
      score,
      key,
      result: {
        pattern: candidatePattern,
        runtimeSite: {
          source: obs.source,
          concretePath: obs.concretePath,
        },
      },
    });
  };

  for (const obs of observations) {
    if (!observationMatchesScope(pattern, obs, allowDefaultFallback)) continue;

    let resolvedResourceId = pattern.resourceId;
    if (resolvedResourceId === DEFAULT_RESOURCE_ID && obs.resourceId !== DEFAULT_RESOURCE_ID) {
      resolvedResourceId = obs.resourceId;
    }

    const scopedPattern: ResourcePattern = { ...pattern, resourceId: obs.resourceId };
    if (matchesConcrete(scopedPattern, obs.concretePath, obs.resourceId)) {
      const fullScore = 10_000 + obs.segments.length;
      recordCandidate(
        {
          service: pattern.service,
          resourceId: resolvedResourceId,
          segments: obs.segments.map((text): PatternSegment => ({ kind: 'lit', text })),
        },
        obs,
        fullScore,
      );
      continue;
    }

    const maxPrefix = Math.min(pattern.segments.length, obs.segments.length);
    const bindings = new Map<string, string>();
    let matchedLits = 0;
    let matchedVars = 0;
    for (let i = 0; i < maxPrefix; i += 1) {
      const pSeg = pattern.segments[i]!;
      const cSeg = obs.segments[i]!;
      if (pSeg.kind === 'lit') {
        if (pSeg.text !== cSeg) break;
        matchedLits += 1;
      } else if (pSeg.kind === 'var') {
        const inner = extractAffixInnerValue(pSeg, cSeg);
        if (inner === null) break;
        const prior = bindings.get(pSeg.name);
        if (prior !== undefined && prior !== inner) break;
        bindings.set(pSeg.name, inner);
        matchedVars += 1;
      } else {
        break;
      }
    }

    if (matchedLits >= 1 && matchedVars >= 1) {
      const prefixScore = (matchedLits + matchedVars) * 100 + matchedLits;
      const substituted = pattern.segments.map((seg): PatternSegment => {
        if (seg.kind !== 'var') return seg;
        const bound = bindings.get(seg.name);
        if (bound === undefined) return seg;
        const prefix = seg.prefix ?? '';
        const suffix = seg.suffix ?? '';
        return { kind: 'lit', text: `${prefix}${bound}${suffix}` };
      });
      recordCandidate(
        {
          service: pattern.service,
          resourceId: resolvedResourceId,
          segments: substituted,
        },
        obs,
        prefixScore,
      );
    }
  }

  if (byPatternKey.size === 0) {
    return [{ pattern }];
  }

  const sorted = [...byPatternKey.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });
  return sorted.slice(0, MAX_CONCRETIZED_CANDIDATES).map((entry) => entry.result);
}

export function concretizeSitePattern(
  pattern: ResourcePattern,
  observations: readonly RuntimePathObservation[],
  allowDefaultFallback = false,
): ConcretizedPatternResult {
  return concretizeSitePatterns(pattern, observations, allowDefaultFallback)[0]!;
}
