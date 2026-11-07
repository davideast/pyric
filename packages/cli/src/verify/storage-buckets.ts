/**
 * Which rules each Storage bucket replays under.
 *
 * Production keeps one release per bucket, so each bucket replays under its
 * own candidate rules, by the name its rules saw it under. The default
 * bucket also takes the candidate rules passed without a bucket. A bucket
 * with no candidate rules replays as locked, as production creates a bucket
 * (owner decision multi-resource-1). Without any per-bucket rules, one
 * ruleset governs every bucket, as the sandbox does until a host deploys per
 * bucket.
 */
import { DEFAULT_BUCKET, type CompiledStorageRules } from 'pyric/storage/internal';
import type { SandboxOperationEvent } from 'pyric/sandbox';

type StorageRules = CompiledStorageRules['rules'];

/** The rules one bucket replays under, or `locked` when none were passed for it. */
export type StorageBucketRules =
  | { readonly kind: 'rules'; readonly rules: StorageRules }
  | { readonly kind: 'locked'; readonly bucket: string };

/** Each bucket's compiled candidate rules, and the default bucket's. */
export interface StorageCandidateRuleset {
  /** The rules passed without a bucket: the default bucket's, or every bucket's when `buckets` is absent. */
  readonly defaultRules?: StorageRules;
  /** Rules by bucket name; present means each bucket replays under its own. */
  readonly buckets?: ReadonlyMap<string, StorageRules>;
}

/** The bucket name an operation's rules saw, as its event recorded it; the store key for an event from before it was recorded. */
export function recordedBucketName(opEvent: SandboxOperationEvent, bucket: string): string {
  const named = (opEvent.detail as { bucketName?: unknown } | undefined)?.bucketName;
  return typeof named === 'string' && named !== '' ? named : bucket;
}

/** The rules a request on the bucket stored under `stored`, known as `name`, replays under. */
export function storageBucketRules(
  ruleset: StorageCandidateRuleset,
  stored: string,
  name: string,
): StorageBucketRules {
  const sharedRules = ruleset.buckets === undefined ? ruleset.defaultRules : undefined;
  if (sharedRules !== undefined) return { kind: 'rules', rules: sharedRules };
  const deployed = ruleset.buckets?.get(name);
  if (deployed !== undefined) return { kind: 'rules', rules: deployed };
  const defaultRules = stored === DEFAULT_BUCKET ? ruleset.defaultRules : undefined;
  if (defaultRules !== undefined) return { kind: 'rules', rules: defaultRules };
  return { kind: 'locked', bucket: name };
}

/** Why a request on a locked bucket replays as denied. */
export function lockedBucketReason(bucket: string): string {
  return `Storage bucket "${bucket}" has no candidate rules, so it replays as locked. Pass rules for it by bucket name.`;
}
