/**
 * Pure, stateless Realtime Database write-target path normalization and
 * write-method target planning shared across client and Admin session capture.
 */
import { isPlainObject } from './json-copy.js';

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

export interface RtdbWritePlanInput {
  readonly name: string;
  readonly instance: string;
  readonly path: string | undefined;
  readonly patchArg?: unknown;
  readonly adminPushChildPath?: string;
  readonly resolveClientPushPath?: (returned: unknown) => string | undefined;
}

export interface RtdbWritePlan {
  readonly instance: string;
  readonly paths: readonly string[];
  readonly resolveNarrowedPath?: (returned: unknown) => string | undefined;
}

/** Computes the pure target-path write plan for a client or Admin RTDB write call, or `undefined` for non-writes. */
export function planRtdbWritePaths(input: RtdbWritePlanInput): RtdbWritePlan | undefined {
  const kind = RTDB_INFLIGHT_WRITE_KINDS[input.name];
  if (kind === undefined) return undefined;
  const fallbackPath = normalizeInFlightRtdbPath(input.path);
  if (kind === 'patch') {
    return {
      instance: input.instance,
      paths: patchWritePathsOf(input.path, input.patchArg),
    };
  }
  if (kind === 'client-push') {
    return {
      instance: input.instance,
      paths: [fallbackPath],
      resolveNarrowedPath: input.resolveClientPushPath,
    };
  }
  if (kind === 'admin-push') {
    let targetPath = fallbackPath;
    if (input.adminPushChildPath !== undefined) {
      targetPath = normalizeInFlightRtdbPath(input.adminPushChildPath);
    }
    return {
      instance: input.instance,
      paths: [targetPath],
    };
  }
  return {
    instance: input.instance,
    paths: [fallbackPath],
  };
}
