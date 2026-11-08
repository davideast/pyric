/**
 * Pre-runtime Cloud Storage contract pass (`storageContractPass`):
 * checks client Storage bucket targets and static upload metadata
 * (`contentType`, `sizeBytes`, `customMetadata`) against configured buckets
 * and projected `RuleSurface` Storage constraints.
 */
import {
  allocateDiagnosticId,
  buildCodeSite,
  sortAssuranceDiagnostics,
  type AssuranceDiagnostic,
  type DiagnosticCertainty,
  type DiagnosticSeverity,
} from '../../sandbox/internal/assurance-diagnostic.js';
import {
  DEFAULT_RESOURCE_ID,
  normalizeExplicitResourceId,
} from '../../sandbox/internal/resource-pattern-header.js';
import {
  parseResourcePattern,
  renderResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type { AccessSite, PayloadField } from '../code/types.js';
import type { SdkUsageIndex } from '../code/usage-index.js';
import {
  projectRuleSurface,
  type RuleSurface,
  type RuleSurfaceEntry,
  type StorageSurfaceInput,
} from '../rules/rule-surface.js';

const CLIENT_UPLOAD_OPS = new Set([
  'uploadBytes',
  'uploadBytesResumable',
  'uploadString',
  'updateMetadata',
]);

export interface StorageContractPassConfig {
  readonly ruleSurface?: RuleSurface;
  readonly storageRules?: StorageSurfaceInput;
  readonly configuredBuckets?: readonly string[];
  readonly defaultBucket?: string;
}

export type StorageContractPassOptions = StorageContractPassConfig | StorageSurfaceInput;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeConfig(options: StorageContractPassOptions | undefined): StorageContractPassConfig {
  if (options === undefined) return {};
  if (typeof options === 'string' || Array.isArray(options)) {
    return { storageRules: options };
  }
  if (
    isPlainObject(options)
    && (Object.hasOwn(options, 'ruleSurface')
      || Object.hasOwn(options, 'storageRules')
      || Object.hasOwn(options, 'configuredBuckets')
      || Object.hasOwn(options, 'defaultBucket'))
  ) {
    return options as StorageContractPassConfig;
  }
  return { storageRules: options as StorageSurfaceInput };
}

function resolveSurface(config: StorageContractPassConfig): RuleSurface | undefined {
  if (config.ruleSurface !== undefined && config.storageRules === undefined) {
    return config.ruleSurface;
  }
  if (config.ruleSurface === undefined && config.storageRules !== undefined) {
    return projectRuleSurface({ storage: config.storageRules });
  }
  if (config.ruleSurface !== undefined && config.storageRules !== undefined) {
    const extra = projectRuleSurface({ storage: config.storageRules });
    return {
      entries: [...config.ruleSurface.entries, ...extra.entries],
      matching(pattern: ResourcePattern, op?: string) {
        return [
          ...config.ruleSurface!.matching(pattern, op),
          ...extra.matching(pattern, op),
        ];
      },
    };
  }
  return undefined;
}

function resolveConfiguredBucketSet(
  config: StorageContractPassConfig,
  surface: RuleSurface | undefined,
): Set<string> | null {
  if (config.configuredBuckets !== undefined) {
    const explicit = new Set<string>();
    for (const raw of config.configuredBuckets) {
      const norm = normalizeExplicitResourceId('storage', raw);
      if (norm !== undefined && norm !== DEFAULT_RESOURCE_ID) {
        explicit.add(norm);
      }
    }
    if (explicit.size > 0) return explicit;
    return null;
  }
  if (!surface) return null;
  const storageEntries = surface.entries.filter((e) => e.pattern.service === 'storage');
  if (storageEntries.length === 0) return null;
  const hasWildcardDefault = storageEntries.some((e) => e.wildcardBucket === true);
  if (hasWildcardDefault) return null;
  const ruleBuckets = new Set<string>();
  for (const e of storageEntries) {
    if (e.pattern.resourceId !== DEFAULT_RESOURCE_ID) {
      ruleBuckets.add(e.pattern.resourceId);
    }
  }
  if (ruleBuckets.size === 0) return null;
  return ruleBuckets;
}

function matchesCelRegex(value: string, rawPattern: string): boolean {
  try {
    const anchored = new RegExp(`^(?:${rawPattern})$`, 'u');
    return anchored.test(value);
  } catch {
    try {
      const fallback = new RegExp(`^(?:${rawPattern})$`);
      return fallback.test(value);
    } catch {
      return true;
    }
  }
}

function matchingUploadEntries(
  surface: RuleSurface,
  pattern: ResourcePattern,
  op: string,
  defaultBucket: string | undefined,
  allowedBuckets: Set<string> | null,
): RuleSurfaceEntry[] {
  let matches = [...surface.matching(pattern, op)];
  if (matches.length === 0 && pattern.resourceId === DEFAULT_RESOURCE_ID && defaultBucket !== undefined) {
    matches = [...surface.matching({ ...pattern, resourceId: defaultBucket }, op)];
  }
  if (matches.length === 0 && pattern.resourceId !== DEFAULT_RESOURCE_ID) {
    const hasExplicitBucketRules = surface.entries.some(
      (e) =>
        e.pattern.service === 'storage'
        && !e.wildcardBucket
        && e.pattern.resourceId === pattern.resourceId,
    );
    const isAllowedBucket = allowedBuckets === null || allowedBuckets.has(pattern.resourceId);
    if (!hasExplicitBucketRules && isAllowedBucket) {
      matches = surface
        .matching({ ...pattern, resourceId: DEFAULT_RESOURCE_ID }, op)
        .filter((e) => e.wildcardBucket === true);
    }
  }
  return matches.filter((entry) => !entry.alwaysDeny);
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
): MissingMetadataEvaluation {
  const required = entry.storageMetadata?.requiredCustomMetadataKeys ?? [];
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

interface EntryContractEvaluation {
  readonly entry: RuleSurfaceEntry;
  readonly ctOk: boolean;
  readonly sizeOk: boolean;
  readonly metaOk: boolean;
  readonly missingMeta: MissingMetadataEvaluation;
}

function evaluateEntryContract(
  site: AccessSite,
  entry: RuleSurfaceEntry,
  contentType: string | undefined,
  sizeBytes: number | undefined,
  shouldCheckCustomMeta: boolean,
): EntryContractEvaluation {
  let ctOk = true;
  if (contentType !== undefined) {
    const expected = entry.storageMetadata?.contentTypePattern;
    if (expected !== undefined) {
      ctOk = matchesCelRegex(contentType, expected);
    }
  }
  let sizeOk = true;
  if (sizeBytes !== undefined) {
    const maxBytes = entry.storageMetadata?.maxSizeBytes;
    if (maxBytes !== undefined) {
      sizeOk = sizeBytes <= maxBytes;
    }
  }
  const missingMeta = evaluateMissingMetadata(site, entry);
  let metaOk = true;
  if (shouldCheckCustomMeta) {
    metaOk = missingMeta.missingKeys.length === 0;
  }
  return { entry, ctOk, sizeOk, metaOk, missingMeta };
}

function emitContentTypeMismatch(
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
        .map((c) => c.entry.storageMetadata?.contentTypePattern)
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
    const bound = candidate.entry.storageMetadata?.maxSizeBytes;
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

function emitMissingCustomMetadata(
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
    ruleSite: {
      source: chosen.entry.source,
    },
    witness: [{ missingKeys: chosen.missingKeys }],
    remediation:
      `Pass { customMetadata: { ${chosen.missingKeys.map((k) => `${k}: '...'`).join(', ')} } } in the upload metadata options for '${renderedPath}'.`,
  });
}

export function storageContractPass(
  usage: SdkUsageIndex,
  options?: StorageContractPassOptions,
): AssuranceDiagnostic[] {
  const config = normalizeConfig(options);
  const surface = resolveSurface(config);
  const allowedBuckets = resolveConfiguredBucketSet(config, surface);
  const defaultBucket = normalizeExplicitResourceId('storage', config.defaultBucket);
  const diagnostics: AssuranceDiagnostic[] = [];
  const usedIds = new Set<string>();
  const reportedBucketSites = new Set<string>();

  const emitUnconfiguredBucket = (
    bucketId: string,
    resource: ResourcePattern,
    source: string,
    through: string | undefined,
  ): void => {
    if (!allowedBuckets) return;
    const dedupeKey = `${bucketId}|${source}|${through ?? ''}`;
    if (reportedBucketSites.has(dedupeKey)) return;
    reportedBucketSites.add(dedupeKey);

    const configuredList = [...allowedBuckets].sort().map((b) => `'gs://${b}'`).join(', ');
    const id = allocateDiagnosticId(
      `storage-unconfigured-bucket:${bucketId}:${source}`,
      usedIds,
    );
    diagnostics.push({
      id,
      code: 'storage-unconfigured-bucket',
      service: 'storage',
      resourceId: bucketId,
      severity: 'high',
      certainty: 'static-proof',
      message:
        `Cloud Storage target bucket '${bucketId}' is not present in configured storage bucket targets (${configuredList}).`,
      resource,
      codeSite: buildCodeSite(source, through),
      remediation:
        `Target one of the configured buckets (${configuredList}) in getStorage(app, ...) or register '${bucketId}' in firebase.json storage targets.`,
    });
  };

  for (const site of usage.operations) {
    if (site.service !== 'storage') continue;
    if (site.admin) continue;
    if (site.op === 'ref' && site.resolution === 'unresolved') continue;
    const pattern = parseResourcePattern('storage', site.path, site.resourceId);
    let effectiveBucket = pattern.resourceId;
    if (effectiveBucket === DEFAULT_RESOURCE_ID && defaultBucket !== undefined) {
      effectiveBucket = defaultBucket;
    }
    if (
      allowedBuckets !== null
      && effectiveBucket !== DEFAULT_RESOURCE_ID
      && !allowedBuckets.has(effectiveBucket)
    ) {
      emitUnconfiguredBucket(effectiveBucket, pattern, site.source, site.through);
      continue;
    }

    if (
      surface !== undefined
      && CLIENT_UPLOAD_OPS.has(site.op)
      && site.resolution !== 'unresolved'
    ) {
      const activeEntries = matchingUploadEntries(
        surface,
        pattern,
        site.op,
        defaultBucket,
        allowedBuckets,
      );
      if (activeEntries.length === 0) continue;

      const contentType = site.storageUpload?.contentType;
      const sizeBytes = site.storageUpload?.sizeBytes;
      const shouldCheckCustomMeta =
        !site.storageUpload?.customMetadataUnresolved
        && (site.op !== 'updateMetadata' || site.storageUpload?.customMetadata !== undefined);

      const evals = activeEntries.map((entry) =>
        evaluateEntryContract(site, entry, contentType, sizeBytes, shouldCheckCustomMeta),
      );
      if (evals.some((ev) => ev.ctOk && ev.sizeOk && ev.metaOk)) {
        continue;
      }

      let emittedAny = false;
      if (contentType !== undefined && !evals.some((ev) => ev.ctOk)) {
        emitContentTypeMismatch(
          site,
          pattern,
          effectiveBucket,
          contentType,
          evals,
          usedIds,
          diagnostics,
        );
        emittedAny = true;
      }
      if (sizeBytes !== undefined && !evals.some((ev) => ev.sizeOk)) {
        emitMaxSizeExceeded(
          site,
          pattern,
          effectiveBucket,
          sizeBytes,
          evals,
          usedIds,
          diagnostics,
        );
        emittedAny = true;
      }
      if (shouldCheckCustomMeta && !evals.some((ev) => ev.metaOk)) {
        emitMissingCustomMetadata(site, pattern, effectiveBucket, evals, usedIds, diagnostics);
        emittedAny = true;
      }
      if (!emittedAny) {
        const ctCompatible = evals.filter((ev) => ev.ctOk);
        if (sizeBytes !== undefined && !ctCompatible.some((ev) => ev.sizeOk)) {
          emitMaxSizeExceeded(
            site,
            pattern,
            effectiveBucket,
            sizeBytes,
            ctCompatible,
            usedIds,
            diagnostics,
          );
        } else {
          const ctSizeCompatible = ctCompatible.filter((ev) => ev.sizeOk);
          if (shouldCheckCustomMeta && !ctSizeCompatible.some((ev) => ev.metaOk)) {
            emitMissingCustomMetadata(
              site,
              pattern,
              effectiveBucket,
              ctSizeCompatible,
              usedIds,
              diagnostics,
            );
          }
        }
      }
    }
  }

  for (const ref of usage.refs) {
    if (ref.pattern.service !== 'storage') continue;
    if (ref.admin) continue;
    if (ref.consumedBy.length > 0) continue;
    let effectiveBucket = ref.pattern.resourceId;
    if (effectiveBucket === DEFAULT_RESOURCE_ID && defaultBucket !== undefined) {
      effectiveBucket = defaultBucket;
    }
    if (
      allowedBuckets !== null
      && effectiveBucket !== DEFAULT_RESOURCE_ID
      && !allowedBuckets.has(effectiveBucket)
    ) {
      emitUnconfiguredBucket(effectiveBucket, ref.pattern, ref.source, ref.through);
    }
  }

  return sortAssuranceDiagnostics(diagnostics);
}
