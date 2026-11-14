/**
 * Pre-runtime Cloud Storage contract pass (`storageContractPass`):
 * checks client Storage bucket targets and static upload metadata
 * (`contentType`, `sizeBytes`, HTTP headers, `customMetadata`) against
 * configured buckets and projected `RuleSurface` Storage constraints.
 */
import {
  allocateDiagnosticId,
  buildCodeSite,
  sortAssuranceDiagnostics,
  type AssuranceDiagnostic,
} from '../../sandbox/internal/assurance-diagnostic.js';
import {
  DEFAULT_RESOURCE_ID,
  normalizeExplicitResourceId,
} from '../../sandbox/internal/resource-pattern-header.js';
import type { ResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import type { SdkUsageIndex } from '../code/usage-index.js';
import { siteResourcePattern } from '../code/usage-records.js';
import {
  projectRuleSurface,
  type RuleSurface,
  type RuleSurfaceEntry,
  type StorageMetadataConstraintArm,
  type StorageSurfaceInput,
} from '../rules/rule-surface.js';
import { splitSourceLocation } from './source-location.js';
import {
  emitContentTypeMismatch,
  emitContentTypeUnverified,
  emitHttpMetadataMismatch,
  emitHttpMetadataUnverified,
  emitMissingCustomMetadata,
  emitSizeViolation,
  evaluateEntryArmContract,
} from './storage-contract-diagnostics.js';

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

function matchingUploadEntries(
  surface: RuleSurface,
  pattern: ResourcePattern,
  op: string,
  defaultBucket: string | undefined,
  allowedBuckets: Set<string> | null,
): RuleSurfaceEntry[] {
  const seen = new Set<RuleSurfaceEntry>();
  const matches: RuleSurfaceEntry[] = [];
  const pushAll = (entries: readonly RuleSurfaceEntry[]): void => {
    for (const entry of entries) {
      if (!seen.has(entry)) {
        seen.add(entry);
        matches.push(entry);
      }
    }
  };

  pushAll(surface.matching(pattern, op));
  if (pattern.resourceId === DEFAULT_RESOURCE_ID && defaultBucket !== undefined) {
    pushAll(surface.matching({ ...pattern, resourceId: defaultBucket }, op));
  }
  if (pattern.resourceId !== DEFAULT_RESOURCE_ID) {
    const isAllowedBucket = allowedBuckets === null || allowedBuckets.has(pattern.resourceId);
    if (isAllowedBucket) {
      pushAll(
        surface
          .matching({ ...pattern, resourceId: DEFAULT_RESOURCE_ID }, op)
          .filter(
            (e) =>
              e.wildcardBucket === true
              && wildcardBucketAppliesToBucket(surface, e, pattern.resourceId),
          ),
      );
    }
  }
  return matches.filter((entry) => !entry.alwaysDeny);
}

function armsForEntry(entry: RuleSurfaceEntry): readonly StorageMetadataConstraintArm[] {
  if (entry.storageMetadataArms !== undefined && entry.storageMetadataArms.length > 0) {
    return entry.storageMetadataArms;
  }
  if (entry.storageMetadata !== undefined) {
    return [entry.storageMetadata];
  }
  return [{}];
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
    const pattern = siteResourcePattern(site);
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

      const rawContentType = site.storageUpload?.contentType;
      let contentType = rawContentType;
      if (rawContentType === '' && site.op !== 'updateMetadata') {
        contentType = 'application/octet-stream';
      }
      const sizeBytes = site.storageUpload?.sizeBytes;
      const shouldCheckCustomMeta =
        !site.storageUpload?.customMetadataUnresolved
        && (site.op !== 'updateMetadata' || site.storageUpload?.customMetadata !== undefined);
      const hasExplicitHttpFacts = Boolean(
        site.storageUpload?.cacheControl !== undefined
          || site.storageUpload?.contentDisposition !== undefined
          || site.storageUpload?.contentEncoding !== undefined
          || site.storageUpload?.contentLanguage !== undefined
          || (site.storageUpload?.httpMetadataUnresolvedFields !== undefined
            && site.storageUpload.httpMetadataUnresolvedFields.length > 0),
      );
      const shouldCheckHttpMeta =
        !site.storageUpload?.customMetadataUnresolved || hasExplicitHttpFacts;

      const evals = activeEntries.flatMap((entry) =>
        armsForEntry(entry).map((arm) =>
          evaluateEntryArmContract(
            site,
            entry,
            arm,
            contentType,
            sizeBytes,
            shouldCheckCustomMeta,
            shouldCheckHttpMeta,
          ),
        ),
      );
      if (
        evals.some(
          (ev) =>
            ev.ctOk
            && !ev.ctUnverified
            && ev.sizeOk
            && ev.metaOk
            && ev.httpStaticOk
            && !ev.httpUnverified,
        )
      ) {
        continue;
      }

      const staticallyCompatible = evals.filter(
        (ev) => ev.ctOk && ev.sizeOk && ev.metaOk && ev.httpStaticOk,
      );
      if (staticallyCompatible.length > 0) {
        if (staticallyCompatible.every((ev) => ev.ctUnverified)) {
          emitContentTypeUnverified(
            site,
            pattern,
            effectiveBucket,
            staticallyCompatible,
            usedIds,
            diagnostics,
          );
        }
        if (staticallyCompatible.every((ev) => ev.httpUnverified)) {
          emitHttpMetadataUnverified(
            site,
            pattern,
            effectiveBucket,
            staticallyCompatible,
            usedIds,
            diagnostics,
          );
        }
        continue;
      }

      const ctCompatible = evals.filter((ev) => ev.ctOk);
      if (ctCompatible.length === 0) {
        if (contentType !== undefined) {
          emitContentTypeMismatch(
            site,
            pattern,
            effectiveBucket,
            contentType,
            evals,
            usedIds,
            diagnostics,
          );
        }
        if (sizeBytes !== undefined && !evals.some((ev) => ev.sizeOk)) {
          emitSizeViolation(
            site,
            pattern,
            effectiveBucket,
            sizeBytes,
            evals,
            usedIds,
            diagnostics,
          );
        }
        if (shouldCheckCustomMeta && !evals.some((ev) => ev.metaOk)) {
          emitMissingCustomMetadata(site, pattern, effectiveBucket, evals, usedIds, diagnostics);
        }
        if (shouldCheckHttpMeta && !evals.some((ev) => ev.httpStaticOk)) {
          emitHttpMetadataMismatch(site, pattern, effectiveBucket, evals, usedIds, diagnostics);
        }
      } else {
        const sizeViolated = sizeBytes !== undefined && !ctCompatible.some((ev) => ev.sizeOk);
        if (sizeViolated) {
          emitSizeViolation(
            site,
            pattern,
            effectiveBucket,
            sizeBytes,
            ctCompatible,
            usedIds,
            diagnostics,
          );
        }
        if (shouldCheckCustomMeta && !ctCompatible.some((ev) => ev.metaOk)) {
          emitMissingCustomMetadata(
            site,
            pattern,
            effectiveBucket,
            ctCompatible,
            usedIds,
            diagnostics,
          );
        } else if (!sizeViolated && shouldCheckCustomMeta) {
          const ctSizeCompatible = ctCompatible.filter((ev) => ev.sizeOk);
          if (ctSizeCompatible.length > 0 && !ctSizeCompatible.some((ev) => ev.metaOk)) {
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
        if (shouldCheckHttpMeta) {
          const ctSizeMetaCompatible = ctCompatible.filter((ev) => ev.sizeOk && ev.metaOk);
          let httpPool = ctCompatible;
          if (ctSizeMetaCompatible.length > 0) httpPool = ctSizeMetaCompatible;
          if (!httpPool.some((ev) => ev.httpStaticOk)) {
            emitHttpMetadataMismatch(
              site,
              pattern,
              effectiveBucket,
              httpPool,
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
