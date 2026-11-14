/**
 * Diagnostic builders and per-arm evaluation helpers for `storageContractPass`.
 */
import { re2FullMatch } from '@pyric/rules/internal';
import {
  allocateDiagnosticId,
  buildCodeSite,
  type AssuranceDiagnostic,
  type DiagnosticCertainty,
  type DiagnosticSeverity,
} from '../../sandbox/internal/assurance-diagnostic.js';
import {
  renderResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type {
  AccessSite,
  PayloadField,
  StorageHttpHeaderKey,
} from '../code/types.js';
import type {
  RuleSurfaceEntry,
  StorageMetadataConstraintArm,
} from '../rules/rule-surface.js';
import { classifyOmittedClientHttpHeader } from '../rules/storage-constraint-ast.js';
import { STORAGE_HTTP_HEADER_KEYS } from '../rules/storage-constraint-summary.js';

function matchesCelRegex(value: string, rawPattern: string): boolean {
  try {
    return re2FullMatch(rawPattern, value);
  } catch {
    return true;
  }
}

function siteCertaintyAndSeverity(site: AccessSite): {
  certainty: DiagnosticCertainty;
  severity: DiagnosticSeverity;
} {
  if (site.resolution === 'resolved') {
    return { certainty: 'static-proof', severity: 'high' };
  }
  return { certainty: 'heuristic', severity: 'medium' };
}

function lookupCustomMetadataField(
  customMetadata: Readonly<Record<string, PayloadField>> | undefined,
  key: string,
): PayloadField | undefined {
  if (!customMetadata || !Object.hasOwn(customMetadata, key)) {
    return undefined;
  }
  return customMetadata[key];
}

interface MissingMetadataEvaluation {
  readonly entry: RuleSurfaceEntry;
  readonly missingKeys: readonly string[];
  readonly hasDefinitelyAbsentKey: boolean;
}

function evaluateMissingMetadata(
  site: AccessSite,
  entry: RuleSurfaceEntry,
  arm: StorageMetadataConstraintArm,
): MissingMetadataEvaluation {
  const required = arm.requiredCustomMetadataKeys ?? [];
  const customMap = site.storageUpload?.customMetadata;
  const missing: string[] = [];
  let hasDefinitelyAbsentKey = false;
  for (const key of required) {
    const field = lookupCustomMetadataField(customMap, key);
    if (field === undefined) {
      missing.push(key);
      hasDefinitelyAbsentKey = true;
    } else if (field.optional) {
      missing.push(key);
    }
  }
  missing.sort();
  return {
    entry,
    missingKeys: missing,
    hasDefinitelyAbsentKey,
  };
}

interface HttpMetadataEvaluation {
  readonly entry: RuleSurfaceEntry;
  readonly mismatchedHeaders: readonly StorageHttpHeaderKey[];
  readonly unverifiedHeaders: readonly StorageHttpHeaderKey[];
}

function evaluateHttpMetadata(
  site: AccessSite,
  entry: RuleSurfaceEntry,
  arm: StorageMetadataConstraintArm,
  shouldCheckHttpMeta: boolean,
): HttpMetadataEvaluation {
  if (!shouldCheckHttpMeta) {
    return { entry, mismatchedHeaders: [], unverifiedHeaders: [] };
  }
  const up = site.storageUpload;
  const isUpdate = site.op === 'updateMetadata';
  const mismatched: StorageHttpHeaderKey[] = [];
  const unverified: StorageHttpHeaderKey[] = [];
  const nullSet = new Set<StorageHttpHeaderKey>(arm.nullHttpHeaders ?? []);

  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const actual = up?.[key];
    const isFieldUnresolved = Boolean(
      up?.httpMetadataUnresolvedFields?.includes(key)
        || (actual === undefined && up?.customMetadataOpen === true),
    );
    const conjuncts = arm.httpHeaders?.[key];
    if (nullSet.has(key)) {
      if (actual !== undefined) {
        mismatched.push(key);
      } else if (key === 'contentEncoding') {
        mismatched.push(key);
      } else if (isFieldUnresolved) {
        unverified.push(key);
      } else {
        const omittedVerdict = classifyOmittedClientHttpHeader(
          key,
          site,
          isUpdate,
          true,
          conjuncts,
          matchesCelRegex,
        );
        if (omittedVerdict === 'mismatched') mismatched.push(key);
        else if (omittedVerdict === 'unverified') unverified.push(key);
      }
      continue;
    }
    if (!conjuncts || conjuncts.length === 0) continue;
    if (isFieldUnresolved) {
      unverified.push(key);
      continue;
    }
    if (actual !== undefined) {
      const ok = conjuncts.every((disjuncts) =>
        disjuncts.some((pat) => matchesCelRegex(actual, pat)),
      );
      if (!ok) mismatched.push(key);
      continue;
    }
    const omittedVerdict = classifyOmittedClientHttpHeader(
      key,
      site,
      isUpdate,
      false,
      conjuncts,
      matchesCelRegex,
    );
    if (omittedVerdict === 'mismatched') mismatched.push(key);
    else if (omittedVerdict === 'unverified') unverified.push(key);
  }

  return {
    entry,
    mismatchedHeaders: mismatched,
    unverifiedHeaders: unverified,
  };
}

