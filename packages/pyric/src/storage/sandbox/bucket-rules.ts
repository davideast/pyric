/**
 * Per-bucket Storage rules state, default-store bucket pinning, and synchronous
 * rules inspection helpers.
 */
import type { Sandbox } from 'pyric/sandbox';
import {
  compileStorageRules,
  rulesBucketName,
  type StorageRules,
  type StorageRulesResolution,
} from '@pyric/rules/internal/storage';
import type { StorageService } from './running-service.js';
import {
  addressesDefaultBucket,
  BUCKET_RULES,
  CLAIMED_DEFAULT_NAMES,
  DEFAULT_STORAGE_BUCKET,
  DEFAULT_STORE_NAMES,
  serviceCaches,
  targetOf,
  UNDEPLOYED_POLICIES,
  type BucketRules,
  type FirebaseStorage,
  type SandboxTarget,
  type StorageDefaultPolicy,
} from './service-caches.js';

/** The rules one request is checked against, or why there are none. */
export type StorageRulesInForce =
  | { readonly kind: 'rules'; readonly rules: StorageRules }
  | { readonly kind: 'none' }
  | { readonly kind: 'locked'; readonly bucket: string }
  | { readonly kind: 'open'; readonly bucket: string }
  | { readonly kind: 'second-default'; readonly bucket: string; readonly defaultBucket: string };

/** Start deploying rules per bucket, keeping any policy already set. */
function deployPerBucket(sandbox: Sandbox): Map<string, BucketRules> {
  let byBucket = BUCKET_RULES.get(sandbox);
  if (byBucket === undefined) {
    byBucket = new Map();
    BUCKET_RULES.set(sandbox, byBucket);
  }
  return byBucket;
}

/**
 * Deploy rules per bucket from here on: each bucket enforces the rules deployed
 * to it by name, the default bucket also enforces unnamed default rules, and
 * any undeployed bucket follows `policy` (`deny` by default, `allow` in
 * permissive mode).
 */
export function lockUndeployedStorageBuckets(
  sandbox: Sandbox,
  policy: StorageDefaultPolicy = 'deny',
): void {
  deployPerBucket(sandbox);
  UNDEPLOYED_POLICIES.set(sandbox, policy);
}

/**
 * Deploy `source` to one bucket by name, and deploy per bucket from here on.
 * A null source removes the bucket's rules, returning it to the undeployed policy.
 */
export function deployStorageBucketRules(
  sandbox: Sandbox,
  bucket: string,
  source: string | null,
): void {
  let compiled: { rules: StorageRules; resolution: StorageRulesResolution } | null = null;
  if (source !== null) {
    compiled = compileStorageRules(source);
  }
  const byBucket = deployPerBucket(sandbox);
  const name = rulesBucketName(bucket, bucket);
  if (source === null || compiled === null) {
    byBucket.delete(name);
    return;
  }
  byBucket.set(name, {
    source,
    rules: compiled.rules,
    resolution: compiled.resolution,
  });
}

/**
 * Record an app's configured `storageBucket` in registration order so the first
 * app with usable rules owns the default store, even if a second app runs an
 * operation first (#1538).
 */
export function claimDefaultStorageBucket(
  sandbox: Sandbox,
  bucketName: string | undefined,
): void {
  if (bucketName === undefined || bucketName === '') return;
  const normalized = rulesBucketName(bucketName, bucketName);
  if (normalized === '' || normalized === DEFAULT_STORAGE_BUCKET) return;
  let claimed = CLAIMED_DEFAULT_NAMES.get(sandbox);
  if (claimed === undefined) {
    claimed = new Set();
    CLAIMED_DEFAULT_NAMES.set(sandbox, claimed);
  }
  claimed.add(normalized);
}

function hasUsableDefaultBucketRules(
  sandbox: Sandbox,
  service: StorageService,
  name: string,
): boolean {
  const byBucket = BUCKET_RULES.get(sandbox);
  if (byBucket === undefined) {
    return service.rules !== null;
  }
  if (byBucket.has(name)) return true;
  if (service.rules !== null) return true;
  return UNDEPLOYED_POLICIES.get(sandbox) === 'allow';
}

