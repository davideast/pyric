/**
 * The Cloud Storage rules the sandbox is running.
 *
 * The source is read back from the opened service's resolution record, which
 * carries whatever the service is enforcing: the rules it opened with, or the
 * ones a later `set` installed through `replaceStorageRules`. A sandbox whose
 * storage service was opened without rules and never had any installed has
 * none, and the rules operations say so instead of evaluating an empty
 * ruleset.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import { getStorageSandbox, type FirebaseStorage } from 'pyric/storage';
import {
  getAdminStorageSandbox,
  getStorageRulesResolution,
  nameStorageBucket,
  rulesBucketName,
} from 'pyric/storage/internal';
import { storageFor } from './service-handles.js';
import type { SandboxSurfaceContext } from './types.js';

/**
 * The bucket a call names by its name or `gs://` URL, or null when it names
 * none or names the app's default bucket, which the default handle serves.
 */
function namedOtherBucket(ctx: SandboxSurfaceContext, bucket: string | undefined): string | null {
  if (bucket === undefined || bucket === '') return null;
  const name = rulesBucketName('', bucket);
  const defaultName = ctx.storageBucketName?.();
  const namesDefault = defaultName !== undefined && rulesBucketName('', defaultName) === name;
  return namesDefault ? null : name;
}

/**
 * A Cloud Storage handle for the held identity on the bucket `bucket` names,
 * stored and seen by rules under that name, as `getStorage(app, 'gs://<name>')`
 * opens it (#1313). Absent, or naming the default bucket, the default handle.
 */
export function storageForBucket(ctx: SandboxSurfaceContext, bucket?: string): FirebaseStorage {
  const name = namedOtherBucket(ctx, bucket);
  if (name === null) return storageFor(ctx);
  const handle = ctx.identity.bypassesRules()
    ? getAdminStorageSandbox(ctx.sandbox, { bucket: name })
    : getStorageSandbox(ctx.sandbox.withAuth(ctx.identity.authState()), { bucket: name });
  return nameStorageBucket(handle, name);
}

/**
 * A project's storage rules source that could not be loaded into the service
 * because it does not parse. The service runs without rules in that case, but
 * the lint operation must still be able to report what is wrong with the file.
 */
const unloadedStorageRules = new WeakMap<LocalSandbox, string>();

/** Remember a storage rules source the service refused, so lint can read it. */
export function rememberUnloadedStorageRules(sandbox: LocalSandbox, source: string): void {
  unloadedStorageRules.set(sandbox, source);
}

/**
 * The storage rules source in force on the bucket `bucket` names (absent, the
 * default bucket), or for the default bucket the project source that failed
 * to load, or null when the bucket has no rules.
 */
export function activeStorageRules(ctx: SandboxSurfaceContext, bucket?: string): string | null {
  const loaded = getStorageRulesResolution(storageForBucket(ctx, bucket))?.source;
  if (loaded !== undefined) return loaded;
  if (namedOtherBucket(ctx, bucket) !== null) return null;
  return unloadedStorageRules.get(ctx.sandbox) ?? null;
}
