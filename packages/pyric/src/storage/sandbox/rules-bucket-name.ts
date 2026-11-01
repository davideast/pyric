/**
 * The bucket name Storage rules see.
 *
 * The sandbox stores the app's default bucket under the key `pyric-default`,
 * and that key stays the store's: persistence and salvage read it. Production
 * binds the bucket's real name in the rules (the `b/<bucket>/o` match path,
 * `request.resource.bucket` and `resource.bucket`), so the rules input carries
 * the name the caller knows the bucket by: the app's `storageBucket`, the
 * bucket URL `getStorage` was given, or the bucket a host op named. Every
 * plane binds it here, at the one boundary where the rules input is built.
 */
import type { EvaluationInput } from './rules.js';

const GS_URL = /^gs:\/\/([^/]+)\/?$/;

/**
 * The name rules see for a bucket stored under `stored`: the caller's name
 * for it, or the stored key when the caller names none. A `gs://` bucket URL
 * reads as its bucket name.
 */
export function rulesBucketName(stored: string, callerName: string | undefined): string {
  const named = callerName !== undefined && callerName !== '';
  if (!named) return stored;
  return GS_URL.exec(callerName)?.[1] ?? callerName;
}

/** A bucket field the store filled with its key reads as the bucket's name. */
function named<T extends { bucket?: string }>(binding: T, stored: string, name: string): T {
  return binding.bucket === stored ? { ...binding, bucket: name } : binding;
}

/**
 * The rules input for one request on a bucket stored under `stored` and
 * known as `name`: the path rooted at `b/<name>/o`, and the bucket fields of
 * `request.resource` and `resource` under that name.
 */
export function bindRulesBucket(input: EvaluationInput, stored: string, name: string): EvaluationInput {
  const objectPath = input.request.path.replace(/^\/+/, '');
  const requestResource = input.request.resource;
  return {
    ...input,
    request: {
      ...input.request,
      path: objectPath === '' ? `b/${name}/o` : `b/${name}/o/${objectPath}`,
      ...(requestResource === undefined ? {} : { resource: named(requestResource, stored, name) }),
    },
    ...(input.resource == null ? {} : { resource: named(input.resource, stored, name) }),
  };
}
