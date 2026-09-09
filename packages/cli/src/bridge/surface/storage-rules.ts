/**
 * The Cloud Storage rules the sandbox is running.
 *
 * Storage rules are supplied when the service is first opened, so the source
 * is read back from the opened service's resolution record rather than from a
 * setter. A sandbox whose storage service was opened without rules has none,
 * and the rules operations say so instead of evaluating an empty ruleset.
 */
import type { StorageReference } from 'pyric/storage';
import { getStorageRulesResolution } from 'pyric/storage/internal';
import { storageFor } from './service-handles.js';
import type { SurfaceContext } from './types.js';

/** The active storage rules source, or null when the service was opened without rules. */
export function activeStorageRules(ctx: SurfaceContext): string | null {
  return getStorageRulesResolution(storageFor(ctx))?.source ?? null;
}

/**
 * The path a Storage rule matches on. Rules address an object through the
 * bucket, as `b/<bucket>/o/<object path>`, while the operation set names the
 * object path alone.
 */
export function rulesRequestPath(object: StorageReference): string {
  return `b/${object.bucket}/o/${object.fullPath}`;
}
