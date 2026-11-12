/**
 * Tri-source coverage matrix pass (`coverageMatrixPass`):
 * joins `SdkUsageIndex`, `RuleSurface`, and optional `SandboxSnapshot` +
 * `sandbox.history()` runtime observations via `ResourcePattern` to detect:
 *  - `uncovered-client-operation` (guaranteed `PERMISSION_DENIED`)
 *  - `orphaned-security-rule` (0 code sites and 0 runtime paths)
 *  - `overbroad-auth-only-write` (`auth != null` write rules on owner-scoped paths/payloads)
 */
import {
  allocateDiagnosticId,
  buildCodeSite,
  sortAssuranceDiagnostics,
  type AssuranceDiagnostic,
  type DiagnosticCertainty,
  type DiagnosticRuntimeSite,
  type DiagnosticSeverity,
} from '../../sandbox/internal/assurance-diagnostic.js';
import { normalizeExplicitResourceId } from '../../sandbox/internal/resource-pattern-header.js';
import {
  renderResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import { isWriteOp } from '../code/operation-specs.js';
import type { AccessSite, PayloadField, PayloadShape } from '../code/types.js';
import type { SdkUsageIndex } from '../code/usage-index.js';
import {
  projectRuleSurface,
  type ProjectRuleSurfaceInput,
  type RuleSurface,
  type RuleSurfaceEntry,
} from '../rules/rule-surface.js';
import {
  appendChildWildcard,
  collectExercisedProbes,
  entryMatchesProbe,
  extractOwnerWriteEvidence,
  formatOverbroadRemediation,
  matchStorageWithBucketFallback,
  normalizeSitePattern,
  type OwnerSiteEvidence,
} from './coverage-matrix-probes.js';
import {
  collectRuntimeObservations,
  concretizeSitePatterns,
  type CoverageMatrixRuntimeInput,
} from './coverage-matrix-runtime.js';

export type {
  ConcretizedPatternResult,
  CoverageMatrixRuntimeInput,
  RuntimePathObservation,
  SandboxHistoryEvent,
} from './coverage-matrix-runtime.js';

export type CoverageMatrixRuleInput = RuleSurface | ProjectRuleSurfaceInput;

function isRuleSurface(input: CoverageMatrixRuleInput): input is RuleSurface {
  return Object.hasOwn(input, 'entries') && typeof (input as RuleSurface).matching === 'function';
}

function resolveRuleSurface(input: CoverageMatrixRuleInput): RuleSurface {
  if (isRuleSurface(input)) return input;
  return projectRuleSurface(input);
}

const RTDB_VALIDATE_GATED_WRITE_OPS = new Set([
  'set',
  'push',
  'update',
  'onDisconnect.set',
  'onDisconnect.update',
]);

const GUARANTEED_NON_NULL_LEAF_KINDS = new Set<PayloadField['kind']>([
  'string',
  'number',
  'boolean',
  'serverTimestamp',
  'increment',
]);

function isGuaranteedNonNullRtdbItem(
  item: Pick<PayloadField, 'kind' | 'literal' | 'nonEmpty'>,
): boolean {
  if (item.literal === null) return false;
  if (GUARANTEED_NON_NULL_LEAF_KINDS.has(item.kind)) return true;
  if (item.kind === 'array' && item.nonEmpty === true) return true;
  return false;
}

function hasGuaranteedNonNullRtdbPayload(payload: PayloadShape | undefined): boolean {
  if (payload === undefined) return false;
  if (isGuaranteedNonNullRtdbItem(payload)) {
    return true;
  }
  if (payload.kind === 'object') {
    return payload.fields.some(
      (field) => !field.optional && isGuaranteedNonNullRtdbItem(field),
    );
  }
  return false;
}

function effectiveClientOp(site: AccessSite): string {
  if (site.service === 'rtdb' && RTDB_VALIDATE_GATED_WRITE_OPS.has(site.op)) {
    if (!hasGuaranteedNonNullRtdbPayload(site.payload)) {
      return 'remove';
    }
  }
  return site.op;
}

function matchingEntriesForClientOp(
  surface: RuleSurface,
  pattern: ResourcePattern,
  op: string,
  defaultBucket: string | undefined,
): readonly RuleSurfaceEntry[] {
  if (pattern.service === 'firestore') {
    const isCollectionQuery = op === 'query' || op === 'list' || op === 'getDocs';
    if (isCollectionQuery) {
      if (pattern.segments[0]?.kind === 'rest') {
        const docPattern = appendChildWildcard(pattern, '__doc__');
        return surface
          .matching(docPattern, op)
          .filter((entry) => entry.pattern.segments[0]?.kind === 'rest');
      }
      const lastSeg = pattern.segments.at(-1);
      if (pattern.segments.length % 2 === 1 && lastSeg?.kind !== 'rest') {
        return surface.matching(appendChildWildcard(pattern, '__doc__'), op);
      }
    }
    return surface.matching(pattern, op);
  }

  if (pattern.service === 'storage') {
    if (op === 'list' || op === 'listAll') {
      const seen = new Set<RuleSurfaceEntry>();
      const out: RuleSurfaceEntry[] = [];
      for (const candidate of [pattern, appendChildWildcard(pattern, '__object__')]) {
        for (const entry of matchStorageWithBucketFallback(surface, candidate, op, defaultBucket)) {
          if (!seen.has(entry)) {
            seen.add(entry);
            out.push(entry);
          }
        }
      }
      return out;
    }
    return matchStorageWithBucketFallback(surface, pattern, op, defaultBucket);
  }

  return surface.matching(pattern, op);
}

function emitUncoveredDiagnostic(
  diagnostics: AssuranceDiagnostic[],
  usedIds: Set<string>,
  site: AccessSite,
  pattern: ResourcePattern,
  certainty: DiagnosticCertainty,
  severity: DiagnosticSeverity,
  matchedDenyEntries: readonly RuleSurfaceEntry[],
  runtimeSite: DiagnosticRuntimeSite | undefined,
): void {
  const renderedPath = renderResourcePattern(pattern);
  const id = allocateDiagnosticId(
    `uncovered-client-operation:${site.service}:${pattern.resourceId}:${renderedPath}:${site.op}:${site.source}`,
    usedIds,
  );
  const denyEntry = matchedDenyEntries[0];
  let reasonClause = 'is not matched by any security rule';
  if (denyEntry !== undefined) {
    reasonClause = `matches only unconditionally denied rule (${denyEntry.source})`;
  }
  const diag: {
    id: string;
    code: string;
    service: AccessSite['service'];
    resourceId: string;
    severity: DiagnosticSeverity;
    certainty: DiagnosticCertainty;
    message: string;
    resource: ResourcePattern;
    codeSite: { source: string; through?: string };
    ruleSite?: { source: string; expression?: string };
    runtimeSite?: DiagnosticRuntimeSite;
    remediation: string;
  } = {
    id,
    code: 'uncovered-client-operation',
    service: site.service,
    resourceId: pattern.resourceId,
    severity,
    certainty,
    message:
      `Client ${site.service} '${site.op}' on '${renderedPath}' ${reasonClause} and will fail with PERMISSION_DENIED.`,
    resource: pattern,
    codeSite: buildCodeSite(site.source, site.through),
    remediation:
      `Add an explicit rule covering '${renderedPath}' for '${site.op}' on ${site.service} (${pattern.resourceId}), or remove the client call.`,
  };
  if (denyEntry !== undefined) {
    diag.ruleSite = { source: denyEntry.source, expression: 'false' };
  }
  if (runtimeSite !== undefined) {
    diag.runtimeSite = runtimeSite;
  }
  diagnostics.push(diag);
}

export function coverageMatrixPass(
  usage: SdkUsageIndex,
  ruleSurface: CoverageMatrixRuleInput,
  runtime?: CoverageMatrixRuntimeInput,
): AssuranceDiagnostic[] {
  const surface = resolveRuleSurface(ruleSurface);
  const defaultBucket = normalizeExplicitResourceId('storage', runtime?.defaultBucket);
  const projectId = runtime?.projectId;
  const observations = collectRuntimeObservations(runtime);
  const diagnostics: AssuranceDiagnostic[] = [];
  const usedIds = new Set<string>();

  const ownerWriteEvidenceByEntry = new Map<RuleSurfaceEntry, OwnerSiteEvidence>();

  for (const site of usage.operations) {
    if (site.admin) continue;
    if (site.op === 'ref' || site.resolution === 'unresolved') continue;

    const rawPattern = normalizeSitePattern(site, defaultBucket, projectId, surface);
    const hasPatternVars = rawPattern.segments.some((seg) => seg.kind !== 'lit');
    const clientOp = effectiveClientOp(site);

    if (site.resolution === 'resolved') {
      const staticMatches = matchingEntriesForClientOp(surface, rawPattern, clientOp, defaultBucket);
      const staticPermissive = staticMatches.filter((entry) => !entry.alwaysDeny);
      if (staticPermissive.length === 0) {
        emitUncoveredDiagnostic(
          diagnostics,
          usedIds,
          site,
          rawPattern,
          'static-proof',
          'high',
          staticMatches,
          undefined,
        );
        continue;
      }

      if (hasPatternVars && observations.length > 0) {
        const concretized = concretizeSitePatterns(rawPattern, observations, false);
        for (const cand of concretized) {
          if (!cand.runtimeSite) continue;
          const candMatches = matchingEntriesForClientOp(surface, cand.pattern, clientOp, defaultBucket);
          const candPermissive = candMatches.filter((entry) => !entry.alwaysDeny);
          if (candPermissive.length === 0) {
            emitUncoveredDiagnostic(
              diagnostics,
              usedIds,
              site,
              cand.pattern,
              'heuristic',
              'medium',
              candMatches,
              cand.runtimeSite,
            );
            break;
          }
        }
      }

      if (isWriteOp(site.op)) {
        const ownerEv = extractOwnerWriteEvidence(site);
        if (ownerEv !== undefined) {
          for (const entry of staticPermissive) {
            if (entry.overbroadAuthOnlyWrite && !ownerWriteEvidenceByEntry.has(entry)) {
              ownerWriteEvidenceByEntry.set(entry, ownerEv);
            }
          }
        }
      }
      continue;
    }

    const candidates = concretizeSitePatterns(rawPattern, observations, Boolean(site.reason));
    let emittedUncovered = false;
    for (const cand of candidates) {
      const candMatches = matchingEntriesForClientOp(surface, cand.pattern, clientOp, defaultBucket);
      const candPermissive = candMatches.filter((entry) => !entry.alwaysDeny);
      if (candPermissive.length === 0 && !emittedUncovered) {
        emittedUncovered = true;
        emitUncoveredDiagnostic(
          diagnostics,
          usedIds,
          site,
          cand.pattern,
          'heuristic',
          'medium',
          candMatches,
          cand.runtimeSite,
        );
      } else if (isWriteOp(site.op)) {
        const ownerEv = extractOwnerWriteEvidence(site);
        if (ownerEv !== undefined) {
          for (const entry of candPermissive) {
            if (entry.overbroadAuthOnlyWrite && !ownerWriteEvidenceByEntry.has(entry)) {
              ownerWriteEvidenceByEntry.set(entry, ownerEv);
            }
          }
        }
      }
    }
  }

  const exercisedProbes = collectExercisedProbes(usage, observations, defaultBucket, projectId, surface);
  for (const entry of surface.entries) {
    if (entry.alwaysDeny) continue;
    if (entry.ops.length === 0) continue;

    const isExercised = exercisedProbes.some((probe) => entryMatchesProbe(entry, probe, surface));
    if (!isExercised) {
      const renderedPath = renderResourcePattern(entry.pattern);
      const id = allocateDiagnosticId(
        `orphaned-security-rule:${entry.pattern.service}:${entry.pattern.resourceId}:${renderedPath}:${entry.source}`,
        usedIds,
      );
      diagnostics.push({
        id,
        code: 'orphaned-security-rule',
        service: entry.pattern.service,
        resourceId: entry.pattern.resourceId,
        severity: 'low',
        certainty: 'heuristic',
        message:
          `Security rule on '${renderedPath}' (${entry.source}) has 0 matching SDK access sites and 0 observed sandbox resources.`,
        resource: entry.pattern,
        ruleSite: { source: entry.source },
        remediation:
          `Verify whether '${renderedPath}' in ${entry.source} is legacy dead configuration that can be removed or restricted.`,
      });
    }
  }

  for (const [entry, evidence] of ownerWriteEvidenceByEntry) {
    const renderedPath = renderResourcePattern(entry.pattern);
    const id = allocateDiagnosticId(
      `overbroad-auth-only-write:${entry.pattern.service}:${entry.pattern.resourceId}:${renderedPath}:${entry.source}`,
      usedIds,
    );
    diagnostics.push({
      id,
      code: 'overbroad-auth-only-write',
      service: entry.pattern.service,
      resourceId: entry.pattern.resourceId,
      severity: 'medium',
      certainty: 'heuristic',
      message:
        `Rule on '${renderedPath}' (${entry.source}) permits writes for any signed-in user ('auth != null'), whereas client writes at ${evidence.site.source} are scoped to auth.uid.`,
      resource: entry.pattern,
      codeSite: buildCodeSite(evidence.site.source, evidence.site.through),
      ruleSite: { source: entry.source },
      remediation: formatOverbroadRemediation(entry, evidence),
    });
  }

  return sortAssuranceDiagnostics(diagnostics);
}