export interface EntryContractEvaluation {
  readonly entry: RuleSurfaceEntry;
  readonly arm: StorageMetadataConstraintArm;
  readonly ctOk: boolean;
  readonly ctUnverified: boolean;
  readonly minSizeOk: boolean;
  readonly maxSizeOk: boolean;
  readonly sizeOk: boolean;
  readonly metaOk: boolean;
  readonly missingMeta: MissingMetadataEvaluation;
  readonly httpStaticOk: boolean;
  readonly httpUnverified: boolean;
  readonly httpEval: HttpMetadataEvaluation;
}

export function evaluateEntryArmContract(
  site: AccessSite,
  entry: RuleSurfaceEntry,
  arm: StorageMetadataConstraintArm,
  contentType: string | undefined,
  sizeBytes: number | undefined,
  shouldCheckCustomMeta: boolean,
  shouldCheckHttpMeta: boolean,
): EntryContractEvaluation {
  const ctConstrained = Boolean(
    arm.contentTypePattern !== undefined
      || (arm.contentTypeConjuncts !== undefined && arm.contentTypeConjuncts.length > 0),
  );
  let ctOk = true;
  if (contentType !== undefined) {
    if (arm.contentTypeConjuncts !== undefined && arm.contentTypeConjuncts.length > 0) {
      ctOk = arm.contentTypeConjuncts.every((disjuncts) =>
        disjuncts.some((pat) => matchesCelRegex(contentType, pat)),
      );
    } else if (arm.contentTypePattern !== undefined) {
      ctOk = matchesCelRegex(contentType, arm.contentTypePattern);
    }
  }
  const ctUnverified =
    contentType === undefined
    && site.storageUpload?.blobContentTypeUnresolved === true
    && ctConstrained;

  let minSizeOk = true;
  let maxSizeOk = true;
  if (sizeBytes !== undefined) {
    if (arm.minSizeBytes !== undefined) minSizeOk = sizeBytes >= arm.minSizeBytes;
    if (arm.maxSizeBytes !== undefined) maxSizeOk = sizeBytes <= arm.maxSizeBytes;
  }
  const sizeOk = minSizeOk && maxSizeOk;
  const missingMeta = evaluateMissingMetadata(site, entry, arm);
  let metaOk = true;
  if (shouldCheckCustomMeta) {
    metaOk = missingMeta.missingKeys.length === 0;
  }
  const httpEval = evaluateHttpMetadata(site, entry, arm, shouldCheckHttpMeta);
  const httpStaticOk = httpEval.mismatchedHeaders.length === 0;
  const httpUnverified = httpEval.unverifiedHeaders.length > 0;

  return {
    entry,
    arm,
    ctOk,
    ctUnverified,
    minSizeOk,
    maxSizeOk,
    sizeOk,
    metaOk,
    missingMeta,
    httpStaticOk,
    httpUnverified,
    httpEval,
  };
}

