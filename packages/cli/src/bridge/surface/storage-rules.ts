/**
 * The Cloud Storage rules the sandbox is running.
 *
 * Storage rules are supplied when the service is first opened, so the source
 * is read back from the opened service's resolution record rather than from a
 * setter. A sandbox whose storage service was opened without rules has none,
 * and the rules operations say so instead of evaluating an empty ruleset.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import type { StorageReference } from 'pyric/storage';
import { getStorageRulesResolution } from 'pyric/storage/internal';
import { storageFor } from './service-handles.js';
import type { SurfaceContext } from './types.js';

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
 * The storage rules source in force, or the project source that failed to
 * load, or null when the service was opened without rules.
 */
export function activeStorageRules(ctx: SurfaceContext): string | null {
  const loaded = getStorageRulesResolution(storageFor(ctx))?.source;
  if (loaded !== undefined) return loaded;
  return unloadedStorageRules.get(ctx.sandbox) ?? null;
}

/**
 * The path a Storage rule matches on. Rules address an object through the
 * bucket, as `b/<bucket>/o/<object path>`, while the operation set names the
 * object path alone.
 */
export function rulesRequestPath(object: StorageReference): string {
  return `b/${object.bucket}/o/${object.fullPath}`;
}
