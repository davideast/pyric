import type { StorageRequest, StorageResource } from './rules.js';

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

/**
 * Build the `request.resource` binding for a write. The custom
 * metadata the client is about to set becomes `request.resource.metadata`
 * so `allow write: if request.resource.metadata.owner == request.auth.uid`
 * evaluates against the real incoming value rather than `undefined`.
 */
export function requestResourceFor(args: {
  size: number;
  contentType?: string;
  customMetadata?: Record<string, string>;
}): NonNullable<StorageRequest['resource']> {
  return {
    size: args.size,
    contentType: args.contentType,
    metadata: args.customMetadata,
  };
}