export function emitContentTypeMismatch(
  site: AccessSite,
  pattern: ResourcePattern,
  effectiveBucket: string,
  contentType: string,
  candidates: readonly EntryContractEvaluation[],
  usedIds: Set<string>,
  diagnostics: AssuranceDiagnostic[],
): void {
  const patterns = [
    ...new Set(
      candidates
        .map((c) => c.arm.contentTypePattern)
        .filter((p): p is string => p !== undefined),
    ),
  ];
  const expectedSummary = patterns.map((p) => `'${p}'`).join(' or ');
  const renderedPath = renderResourcePattern(pattern);
  const { certainty, severity } = siteCertaintyAndSeverity(site);
  const primaryRule = candidates[0]!.entry;
  const id = allocateDiagnosticId(
    `storage-content-type-mismatch:${effectiveBucket}:${renderedPath}:${site.source}`,
    usedIds,
  );
  diagnostics.push({
    id,
    code: 'storage-content-type-mismatch',
    service: 'storage',
    resourceId: effectiveBucket,
    severity,
    certainty,
    message:
      `Cloud Storage upload to '${renderedPath}' sets contentType '${contentType}', which violates ${primaryRule.source} (expected ${expectedSummary}).`,
    resource: pattern,
    codeSite: buildCodeSite(site.source, site.through),
    ruleSite: {
      source: primaryRule.source,
      expression: `request.resource.contentType.matches(${expectedSummary})`,
    },
    witness: [{ contentType, expectedPatterns: patterns }],
    remediation:
      `Upload '${renderedPath}' with a contentType matching ${expectedSummary} or widen request.resource.contentType.matches(...) in ${primaryRule.source}.`,
  });
}

export function emitContentTypeUnverified(
  site: AccessSite,
  pattern: ResourcePattern,
  effectiveBucket: string,
  candidates: readonly EntryContractEvaluation[],
  usedIds: Set<string>,
  diagnostics: AssuranceDiagnostic[],
): void {
  const patterns = [
    ...new Set(
      candidates
        .map((c) => c.arm.contentTypePattern)
        .filter((p): p is string => p !== undefined),
    ),
  ];
  const expectedSummary = patterns.map((p) => `'${p}'`).join(' or ');
  const renderedPath = renderResourcePattern(pattern);
  const primaryRule = candidates[0]!.entry;
  const id = allocateDiagnosticId(
    `storage-content-type-unverified:${effectiveBucket}:${renderedPath}:${site.source}`,
    usedIds,
  );
  diagnostics.push({
    id,
    code: 'storage-content-type-unverified',
    service: 'storage',
    resourceId: effectiveBucket,
    severity: 'medium',
    certainty: 'heuristic',
    message:
      `Cloud Storage upload to '${renderedPath}' omits explicit metadata.contentType on a runtime Blob/File while ${primaryRule.source} requires ${expectedSummary}.`,
    resource: pattern,
    codeSite: buildCodeSite(site.source, site.through),
    ruleSite: {
      source: primaryRule.source,
      expression: `request.resource.contentType.matches(${expectedSummary})`,
    },
    witness: [{ expectedPatterns: patterns }],
    remediation:
      `Pass explicit { contentType: ... } matching ${expectedSummary} when uploading to '${renderedPath}'.`,
  });
}

function emitMaxSizeExceeded(
  site: AccessSite,
  pattern: ResourcePattern,
  effectiveBucket: string,
  sizeBytes: number,
  candidates: readonly EntryContractEvaluation[],
  usedIds: Set<string>,
  diagnostics: AssuranceDiagnostic[],
): void {
  let maxCeiling = 0;
  let ceilingRule = candidates[0]!.entry;
  for (const candidate of candidates) {
    const bound = candidate.arm.maxSizeBytes;
    if (bound !== undefined && bound >= maxCeiling) {
      maxCeiling = bound;
      ceilingRule = candidate.entry;
    }
  }
  const renderedPath = renderResourcePattern(pattern);
  const { certainty, severity } = siteCertaintyAndSeverity(site);
  const id = allocateDiagnosticId(
    `storage-max-size-exceeded:${effectiveBucket}:${renderedPath}:${site.source}`,
    usedIds,
  );
  diagnostics.push({
    id,
    code: 'storage-max-size-exceeded',
    service: 'storage',
    resourceId: effectiveBucket,
    severity,
    certainty,
    message:
      `Cloud Storage upload to '${renderedPath}' writes ${sizeBytes} bytes, exceeding the ${maxCeiling}-byte ceiling in ${ceilingRule.source}.`,
    resource: pattern,
    codeSite: buildCodeSite(site.source, site.through),
    ruleSite: {
      source: ceilingRule.source,
      expression: `request.resource.size <= ${maxCeiling}`,
    },
    witness: [{ sizeBytes, maxSizeBytes: maxCeiling }],
    remediation:
      `Reduce the payload size below ${maxCeiling} bytes before uploading to '${renderedPath}' or raise the request.resource.size bound in ${ceilingRule.source}.`,
  });
}

