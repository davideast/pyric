/**
 * Resource probe collection, Storage bucket fallback matching, and owner-write
 * provenance helpers for `coverageMatrixPass`.
 */
import { isDefaultDatabaseInstance } from '@pyric/rules/internal/rtdb';
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
import { splitSourceLocation } from './source-location.js';

export interface ExercisedProbe {
  readonly pattern: ResourcePattern;
  readonly cascadeTarget: boolean;
  readonly collectionGroupOnly: boolean;
}

export interface OwnerSiteEvidence {
  readonly site: AccessSite;
  readonly pathVarName?: string;
  readonly pathVarSegmentIndex?: number;
  readonly pathVarSegmentPrefix?: string;
  readonly pathVarSegmentSuffix?: string;
  readonly pathVarCompositeDynamic?: boolean;
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

const DEFAULT_RTDB_SUFFIX_RE = /^[a-z0-9-]+-default-rtdb$/i;

export function isDefaultRtdbResourceId(
  resourceId: string,
  projectId: string | undefined,
): boolean {
  if (resourceId === DEFAULT_RESOURCE_ID) return false;
  return (
    isDefaultDatabaseInstance(resourceId, projectId)
    || (projectId === undefined && DEFAULT_RTDB_SUFFIX_RE.test(resourceId))
  );
}

export function hasExplicitRtdbInstanceRules(
  surface: RuleSurface | undefined,
  instanceId: string,
): boolean {
  if (!surface) return false;
  return surface.entries.some(
    (entry) => entry.pattern.service === 'rtdb' && entry.pattern.resourceId === instanceId,
  );
}

export function normalizeSitePattern(
  site: AccessSite,
  defaultBucket: string | undefined,
  projectId?: string,
  surface?: RuleSurface,
): ResourcePattern {
  const parsed = siteResourcePattern(site);
  if (
    site.service === 'storage'
    && parsed.resourceId === DEFAULT_RESOURCE_ID
    && defaultBucket !== undefined
  ) {
    return { ...parsed, resourceId: defaultBucket };
  }
  if (
    site.service === 'rtdb'
    && isDefaultRtdbResourceId(parsed.resourceId, projectId)
    && !hasExplicitRtdbInstanceRules(surface, parsed.resourceId)
  ) {
    return { ...parsed, resourceId: DEFAULT_RESOURCE_ID };
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

function wildcardBucketAppliesToBucket(
  surface: RuleSurface,
  wildcardEntry: RuleSurfaceEntry,
  bucketId: string,
): boolean {
  const explicitFiles = new Set<string>();
  for (const entry of surface.entries) {
    if (
      entry.pattern.service === 'storage'
      && !entry.wildcardBucket
      && entry.pattern.resourceId === bucketId
    ) {
      explicitFiles.add(splitSourceLocation(entry.source).file);
    }
  }
  if (explicitFiles.size === 0) return true;
  return explicitFiles.has(splitSourceLocation(wildcardEntry.source).file);
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
  if (pattern.resourceId !== DEFAULT_RESOURCE_ID) {
    pushAll(
      surface
        .matching({ ...pattern, resourceId: DEFAULT_RESOURCE_ID }, op)
        .filter(
          (entry) =>
            entry.wildcardBucket === true
            && wildcardBucketAppliesToBucket(surface, entry, pattern.resourceId),
        ),
    );
  }
  return out;
}

export function collectExercisedProbes(
  usage: SdkUsageIndex,
  observations: readonly RuntimePathObservation[],
  defaultBucket: string | undefined,
  projectId?: string,
  surface?: RuleSurface,
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
    const base = normalizeSitePattern(site, defaultBucket, projectId, surface);
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
    } else if (
      pat.service === 'rtdb'
      && isDefaultRtdbResourceId(pat.resourceId, projectId)
      && !hasExplicitRtdbInstanceRules(surface, pat.resourceId)
    ) {
      pat = { ...pat, resourceId: DEFAULT_RESOURCE_ID };
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
    && wildcardBucketAppliesToBucket(surface, entry, probe.pattern.resourceId)
  ) {
    probeForOverlap = { ...probe.pattern, resourceId: DEFAULT_RESOURCE_ID };
  }

  return overlapsPattern(entry.pattern, probeForOverlap, { cascadeA, cascadeB });
}

function parseAuthUidPatternAffixes(
  pattern: string | undefined,
):
  | { readonly kind: 'affix'; readonly prefix: string; readonly suffix: string }
  | { readonly kind: 'composite' }
  | undefined {
  if (!pattern || pattern === '{auth.uid}') return undefined;
  if (pattern.includes('{*}')) return { kind: 'composite' };
  const parts = pattern.split('{auth.uid}');
  if (parts.length !== 2) return { kind: 'composite' };
  return { kind: 'affix', prefix: parts[0]!, suffix: parts[1]! };
}

export function extractOwnerWriteEvidence(site: AccessSite): OwnerSiteEvidence | undefined {
  const pathVar = site.pathVariables?.find((v) => v.auth?.some((a) => a.source === 'auth.uid'));
  if (pathVar !== undefined) {
    const sitePattern = siteResourcePattern(site);
    const matchingIndices: number[] = [];
    const matchingVarSegments: Array<Extract<PatternSegment, { kind: 'var' }>> = [];
    for (let i = 0; i < sitePattern.segments.length; i += 1) {
      const seg = sitePattern.segments[i]!;
      if (seg.kind !== 'lit' && seg.name === pathVar.name) {
        matchingIndices.push(i);
        if (seg.kind === 'var') matchingVarSegments.push(seg);
      }
    }
    const out: {
      site: AccessSite;
      pathVarName: string;
      pathVarSegmentIndex?: number;
      pathVarSegmentPrefix?: string;
      pathVarSegmentSuffix?: string;
      pathVarCompositeDynamic?: boolean;
      siteSegmentCount: number;
    } = {
      site,
      pathVarName: pathVar.name,
      siteSegmentCount: sitePattern.segments.length,
    };
    if (matchingIndices.length === 1) {
      out.pathVarSegmentIndex = matchingIndices[0]!;
      const onlyVar = matchingVarSegments[0];
      if (onlyVar?.prefix) out.pathVarSegmentPrefix = onlyVar.prefix;
      if (onlyVar?.suffix) out.pathVarSegmentSuffix = onlyVar.suffix;
    } else if (matchingVarSegments.length > 0) {
      const firstPrefix = matchingVarSegments[0]!.prefix ?? '';
      const firstSuffix = matchingVarSegments[0]!.suffix ?? '';
      const uniformAffixes = matchingVarSegments.every(
        (s) => (s.prefix ?? '') === firstPrefix && (s.suffix ?? '') === firstSuffix,
      );
      if (uniformAffixes) {
        if (firstPrefix.length > 0) out.pathVarSegmentPrefix = firstPrefix;
        if (firstSuffix.length > 0) out.pathVarSegmentSuffix = firstSuffix;
      }
    }
    const parsedPattern = parseAuthUidPatternAffixes(pathVar.pattern);
    if (parsedPattern?.kind === 'composite') {
      out.pathVarCompositeDynamic = true;
    } else if (parsedPattern?.kind === 'affix') {
      if (!out.pathVarSegmentPrefix && parsedPattern.prefix.length > 0) {
        out.pathVarSegmentPrefix = parsedPattern.prefix;
      }
      if (!out.pathVarSegmentSuffix && parsedPattern.suffix.length > 0) {
        out.pathVarSegmentSuffix = parsedPattern.suffix;
      }
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

interface BoundRuleOwnerSegment {
  readonly varName: string;
  readonly rulePrefix: string;
  readonly ruleSuffix: string;
}

function toBoundRuleOwnerSegment(
  seg: Extract<PatternSegment, { kind: 'var' }>,
): BoundRuleOwnerSegment {
  return {
    varName: seg.name,
    rulePrefix: seg.prefix ?? '',
    ruleSuffix: seg.suffix ?? '',
  };
}

function findRuleOwnerSegmentVar(
  entryPattern: ResourcePattern,
  evidence: OwnerSiteEvidence,
): BoundRuleOwnerSegment | undefined {
  const entrySegs = entryPattern.segments;
  const segIdx = evidence.pathVarSegmentIndex;
  if (segIdx !== undefined) {
    if (entrySegs[0]?.kind === 'rest') {
      const siteLen = evidence.siteSegmentCount;
      if (siteLen !== undefined) {
        const alignedIdx = entrySegs.length - (siteLen - segIdx);
        if (alignedIdx >= 1 && alignedIdx < entrySegs.length) {
          const alignedSeg: PatternSegment = entrySegs[alignedIdx]!;
          if (alignedSeg.kind === 'var') return toBoundRuleOwnerSegment(alignedSeg);
        }
      }
      return undefined;
    }
    if (segIdx >= 0 && segIdx < entrySegs.length) {
      const alignedSeg: PatternSegment = entrySegs[segIdx]!;
      if (alignedSeg.kind === 'var') return toBoundRuleOwnerSegment(alignedSeg);
    }
    return undefined;
  }

  if (evidence.pathVarName !== undefined) {
    const exactMatch = entrySegs.find(
      (seg): seg is Extract<PatternSegment, { kind: 'var' }> =>
        seg.kind === 'var' && seg.name === evidence.pathVarName,
    );
    if (exactMatch !== undefined) return toBoundRuleOwnerSegment(exactMatch);
  }

  const vars = entrySegs.filter(
    (seg): seg is Extract<PatternSegment, { kind: 'var' }> => seg.kind === 'var',
  );
  if (vars.length === 1) return toBoundRuleOwnerSegment(vars[0]!);
  return undefined;
}

function quoteRulesStringLiteral(raw: string): string {
  return `'${raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function formatAffixedAuthUidExpr(
  authUidExpr: string,
  prefix: string,
  suffix: string,
): string {
  const parts: string[] = [];
  if (prefix.length > 0) parts.push(quoteRulesStringLiteral(prefix));
  parts.push(authUidExpr);
  if (suffix.length > 0) parts.push(quoteRulesStringLiteral(suffix));
  return parts.join(' + ');
}

function remainingAffixes(
  evidence: OwnerSiteEvidence,
  bound: BoundRuleOwnerSegment | undefined,
): { readonly prefix: string; readonly suffix: string } {
  const sitePrefix = evidence.pathVarSegmentPrefix ?? '';
  const siteSuffix = evidence.pathVarSegmentSuffix ?? '';
  if (!bound) return { prefix: sitePrefix, suffix: siteSuffix };
  const prefix =
    bound.rulePrefix.length > 0 && sitePrefix.startsWith(bound.rulePrefix)
      ? sitePrefix.slice(bound.rulePrefix.length)
      : sitePrefix;
  const suffix =
    bound.ruleSuffix.length > 0 && siteSuffix.endsWith(bound.ruleSuffix)
      ? siteSuffix.slice(0, siteSuffix.length - bound.ruleSuffix.length)
      : siteSuffix;
  return { prefix, suffix };
}

export function formatOverbroadRemediation(
  entry: RuleSurfaceEntry,
  evidence: OwnerSiteEvidence,
): string {
  const service = entry.pattern.service;
  if (service === 'rtdb') {
    if (evidence.pathVarName !== undefined) {
      const bound = findRuleOwnerSegmentVar(entry.pattern, evidence);
      if (evidence.pathVarCompositeDynamic) {
        return bound !== undefined
          ? `Scope ${entry.source} by verifying the composite owner key ($${bound.varName}) against auth.uid rather than direct equality.`
          : `Scope ${entry.source} by moving '.write' under a child branch for the composite owner key and verifying it against auth.uid.`;
      }
      const { prefix, suffix } = remainingAffixes(evidence, bound);
      if (bound !== undefined) {
        if (prefix.length === 0 && suffix.length === 0) {
          return `Scope ${entry.source} to the authenticated owner, e.g. "auth != null && auth.uid === $${bound.varName}".`;
        }
        const rhs = formatAffixedAuthUidExpr('auth.uid', prefix, suffix);
        return `Scope ${entry.source} to the authenticated owner, e.g. "auth != null && $${bound.varName} === ${rhs}".`;
      }
      const fallbackCheck =
        prefix.length === 0 && suffix.length === 0
          ? 'auth.uid === $uid'
          : `$uid === ${formatAffixedAuthUidExpr('auth.uid', prefix, suffix)}`;
      return `Scope ${entry.source} by moving '.write' under a '$uid' child branch for the owner key and enforcing "auth != null && ${fallbackCheck}".`;
    }
    if (evidence.payloadFieldName !== undefined) {
      return `Scope ${entry.source} to the authenticated owner, e.g. "auth != null && newData.child('${evidence.payloadFieldName}').val() === auth.uid".`;
    }
    return `Scope ${entry.source} to the authenticated owner using auth.uid (e.g. "auth != null && newData.val() === auth.uid").`;
  }

  if (service === 'storage') {
    if (evidence.pathVarName !== undefined) {
      const bound = findRuleOwnerSegmentVar(entry.pattern, evidence);
      if (evidence.pathVarCompositeDynamic) {
        return bound !== undefined
          ? `Tighten ${entry.source} to verify composite path ownership (${bound.varName}) against request.auth.uid rather than direct equality.`
          : `Tighten ${entry.source} by splitting an explicit match segment for the composite owner path component and verifying it against request.auth.uid.`;
      }
      const { prefix, suffix } = remainingAffixes(evidence, bound);
      if (bound !== undefined) {
        if (prefix.length === 0 && suffix.length === 0) {
          return `Tighten ${entry.source} to verify path ownership: allow write: if request.auth != null && request.auth.uid == ${bound.varName};`;
        }
        const rhs = formatAffixedAuthUidExpr('request.auth.uid', prefix, suffix);
        return `Tighten ${entry.source} to verify path ownership: allow write: if request.auth != null && ${bound.varName} == ${rhs};`;
      }
      const fallbackCheck =
        prefix.length === 0 && suffix.length === 0
          ? 'request.auth.uid == uid'
          : `uid == ${formatAffixedAuthUidExpr('request.auth.uid', prefix, suffix)}`;
      return `Tighten ${entry.source} by splitting an explicit '{uid}' match segment for the owner path component and enforcing: allow write: if request.auth != null && ${fallbackCheck};`;
    }
    if (evidence.metadataKeyName !== undefined) {
      return `Tighten ${entry.source} to verify upload owner metadata: allow write: if request.auth != null && request.resource.metadata.${evidence.metadataKeyName} == request.auth.uid;`;
    }
    return `Tighten ${entry.source} by binding request.auth.uid to an owner path segment or metadata field.`;
  }

  if (evidence.pathVarName !== undefined) {
    const bound = findRuleOwnerSegmentVar(entry.pattern, evidence);
    if (evidence.pathVarCompositeDynamic) {
      return bound !== undefined
        ? `Tighten ${entry.source} to verify composite document ownership (${bound.varName}) against request.auth.uid rather than direct equality.`
        : `Tighten ${entry.source} by splitting an explicit match segment for the composite owner path component and verifying it against request.auth.uid.`;
    }
    const { prefix, suffix } = remainingAffixes(evidence, bound);
    if (bound !== undefined) {
      if (prefix.length === 0 && suffix.length === 0) {
        return `Tighten ${entry.source} to verify document ownership: allow write: if request.auth != null && request.auth.uid == ${bound.varName};`;
      }
      const rhs = formatAffixedAuthUidExpr('request.auth.uid', prefix, suffix);
      return `Tighten ${entry.source} to verify document ownership: allow write: if request.auth != null && ${bound.varName} == ${rhs};`;
    }
    const fallbackCheck =
      prefix.length === 0 && suffix.length === 0
        ? 'request.auth.uid == uid'
        : `uid == ${formatAffixedAuthUidExpr('request.auth.uid', prefix, suffix)}`;
    return `Tighten ${entry.source} by splitting an explicit '{uid}' match segment for the owner path component and enforcing: allow write: if request.auth != null && ${fallbackCheck};`;
  }
  if (evidence.payloadFieldName !== undefined) {
    return `Tighten ${entry.source} to verify owner field provenance: if request.auth != null && request.resource.data.${evidence.payloadFieldName} == request.auth.uid;`;
  }
  return `Tighten ${entry.source} by checking request.auth.uid against the document path or owner field.`;
}
