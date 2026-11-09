/**
 * Stateless Realtime Database write-target path planning and write-method
 * classification shared across client (`database-session-capture.ts`), Admin
 * (`admin/database-session-capture.ts`), and `database.ts`.
 */
import { createInFlightRtdbWriteStarter } from './database-inflight-writes.js';
import { isPlainObject } from './json-copy.js';
import type { CallLifecycleLease } from './session-data.js';

/**
 * The instance a record names when the reference's repo does not say. A
 * default instance is the project id, at most 30 characters, or ends in
 * `-default-rtdb`; this name is 40 characters and doesn't, so it can't be a
 * default instance. A host requires an instance on every RTDB call, so the
 * call still reaches Traffic.
 */
export const UNREAD_INSTANCE = 'instance-not-read-from-the-sdk-reference';

export type RtdbInFlightWriteKind = 'single' | 'patch' | 'client-push' | 'admin-push';

const RTDB_INFLIGHT_WRITE_KINDS: Readonly<Record<string, RtdbInFlightWriteKind>> = {
  remove: 'single',
  set: 'single',
  setWithPriority: 'single',
  setPriority: 'single',
  update: 'patch',
  push: 'client-push',
  runTransaction: 'single',
  'Reference.remove': 'single',
  'Reference.set': 'single',
  'Reference.setWithPriority': 'single',
  'Reference.setPriority': 'single',
  'Reference.update': 'patch',
  'Reference.push': 'admin-push',
  'Reference.transaction': 'single',
};

/** Joins relative RTDB path segments onto `basePath` in canonical leading-slash form. */
export function joinRtdbSubpath(basePath: string | undefined, relSegments: readonly string[]): string {
  const baseSegments = (basePath ?? '/').split('/').filter((seg) => seg.length > 0);
  const cleanRel = relSegments.filter((seg) => seg.length > 0);
  const all = [...baseSegments, ...cleanRel];
  if (all.length === 0) return '/';
  return `/${all.join('/')}`;
}

/** Normalizes a raw RTDB path to canonical leading-slash form (`'/'` for root). */
export function normalizeInFlightRtdbPath(rawPath: string | undefined): string {
  return joinRtdbSubpath(rawPath, []);
}

/** Extracts target subpaths of an RTDB `update` patch, falling back to `[basePath]` when unstructured. */
export function patchWritePathsOf(basePath: string | undefined, rawPatch: unknown): string[] {
  const base = normalizeInFlightRtdbPath(basePath);
  if (!isPlainObject(rawPatch)) return [base];
  const paths: string[] = [];
  for (const [relKey, rawVal] of Object.entries(rawPatch)) {
    if (rawVal === undefined) continue;
    const relSegments = relKey.split('/').filter((seg) => seg.length > 0);
    if (relSegments.length === 0) return [base];
    paths.push(joinRtdbSubpath(base, relSegments));
  }
  return paths;
}

export interface RtdbWriteLeaseInput {
  readonly name: string;
  readonly instance: string;
  readonly path: string | undefined;
  readonly patchArg?: unknown;
  readonly adminPushChildPath?: string;
  readonly resolveClientPushPath?: (returned: unknown) => string | undefined;
}

/** Shared client and Admin RTDB write-lease dispatcher keyed by canonical write export/method name. */
export function rtdbWriteLeaseStarter(input: RtdbWriteLeaseInput): (() => CallLifecycleLease) | undefined {
  const kind = RTDB_INFLIGHT_WRITE_KINDS[input.name];
  if (kind === undefined) return undefined;
  const fallbackPath = normalizeInFlightRtdbPath(input.path);
  if (kind === 'patch') {
    return createInFlightRtdbWriteStarter(input.instance, patchWritePathsOf(input.path, input.patchArg));
  }
  if (kind === 'client-push') {
    return createInFlightRtdbWriteStarter(input.instance, [fallbackPath], input.resolveClientPushPath);
  }
  if (kind === 'admin-push') {
    let targetPath = fallbackPath;
    if (input.adminPushChildPath !== undefined) {
      targetPath = input.adminPushChildPath;
    }
    return createInFlightRtdbWriteStarter(input.instance, [targetPath]);
  }
  return createInFlightRtdbWriteStarter(input.instance, [fallbackPath]);
}