function emitMinSizeNotMet(
  site: AccessSite,
  pattern: ResourcePattern,
  effectiveBucket: string,
  sizeBytes: number,
  candidates: readonly EntryContractEvaluation[],
  usedIds: Set<string>,
  diagnostics: AssuranceDiagnostic[],
): void {
  let minFloor = Number.POSITIVE_INFINITY;
  let floorRule = candidates[0]!.entry;
  for (const candidate of candidates) {
    const bound = candidate.arm.minSizeBytes;
    if (bound !== undefined && bound < minFloor) {
      minFloor = bound;
      floorRule = candidate.entry;
    }
  }
  if (!Number.isFinite(minFloor)) minFloor = 1;
  const renderedPath = renderResourcePattern(pattern);
  const { certainty, severity } = siteCertaintyAndSeverity(site);
  const id = allocateDiagnosticId(
    `storage-min-size-not-met:${effectiveBucket}:${renderedPath}:${site.source}`,
    usedIds,
  );
  diagnostics.push({
    id,
    code: 'storage-min-size-not-met',
    service: 'storage',
    resourceId: effectiveBucket,
    severity,
    certainty,
    message:
      `Cloud Storage upload to '${renderedPath}' writes ${sizeBytes} bytes, below the ${minFloor}-byte minimum in ${floorRule.source}.`,
    resource: pattern,
    codeSite: buildCodeSite(site.source, site.through),
    ruleSite: {
      source: floorRule.source,
      expression: `request.resource.size >= ${minFloor}`,
    },
    witness: [{ sizeBytes, minSizeBytes: minFloor }],
    remediation:
      `Ensure the payload size is at least ${minFloor} bytes before uploading to '${renderedPath}' or lower the request.resource.size bound in ${floorRule.source}.`,
  });
}

export function emitSizeViolation(
  site: AccessSite,
  pattern: ResourcePattern,
  effectiveBucket: string,
  sizeBytes: number,
  candidates: readonly EntryContractEvaluation[],
  usedIds: Set<string>,
  diagnostics: AssuranceDiagnostic[],
): void {
  if (!candidates.some((c) => c.minSizeOk)) {
    emitMinSizeNotMet(site, pattern, effectiveBucket, sizeBytes, candidates, usedIds, diagnostics);
    return;
  }
  if (!candidates.some((c) => c.maxSizeOk)) {
    emitMaxSizeExceeded(site, pattern, effectiveBucket, sizeBytes, candidates, usedIds, diagnostics);
    return;
  }
  const minFailed = candidates.filter((c) => !c.minSizeOk);
  if (minFailed.length > 0) {
    emitMinSizeNotMet(site, pattern, effectiveBucket, sizeBytes, minFailed, usedIds, diagnostics);
  } else {
    emitMaxSizeExceeded(site, pattern, effectiveBucket, sizeBytes, candidates, usedIds, diagnostics);
  }
}

