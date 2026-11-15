/**
 * Side-effect-free inspection of active Storage Security Rules on a Sandbox.
 *
 * Reads the process-wide `pyric.storage.service-caches` WeakMaps directly so
 * capture and inspection paths never open an IndexedDB backend or create a
 * `StorageService` on sandboxes that do not use Storage.
 */
import type { Sandbox } from 'pyric/sandbox';
import { rulesBucketName, type StorageRulesResolution } from '@pyric/rules/internal/storage';

const SERVICE_CACHES_KEY = Symbol.for('pyric.storage.service-caches');

interface ReadOnlyStorageRulesCaches {
  readonly openServices?: WeakMap<Sandbox, { readonly rulesResolution: StorageRulesResolution | null }>;
  readonly bucketRules?: WeakMap<Sandbox, Map<string, { readonly resolution: StorageRulesResolution }>>;
  readonly defaultStoreNames?: WeakMap<Sandbox, string>;
}

function readStorageRulesCaches(): ReadOnlyStorageRulesCaches | undefined {
  return (globalThis as { [SERVICE_CACHES_KEY]?: ReadOnlyStorageRulesCaches })[SERVICE_CACHES_KEY];
}

/** Side-effect-free read of the sandbox's unnamed default Storage rules resolution. */
export function getDefaultStorageRulesResolution(
  sandbox: Sandbox,
): StorageRulesResolution | null {
  return readStorageRulesCaches()?.openServices?.get(sandbox)?.rulesResolution ?? null;
}

/**
 * Side-effect-free read of the active Storage rules resolution for the default bucket:
 * checks per-bucket rules for `defaultBucketName` (or the pinned default bucket name)
 * first, then falls back to unnamed default Storage rules.
 */
export function getActiveStorageRulesResolution(
  sandbox: Sandbox,
  defaultBucketName?: string,
): StorageRulesResolution | null {
  const caches = readStorageRulesCaches();
  if (caches === undefined) return null;
  const hasExplicitBucket = typeof defaultBucketName === 'string' && defaultBucketName.length > 0;
  const resolvedBucket = hasExplicitBucket
    ? defaultBucketName
    : caches.defaultStoreNames?.get(sandbox);
  if (resolvedBucket !== undefined) {
    const normalized = rulesBucketName(resolvedBucket, resolvedBucket);
    const deployed = caches.bucketRules?.get(sandbox)?.get(normalized);
    if (deployed !== undefined) return deployed.resolution;
  }
  return caches.openServices?.get(sandbox)?.rulesResolution ?? null;
}
