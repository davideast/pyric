/**
 * Resource probe collection, Storage bucket fallback matching, and owner-write
 * provenance helpers for `coverageMatrixPass`.
 */
import { DEFAULT_RESOURCE_ID } from '../../sandbox/internal/resource-pattern-header.js';
import {
  overlapsPattern,
  parseResourcePattern,
  type PatternSegment,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import { isWriteOp } from '../code/operation-specs.js';
import type { AccessSite } from '../code/types.js';
import type { SdkUsageIndex } from '../code/usage-index.js';
import { siteResourcePattern } from '../code/usage-records.js';
import type { RuleSurface, RuleSurfaceEntry } from '../rules/rule-surface.js';
import {
  concretizeSitePatterns,
  type RuntimePathObservation,
} from './coverage-matrix-runtime.js';

export interface ExercisedProbe {
  readonly pattern: ResourcePattern;
  readonly cascadeTarget: boolean;
  readonly collectionGroupOnly: boolean;
}

export interface OwnerSiteEvidence {
  readonly site: AccessSite;
  readonly pathVarName?: string;
  readonly pathVarSegmentIndex?: number;
  readonly siteSegmentCount?: number;
  readonly payloadFieldName?: string;
  readonly metadataKeyName?: string;
}

export function appendChildWildcard(pattern: ResourcePattern, varName: string): ResourcePattern {
  return {
    ...pattern,
    segments: [...pattern.segments, { kind: 'var', name: varName }],
  };
}

export function normalizeSitePattern(
  site: AccessSite,
  defaultBucket: string | undefined,
): ResourcePattern {
  const parsed = siteResourcePattern(site);
  if (
    site.service === 'storage'
    && parsed.resourceId === DEFAULT_RESOURCE_ID
    && defaultBucket !== undefined
  ) {
    return { ...parsed, resourceId: defaultBucket };
  }
  return parsed;
}

export function entryCascades(entry: RuleSurfaceEntry): boolean {
  if (entry.pattern.service !== 'rtdb') return false;
  return entry.ops.includes('read') || entry.ops.includes('write');
}

export function hasExplicitStorageBucketRules(surface: RuleSurface, bucketId: string): boolean {
  return surface.entries.some(
    (entry) =>
      entry.pattern.service === 'storage'
      && !entry.wildcardBucket
      && entry.pattern.resourceId === bucketId,
  );
}

export function matchStorageWithBucketFallback(
  surface: RuleSurface,
  pattern: ResourcePattern,
  op: string | undefined,
  defaultBucket: string | undefined,
): RuleSurfaceEntry[] {
  const seen = new Set<RuleSurfaceEntry>();
  const out: RuleSurfaceEntry[] = [];
  const pushAll = (entries: readonly RuleSurfaceEntry[]): void => {
    for (const entry of entries) {
      if (!seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  };

  pushAll(surface.matching(pattern, op));
  if (pattern.resourceId === DEFAULT_RESOURCE_ID && defaultBucket !== undefined) {
    pushAll(surface.matching({ ...pattern, resourceId: defaultBucket }, op));
  }
  if (
    pattern.resourceId !== DEFAULT_RESOURCE_ID
    && !hasExplicitStorageBucketRules(surface, pattern.resourceId)
  ) {
    pushAll(
      surface
        .matching({ ...pattern, resourceId: DEFAULT_RESOURCE_ID }, op)
        .filter((entry) => entry.wildcardBucket === true),
    );
  }
  return out;
}

export function collectExercisedProbes(
  usage: SdkUsageIndex,
  observations: readonly RuntimePathObservation[],
  defaultBucket: string | undefined,
): ExercisedProbe[] {
  const probes: ExercisedProbe[] = [];

  const pushFirestorePattern = (pattern: ResourcePattern, refKind?: string, op?: string): void => {
    const isCg = refKind === 'collectionGroup' || pattern.segments[0]?.kind === 'rest';
    if (isCg) {
      probes.push({
        pattern: appendChildWildcard(pattern, '__doc__'),
        cascadeTarget: false,
        collectionGroupOnly: true,
      });
      return;
    }
    const isColl =
      refKind === 'collection'
      || op === 'query'
      || op === 'list'
      || op === 'getDocs'
      || (pattern.segments.length % 2 === 1 && pattern.segments.at(-1)?.kind !== 'rest');
    if (isColl) {
      probes.push({
        pattern: appendChildWildcard(pattern, '__doc__'),
        cascadeTarget: false,
        collectionGroupOnly: false,
      });
      return;
    }
    probes.push({ pattern, cascadeTarget: false, collectionGroupOnly: false });
  };

  for (const site of usage.operations) {
    if (site.resolution === 'unresolved' && site.path.length === 0) continue;
    const base = normalizeSitePattern(site, defaultBucket);
    let candidates: ResourcePattern[] = [base];
    if (site.resolution === 'partial') {
      const concretized = concretizeSitePatterns(base, observations, Boolean(site.reason));
      candidates = [base, ...concretized.map((c) => c.pattern)];
    }

    for (const pat of candidates) {
      if (pat.service === 'firestore') {
        pushFirestorePattern(pat, undefined, site.op);
      } else if (pat.service === 'storage') {
        probes.push({ pattern: pat, cascadeTarget: false, collectionGroupOnly: false });
        if (site.op === 'list' || site.op === 'listAll') {
          probes.push({
            pattern: appendChildWildcard(pat, '__object__'),
            cascadeTarget: false,
            collectionGroupOnly: false,
          });
        }
      } else {
        probes.push({
          pattern: pat,
          cascadeTarget: isWriteOp(site.op),
          collectionGroupOnly: false,
        });
      }
    }
  }

  for (const ref of usage.refs) {
    if (ref.resolution === 'unresolved' && ref.pattern.segments.length === 0) continue;
    let pat = ref.pattern;
    if (pat.service === 'storage' && pat.resourceId === DEFAULT_RESOURCE_ID && defaultBucket !== undefined) {
      pat = { ...pat, resourceId: defaultBucket };
    }
    if (pat.service === 'firestore') {
      pushFirestorePattern(pat, ref.refKind);
    } else {
      probes.push({ pattern: pat, cascadeTarget: false, collectionGroupOnly: false });
    }
  }

  for (const q of usage.queries) {
    const qr = q.baseRef;
    if (qr.resolution === 'unresolved' && qr.pattern.segments.length === 0) continue;
    if (qr.pattern.service === 'firestore') {
      pushFirestorePattern(qr.pattern, qr.refKind, 'query');
    } else if (qr.pattern.service === 'rtdb') {
      probes.push({ pattern: qr.pattern, cascadeTarget: false, collectionGroupOnly: false });
      probes.push({
        pattern: appendChildWildcard(qr.pattern, '__child__'),
        cascadeTarget: false,
        collectionGroupOnly: false,
      });
    } else {
      probes.push({ pattern: qr.pattern, cascadeTarget: false, collectionGroupOnly: false });
    }
  }

  for (const obs of observations) {
    const pat = parseResourcePattern(obs.service, obs.concretePath, obs.resourceId);
    if (obs.service === 'firestore' && obs.isCollectionPrefix) {
      pushFirestorePattern(pat, 'collection', 'query');
    } else {
      probes.push({ pattern: pat, cascadeTarget: false, collectionGroupOnly: false });
    }
  }

  return probes;
}

export function entryMatchesProbe(
  entry: RuleSurfaceEntry,
  probe: ExercisedProbe,
  surface: RuleSurface,
): boolean {
  if (entry.pattern.service !== probe.pattern.service) return false;
  if (probe.collectionGroupOnly && entry.pattern.segments[0]?.kind !== 'rest') {
    return false;
  }

  const cascadeA = entryCascades(entry);
  const cascadeB =
    probe.cascadeTarget
    && entry.pattern.service === 'rtdb'
    && entry.ops.every((op) => op === 'validate');

  let probeForOverlap = probe.pattern;
  if (
    entry.pattern.service === 'storage'
    && entry.wildcardBucket === true
    && probe.pattern.resourceId !== DEFAULT_RESOURCE_ID
    && !hasExplicitStorageBucketRules(surface, probe.pattern.resourceId)
  ) {
    probeForOverlap = { ...probe.pattern, resourceId: DEFAULT_RESOURCE_ID };
  }

  return overlapsPattern(entry.pattern, probeForOverlap, { cascadeA, cascadeB });
}

export function extractOwnerWriteEvidence(site: AccessSite): OwnerSiteEvidence | undefined {
  const pathVar = site.pathVariables?.find((v) => v.auth?.some((a) => a.source === 'auth.uid'));
  if (pathVar !== undefined) {
    const sitePattern = parseResourcePattern(site.service, site.path, site.resourceId);
    const matchingIndices: number[] = [];
    for (let i = 0; i < sitePattern.segments.length; i += 1) {
      const seg = sitePattern.segments[i]!;
      if (seg.kind !== 'lit' && seg.name === pathVar.name) {
        matchingIndices.push(i);
      }
    }
    const out: {
      site: AccessSite;
      pathVarName: string;
      pathVarSegmentIndex?: number;
      siteSegmentCount: number;
    } = {
      site,
      pathVarName: pathVar.name,
      siteSegmentCount: sitePattern.segments.length,
    };
    if (matchingIndices.length === 1) {
      out.pathVarSegmentIndex = matchingIndices[0]!;
    }
    return out;
  }
  const customMeta = site.storageUpload?.customMetadata;
  if (customMeta) {
    for (const key of Object.keys(customMeta).sort()) {
      if (!Object.hasOwn(customMeta, key)) continue;
      const field = customMeta[key];
      if (field?.auth?.some((a) => a.source === 'auth.uid')) {
        return { site, metadataKeyName: key };
      }
    }
  }
  const payloadField = site.payload?.fields.find((f) => f.auth?.some((a) => a.source === 'auth.uid'));
  if (payloadField !== undefined) {
    return { site, payloadFieldName: payloadField.name };
  }
  if (site.payload?.auth?.some((a) => a.source === 'auth.uid')) {
    return { site };
  }
  return undefined;
}

function findRuleOwnerSegmentVar(
  entryPattern: ResourcePattern,
  evidence: OwnerSiteEvidence,
): string {
  const fallbackVar = evidence.pathVarName ?? 'uid';
  const entrySegs = entryPattern.segments;
  const segIdx = evidence.pathVarSegmentIndex;
  if (segIdx !== undefined) {
    if (entrySegs[0]?.kind === 'rest') {
      const siteLen = evidence.siteSegmentCount;
      if (siteLen !== undefined) {
        const alignedIdx = entrySegs.length - (siteLen - segIdx);
        if (alignedIdx >= 1 && alignedIdx < entrySegs.length) {
          const alignedSeg: PatternSegment = entrySegs[alignedIdx]!;
          if (alignedSeg.kind === 'var') return alignedSeg.name;
        }
      }
      return fallbackVar;
    }
    if (segIdx >= 0 && segIdx < entrySegs.length) {
      const alignedSeg: PatternSegment = entrySegs[segIdx]!;
      if (alignedSeg.kind === 'var') return alignedSeg.name;
    }
    return fallbackVar;
  }

  const exactMatch = entrySegs.find(
    (seg): seg is Extract<PatternSegment, { kind: 'var' }> =>
      seg.kind === 'var' && seg.name === fallbackVar,
  );
  if (exactMatch !== undefined) return exactMatch.name;

  const vars = entrySegs.filter(
    (seg): seg is Extract<PatternSegment, { kind: 'var' }> => seg.kind === 'var',
  );
  if (vars.length === 1) return vars[0]!.name;
  return fallbackVar;
}

export function formatOverbroadRemediation(
  entry: RuleSurfaceEntry,
  evidence: OwnerSiteEvidence,
): string {
  const service = entry.pattern.service;
  if (service === 'rtdb') {
    if (evidence.pathVarName !== undefined) {
      const ruleVar = findRuleOwnerSegmentVar(entry.pattern, evidence);
      return `Scope ${entry.source} to the authenticated owner, e.g. "auth != null && auth.uid === $${ruleVar}".`;
    }
    if (evidence.payloadFieldName !== undefined) {
      return `Scope ${entry.source} to the authenticated owner, e.g. "auth != null && newData.child('${evidence.payloadFieldName}').val() === auth.uid".`;
    }
    return `Scope ${entry.source} to the authenticated owner using auth.uid (e.g. "auth != null && newData.val() === auth.uid").`;
  }

  if (service === 'storage') {
    if (evidence.pathVarName !== undefined) {
      const ruleVar = findRuleOwnerSegmentVar(entry.pattern, evidence);
      return `Tighten ${entry.source} to verify path ownership: allow write: if request.auth != null && request.auth.uid == ${ruleVar};`;
    }
    if (evidence.metadataKeyName !== undefined) {
      return `Tighten ${entry.source} to verify upload owner metadata: allow write: if request.auth != null && request.resource.metadata.${evidence.metadataKeyName} == request.auth.uid;`;
    }
    return `Tighten ${entry.source} by binding request.auth.uid to an owner path segment or metadata field.`;
  }

  if (evidence.pathVarName !== undefined) {
    const ruleVar = findRuleOwnerSegmentVar(entry.pattern, evidence);
    return `Tighten ${entry.source} to verify document ownership: allow write: if request.auth != null && request.auth.uid == ${ruleVar};`;
  }
  if (evidence.payloadFieldName !== undefined) {
    return `Tighten ${entry.source} to verify owner field provenance: if request.auth != null && request.resource.data.${evidence.payloadFieldName} == request.auth.uid;`;
  }
  return `Tighten ${entry.source} by checking request.auth.uid against the document path or owner field.`;
}
