import type { StorageRequestResource, StorageResource } from './rules.js';

export function resourceFromStored(
  stored:
    | {
        size: number;
        contentType?: string;
        customMetadata?: Record<string, string>;
        fullPath?: string;
        bucket?: string;
        timeCreated?: string;
        updated?: string;
        generation?: string;
        metageneration?: string;
      }
    | null
    | undefined,
): StorageResource | null {
  if (!stored) return null;
  return {
    size: stored.size,
    contentType: stored.contentType,
    metadata: stored.customMetadata,
    // GCS object-name semantics — see the StorageResource docblock. Neither of
    // the persisted record's two path fields is this value as-is:
    //   - `name` is the LAST SEGMENT (`pic.png`), the client SDK's FullMetadata
    //     semantics — too short.
    //   - `fullPath` is the FULL RESOURCE NAME including the
    //     `b/<bucket>/o/` prefix (`b/pyric-default/o/uploads/pic.png`), because
    //     that is the path the rules match tree walks — too long.
    // The rules binding is the object path WITHIN the bucket
    // (`uploads/pic.png`), which is `fullPath` with that prefix stripped.
    name: objectNameFromFullPath(stored.fullPath, stored.bucket),
    bucket: stored.bucket,
    timeCreated: stored.timeCreated,
    updated: stored.updated,
    // Persisted as strings (FullMetadata shape); production types both `int`.
    generation: numberOrUndefined(stored.generation),
    metageneration: numberOrUndefined(stored.metageneration),
  };
}

/**
 * Reduce a persisted `fullPath` to the rules language's `resource.name` — the
 * object path WITHIN the bucket.
 *
 * The persisted path is the full resource name (`b/<bucket>/o/<object>`), the
 * form the rules match tree walks. Production's `resource.name` is only the
 * `<object>` part, so the `b/<bucket>/o/` prefix comes off. The bucket-specific
 * prefix is tried first; a generic `b/<any>/o/` is the fallback so a record
 * whose `bucket` field is missing still reduces correctly. A path carrying no
 * such prefix is already an object path and passes through untouched.
 */
function objectNameFromFullPath(
  fullPath: string | undefined,
  bucket: string | undefined,
): string | undefined {
  if (fullPath === undefined) return undefined;
  const path = fullPath.startsWith('/') ? fullPath.slice(1) : fullPath;
  if (bucket !== undefined) {
    const prefix = `b/${bucket}/o/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  const generic = /^b\/[^/]+\/o\//.exec(path);
  if (generic) return path.slice(generic[0].length);
  return path;
}

/** Parse a persisted numeric-string field, dropping anything unparseable so it
 *  reads as ABSENT (→ deny) rather than as a bogus number. */
function numberOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The object record a write would store, in the persisted metadata shape. */
export interface WrittenObject {
  /** Object path, with or without the `b/<bucket>/o/` prefix. */
  fullPath: string;
  bucket: string;
  size: number;
  contentType?: string;
  customMetadata?: Record<string, string>;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  /** Persisted as a numeric string; read only for a metadata update. */
  generation?: string;
  metageneration?: string;
}

/**
 * Which write builds the binding. `upload` writes new bytes, whether or not an
 * object exists at the path; `metadataUpdate` rewrites the metadata of a stored
 * object and keeps its bytes.
 */
export type StorageWrite = 'upload' | 'metadataUpdate';

/**
 * Build the `request.resource` binding for a write from the object it would
 * store. See {@link StorageRequestResource} for the production shape.
 *
 * An upload gets the defaults the Firebase Storage upload endpoint applies to
 * an unset `contentDisposition` (`inline; filename*=utf-8''<last path
 * segment>`) and `contentEncoding` (`identity`), and `null` versions and
 * `etag`, which the object has not been assigned yet. A metadata update reads
 * `generation` and `metageneration` from `object`, so the caller passes the
 * stored metageneration: production does not show the rule the advance the
 * write makes.
 */
export function requestResourceFor(object: WrittenObject, write: StorageWrite): StorageRequestResource {
  const name = objectNameFromFullPath(object.fullPath, object.bucket);
  const upload = write === 'upload';
  const resource: StorageRequestResource = {
    name,
    bucket: object.bucket,
    size: object.size,
    contentType: object.contentType,
    contentDisposition: object.contentDisposition
      ?? (upload ? `inline; filename*=utf-8''${name?.split('/').pop() ?? ''}` : null),
    contentEncoding: object.contentEncoding ?? (upload ? 'identity' : null),
    contentLanguage: object.contentLanguage ?? null,
    cacheControl: object.cacheControl ?? null,
    metadata: object.customMetadata ?? null,
  };
  if (upload) {
    resource.generation = null;
    resource.metageneration = null;
    resource.etag = null;
  } else {
    resource.generation = numberOrUndefined(object.generation);
    resource.metageneration = numberOrUndefined(object.metageneration);
  }
  return resource;
}