function pinnedDefaultName(
  service: StorageService,
  target: SandboxTarget,
  name: string,
): string | null {
  const unnamedDefault = !addressesDefaultBucket(target) || target.bucketName === undefined;
  if (unnamedDefault) return null;
  const pinned = DEFAULT_STORE_NAMES.get(target.sandbox);
  if (pinned !== undefined) return pinned;
  const claimed = CLAIMED_DEFAULT_NAMES.get(target.sandbox);
  if (claimed !== undefined) {
    for (const candidate of claimed) {
      if (hasUsableDefaultBucketRules(target.sandbox, service, candidate)) {
        DEFAULT_STORE_NAMES.set(target.sandbox, candidate);
        return candidate;
      }
    }
  }
  if (hasUsableDefaultBucketRules(target.sandbox, service, name)) {
    DEFAULT_STORE_NAMES.set(target.sandbox, name);
    return name;
  }
  return null;
}

/**
 * The rules a request through `target` is checked against: the rules deployed
 * to its bucket by name, else for the default bucket the rules installed
 * without a bucket. Once a host deploys per bucket, any other bucket is locked,
 * or open in permissive mode.
 */
export function storageRulesInForce(
  service: StorageService,
  target: SandboxTarget,
): StorageRulesInForce {
  const byBucket = BUCKET_RULES.get(target.sandbox);
  if (byBucket === undefined) {
    if (service.rules) {
      return { kind: 'rules', rules: service.rules };
    }
    return { kind: 'none' };
  }
  const name = rulesBucketName(target.bucket, target.bucketName);
  const pinned = pinnedDefaultName(service, target, name);
  if (pinned !== null && pinned !== name) {
    return { kind: 'second-default', bucket: name, defaultBucket: pinned };
  }
  const deployed = byBucket.get(name);
  if (deployed !== undefined) {
    return { kind: 'rules', rules: deployed.rules };
  }
  let defaultRules: StorageRules | null = null;
  if (addressesDefaultBucket(target)) {
    defaultRules = service.rules;
  }
  if (defaultRules) {
    return { kind: 'rules', rules: defaultRules };
  }
  const isPermissive = UNDEPLOYED_POLICIES.get(target.sandbox) === 'allow';
  if (isPermissive) {
    return { kind: 'open', bucket: name };
  }
  return { kind: 'locked', bucket: name };
}

/** The bucket names rules are deployed to by name, in deploy order. */
export function storageBucketsWithRules(sandbox: Sandbox): string[] {
  const byBucket = BUCKET_RULES.get(sandbox);
  if (byBucket === undefined) return [];
  return [...byBucket.keys()];
}

/**
 * The compiled Storage rules the app deployed to `bucket`, read synchronously:
 * the rules deployed to that bucket by name, else the default rules for the
 * default bucket.
 */
export function compiledStorageRulesForBucket(
  sandbox: Sandbox,
  bucket?: string,
  defaultBuckets: readonly string[] = [],
): StorageRules | null {
  const open = serviceCaches.openServices.get(sandbox);
  const defaultRules = open?.compiledRules ?? null;
  if (bucket === undefined) return defaultRules;
  const normalized = rulesBucketName(bucket, bucket);
  const byBucket = BUCKET_RULES.get(sandbox);
  const deployed = byBucket?.get(normalized);
  if (deployed !== undefined) return deployed.rules;
  let pinnedDefault = DEFAULT_STORE_NAMES.get(sandbox);
  if (pinnedDefault === undefined) {
    const claimed = CLAIMED_DEFAULT_NAMES.get(sandbox);
    if (claimed !== undefined) {
      for (const candidate of claimed) {
        pinnedDefault = candidate;
        break;
      }
    }
  }
  if (pinnedDefault === normalized) return defaultRules;
  if (defaultBuckets.some((name) => rulesBucketName(name, name) === normalized)) {
    return defaultRules;
  }
  const deployedCount = byBucket?.size ?? 0;
  const knowsNoBucketName =
    deployedCount === 0 && defaultBuckets.length === 0 && pinnedDefault === undefined;
  if (knowsNoBucketName) return defaultRules;
  return null;
}

/** Internal assurance seam for the exact rules source retained by Storage setup. */
export function getStorageRulesResolution(
  storage: FirebaseStorage,
): StorageRulesResolution | null {
  const target = targetOf(storage);
  const name = rulesBucketName(target.bucket, target.bucketName);
  const deployed = BUCKET_RULES.get(target.sandbox)?.get(name);
  if (deployed !== undefined) return deployed.resolution;
  const byBucket = BUCKET_RULES.has(target.sandbox);
  if (byBucket && !addressesDefaultBucket(target)) return null;
  const open = serviceCaches.openServices.get(target.sandbox);
  return open?.rulesResolution ?? null;
}
