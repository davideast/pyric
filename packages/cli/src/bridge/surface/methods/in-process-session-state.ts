/**
 * Persisted session state folded into `.pyric/state/in-process.json`'s
 * `services` map alongside the sandbox's own persistable service buckets.
 *
 * `sandbox.snapshot()` and `sandbox.loadSnapshot()` are keyed by registered
 * service name, and the `__pyric_cli_*` keys are never registered as services,
 * so the sandbox core passes them through untouched in both directions.
 */
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import type { LocalSandbox } from 'pyric/sandbox';

export const APP_SESSION_SERVICE_KEY = '__pyric_cli_app_session';

/**
 * What is captured for the app session: the signed-in uid and the tenant scope
 * it authenticated under, so a later process restores both rather than just the
 * uid and a default (untenanted) scope.
 */
export interface PersistedAppSession {
  uid: string;
  tenantId: string | null;
}

function isPersistedAppSession(value: unknown): value is PersistedAppSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { uid?: unknown; tenantId?: unknown };
  if (typeof record.uid !== 'string' || record.uid.length === 0) return false;
  return record.tenantId === null || typeof record.tenantId === 'string';
}

/**
 * The app session to fold into a snapshot's `services` map, or `null` when
 * signed out.
 */
export function captureAppSession(sandbox: LocalSandbox): PersistedAppSession | null {
  const auth = getAuth(sandbox);
  const uid = auth.currentUser?.uid ?? null;
  if (uid === null) return null;
  return { uid, tenantId: authSandbox.getTenantId(auth) };
}

/**
 * Sign the captured uid back in through the auth backend's restore seam
 * (`authSandbox.restoreSession`), then restore its tenant scope. A uid the user
 * pool no longer holds leaves the app signed out rather than throwing.
 */
export function restoreAppSession(sandbox: LocalSandbox, stored: unknown): void {
  if (!isPersistedAppSession(stored)) return;
  const auth = getAuth(sandbox);
  const exists = authSandbox.exportUsers(auth).some((user) => user.uid === stored.uid);
  if (!exists) return;
  authSandbox.restoreSession(auth, stored.uid);
  authSandbox.setTenantId(auth, stored.tenantId);
}