export function emitMissingCustomMetadata(
  site: AccessSite,
  pattern: ResourcePattern,
  effectiveBucket: string,
  candidates: readonly EntryContractEvaluation[],
  usedIds: Set<string>,
  diagnostics: AssuranceDiagnostic[],
): void {
  let chosen = candidates[0]!.missingMeta;
  for (const candidate of candidates) {
    if (candidate.missingMeta.missingKeys.length < chosen.missingKeys.length) {
      chosen = candidate.missingMeta;
    }
  }
  const isStaticProof =
    site.resolution === 'resolved'
    && !site.storageUpload?.customMetadataOpen
    && candidates.every((c) => c.missingMeta.hasDefinitelyAbsentKey);
  let certainty: DiagnosticCertainty = 'heuristic';
  let severity: DiagnosticSeverity = 'medium';
  if (isStaticProof) {
    certainty = 'static-proof';
    severity = 'high';
  }
  const renderedPath = renderResourcePattern(pattern);
  const keySummary = chosen.missingKeys.map((k) => `'${k}'`).join(', ');
  const id = allocateDiagnosticId(
    `storage-missing-custom-metadata:${effectiveBucket}:${renderedPath}:${site.source}`,
    usedIds,
  );
  diagnostics.push({
    id,
    code: 'storage-missing-custom-metadata',
    service: 'storage',
    resourceId: effectiveBucket,
    severity,
    certainty,
    message:
      `Cloud Storage upload to '${renderedPath}' omits required customMetadata keys (${keySummary}) enforced by ${chosen.entry.source}.`,
    resource: pattern,
    codeSite: buildCodeSite(site.source, site.through),
    ruleSite: { source: chosen.entry.source },
    witness: [{ missingKeys: chosen.missingKeys }],
    remediation:
      `Pass { customMetadata: { ${chosen.missingKeys.map((k) => `${k}: '...'`).join(', ')} } } in the upload metadata options for '${renderedPath}'.`,
  });
}

export function emitHttpMetadataMismatch(
  site: AccessSite,
  pattern: ResourcePattern,
  effectiveBucket: string,
  candidates: readonly EntryContractEvaluation[],
  usedIds: Set<string>,
  diagnostics: AssuranceDiagnostic[],
): void {
  let chosen = candidates[0]!.httpEval;
  for (const candidate of candidates) {
    if (candidate.httpEval.mismatchedHeaders.length < chosen.mismatchedHeaders.length) {
      chosen = candidate.httpEval;
    }
  }
  const renderedPath = renderResourcePattern(pattern);
  const { certainty, severity } = siteCertaintyAndSeverity(site);
  const headerSummary = chosen.mismatchedHeaders.map((h) => `'${h}'`).join(', ');
  const id = allocateDiagnosticId(
    `storage-http-metadata-mismatch:${effectiveBucket}:${renderedPath}:${site.source}`,
    usedIds,
  );
  diagnostics.push({
    id,
    code: 'storage-http-metadata-mismatch',
    service: 'storage',
    resourceId: effectiveBucket,
    severity,
    certainty,
    message:
      `Cloud Storage upload to '${renderedPath}' violates required HTTP metadata fields (${headerSummary}) in ${chosen.entry.source}.`,
    resource: pattern,
    codeSite: buildCodeSite(site.source, site.through),
    ruleSite: { source: chosen.entry.source },
    witness: [{ mismatchedHeaders: chosen.mismatchedHeaders }],
    remediation:
      `Pass compliant HTTP metadata fields (${headerSummary}) in the upload options for '${renderedPath}' or update ${chosen.entry.source}.`,
  });
}

export function emitHttpMetadataUnverified(
  site: AccessSite,
  pattern: ResourcePattern,
  effectiveBucket: string,
  candidates: readonly EntryContractEvaluation[],
  usedIds: Set<string>,
  diagnostics: AssuranceDiagnostic[],
): void {
  let chosen = candidates[0]!.httpEval;
  for (const candidate of candidates) {
    if (candidate.httpEval.unverifiedHeaders.length < chosen.unverifiedHeaders.length) {
      chosen = candidate.httpEval;
    }
  }
  const renderedPath = renderResourcePattern(pattern);
  const headerSummary = chosen.unverifiedHeaders.map((h) => `'${h}'`).join(', ');
  const id = allocateDiagnosticId(
    `storage-http-metadata-unverified:${effectiveBucket}:${renderedPath}:${site.source}`,
    usedIds,
  );
  diagnostics.push({
    id,
    code: 'storage-http-metadata-unverified',
    service: 'storage',
    resourceId: effectiveBucket,
    severity: 'medium',
    certainty: 'heuristic',
    message:
      `Cloud Storage upload to '${renderedPath}' passes runtime-resolved HTTP metadata (${headerSummary}) constrained by ${chosen.entry.source}.`,
    resource: pattern,
    codeSite: buildCodeSite(site.source, site.through),
    ruleSite: { source: chosen.entry.source },
    witness: [{ unverifiedHeaders: chosen.unverifiedHeaders }],
    remediation:
      `Verify that runtime values for (${headerSummary}) satisfy ${chosen.entry.source} when uploading to '${renderedPath}'.`,
  });
}
