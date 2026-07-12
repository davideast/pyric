/**
 * `withResolvedScope` — standard wrapper for the resolver + try /
 * catch shape primitives use to surface auth failures as structured
 * `Outcome` values instead of thrown exceptions.
 *
 * Per F4, every primitive that needs an access token calls
 * `scope.resolveToken()` inside its execute path. The resolver can
 * fail (network down, SA invalid, OAuth flow timed out, etc.). The
 * convention is: bucket those failures into `Outcome` so the
 * dispatcher doesn't have to catch + stringify.
 */

import { AdminApiError, type Outcome, type ProjectScope } from './scope.js';

/**
 * Bucket a thrown error from a resolver or REST call into the right
 * outcome code. Inspects `AdminApiError` for HTTP-status-aware
 * bucketing; falls back to `'unknown'` for everything else so
 * transport / network failures don't get mislabeled as
 * `'permission-denied'`.
 */
function bucketError(e: unknown): {
  code: 'permission-denied' | 'not-found' | 'unknown';
  message: string;
} {
  if (e instanceof AdminApiError) {
    const code: 'permission-denied' | 'not-found' | 'unknown' =
      e.status === 401 || e.status === 403
        ? 'permission-denied'
        : e.status === 404
          ? 'not-found'
          : 'unknown';
    return { code, message: e.message };
  }
  return {
    code: 'unknown',
    message: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Run `fn` with a freshly-resolved token + the scope's projectId.
 * Buckets:
 *
 * - Resolver throws `AdminApiError` with 401/403 → `permission-denied`.
 * - Resolver throws anything else (network, DNS, offline) → `unknown`.
 *   (Not `permission-denied` — that mislabels transport failures and
 *   sends consumers hunting for IAM issues that don't exist.)
 * - `fn` throws `AdminApiError` → bucketed by HTTP status.
 * - `fn` throws anything else → `unknown`.
 * - `fn` returns a value → `{ ok: true, data: value }`.
 *
 * Factories whose tools need finer-grained error buckets (e.g.
 * `'invalid-config'`, `'create-failed'`) wrap the result of
 * `withResolvedScope` and re-bucket; this helper handles the
 * resolver-throw + happy-path / AdminApiError-aware wrapping.
 */
export async function withResolvedScope<TData>(
  scope: ProjectScope,
  fn: (token: string, projectId: string) => Promise<TData>,
): Promise<Outcome<TData, 'not-found'>> {
  let token: string;
  try {
    token = await scope.resolveToken();
  } catch (e) {
    const { code, message } = bucketError(e);
    return {
      ok: false,
      code,
      message: `Auth refresh failed: ${message}`,
    };
  }
  try {
    const data = await fn(token, scope.projectId);
    return { ok: true, data };
  } catch (e) {
    const { code, message } = bucketError(e);
    return { ok: false, code, message };
  }
}
