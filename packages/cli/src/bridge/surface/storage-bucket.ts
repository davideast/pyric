/**
 * The Cloud Storage bucket a `storage` method call selects.
 *
 * `bucket` is parsed by the SDK's own `parseBucketSpec` rules: a bare bucket
 * name, a root `gs://<bucket>[/]` or Firebase Storage download URL, or
 * `default`. Naming the app's default bucket selects the default handle, just
 * as `getStorage(app)` and `getStorage(app, 'gs://<defaultBucket>')` share one
 * bucket in production. Naming any other bucket opens a handle scoped to that
 * bucket so its objects and deployed Security Rules stay isolated.
 */
import { getStorageSandbox, type FirebaseStorage } from 'pyric/storage';
import {
  getAdminStorageSandbox,
  nameStorageBucket,
  parseBucketSpec,
} from 'pyric/storage/internal';
import { storageFor } from './service-handles.js';
import type { SandboxSurfaceContext } from './types.js';

const BUCKET_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Parse a `storage` call's `bucket` selector into a validated bucket name, or
 * `undefined` when it names `default`. Throws on URLs carrying an object path
 * (`storage/invalid-default-bucket`) or strings outside the bucket grammar.
 */
export function parseStorageBucket(raw: string): string | undefined {
  if (raw.toLowerCase() === 'default') return undefined;
  const parsed = parseBucketSpec(raw);
  if (!BUCKET_NAME_PATTERN.test(parsed)) {
    throw new Error(`Invalid bucket "${raw}".`);
  }
  return parsed;
}

/**
 * The non-default bucket name a call's `bucket` argument selects, or
 * `undefined` when omitted, `default`, or matching the app's default bucket.
 */
export function selectedStorageBucket(
  ctx: SandboxSurfaceContext,
  raw: unknown,
): string | undefined {
  if (raw === undefined) return undefined;
  const rawBucket = String(raw);
  const parsed = parseStorageBucket(rawBucket);
  if (parsed === undefined) return undefined;
  const rawDefault = ctx.storageBucketName?.();
  if (rawDefault !== undefined && rawDefault !== '') {
    const defaultName = parseBucketSpec(rawDefault);
    if (defaultName === parsed) return undefined;
  }
  return parsed;
}

/**
 * A Cloud Storage handle for the held identity on `selector`, or the default
 * bucket handle when `selector` is `undefined`.
 */
export function storageAtBucket(
  ctx: SandboxSurfaceContext,
  selector: string | undefined,
): FirebaseStorage {
  if (selector === undefined) return storageFor(ctx);
  if (ctx.identity.bypassesRules()) {
    const adminHandle = getAdminStorageSandbox(ctx.sandbox, { bucket: selector });
    return nameStorageBucket(adminHandle, selector);
  }
  const clientContext = ctx.sandbox.withAuth(ctx.identity.authState());
  const clientHandle = getStorageSandbox(clientContext, { bucket: selector });
  return nameStorageBucket(clientHandle, selector);
}

/** A summary that names the bucket when it is not the default bucket. */
export function onBucket(summary: string, selector: string | undefined): string {
  if (selector === undefined) return summary;
  return `${summary} on ${selector}`;
}
