/**
 * `ProjectScope`, `Outcome`, `AdminApiError` — the foundation
 * primitives every control-plane operation in `@pyric/cli/deploy` (and
 * the factories built on top) shares.
 *
 * See the design rationale,
 * conventions F1–F8.
 *
 * - F2: Identity is a value; lifecycle is a resolver.
 * - F3: `ProjectScope = { projectId, resolveToken }`.
 * - F4: Resolvers fire per-dispatch. Hosts memoize via `memoizeTtl`.
 */

/**
 * Project-level credentials threaded through every control-plane
 * call. One scope object instead of `(token, projectId, …)`
 * signatures everywhere.
 *
 * `projectId` is stable identity — doesn't change for the life of
 * an agent session. `resolveToken` is the host's promise to deliver
 * a fresh-enough OAuth access token (with the `firebase` scope) on
 * demand. Per F4, callers invoke `resolveToken()` inside each
 * primitive call, not at construction time; hosts that care about
 * cost wrap the resolver in `memoizeTtl` (which `fromServiceAccount`
 * does internally).
 *
 * @example
 * ```ts
 * // Browser host — wraps Firebase Auth.
 * const scope: ProjectScope = {
 *   projectId,
 *   resolveToken: () => firebaseAuth.currentUser!.getIdToken(),
 * };
 *
 * // Node host — wraps service-account JWT exchange (already
 * // memoized internally).
 * const scope = await fromServiceAccount(saJsonPath);
 * ```
 */
export interface ProjectScope {
  readonly projectId: string;
  resolveToken(): Promise<string>;
}

/**
 * Outcome of an orchestrator. `ok: true` carries result data;
 * `ok: false` carries a coarse code (with two universal members:
 * `permission-denied` and `unknown`) plus an optional `partial`
 * for batch ops that succeeded on some entries and failed on
 * others.
 *
 * Primitives throw `AdminApiError` on non-2xx; orchestrators catch
 * and bucket into `Outcome.code`. See F4 + `withResolvedScope` for
 * the standard wrapping.
 */
export type Outcome<TData, TErrCode extends string = never> =
  | { ok: true; data: TData }
  | {
      ok: false;
      code: TErrCode | 'permission-denied' | 'unknown';
      message: string;
      partial?: unknown;
    };

/** Maximum size (bytes) we keep of an upstream error body. Large
 *  responses (Cloudflare HTML error pages, multi-MB stack traces
 *  from buggy proxies) would otherwise balloon error chains and
 *  structured event logs. */
const ADMIN_API_ERROR_BODY_CAP = 8 * 1024;

/**
 * Thrown by primitive (non-orchestrator) functions for non-2xx
 * responses from Firebase REST APIs. Orchestrators bucket these
 * into `Outcome.code`; consumers reaching for the primitive shape
 * can catch directly.
 *
 * `status` carries the HTTP status so callers can branch on
 * permission (`401` / `403`), not-found (`404`), conflict (`409`),
 * etc.; `body` carries the (capped) response payload for
 * diagnostics. Bodies larger than 8 KiB are truncated with a
 * `[truncated, N bytes]` suffix so callers can still tell when the
 * full payload was bigger than what they're seeing.
 */
export class AdminApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.body =
      body.length > ADMIN_API_ERROR_BODY_CAP
        ? `${body.slice(0, ADMIN_API_ERROR_BODY_CAP)}…[truncated, ${body.length - ADMIN_API_ERROR_BODY_CAP} bytes]`
        : body;
  }
}
