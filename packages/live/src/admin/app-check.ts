/**
 * The Admin App Check row: a gated row. It patches `AppCheck.prototype` in
 * the real `firebase-admin/lib/app-check/app-check.js`, so `verifyToken` and
 * `createToken` pass the project gate first: a call whose app names another
 * project is refused with `PYRIC_LIVE_REFUSED` before any request, and every
 * other call reaches the real method as it is.
 *
 * It makes no record, so these calls don't show in traffic: the host's
 * observed calls have no App Check service yet. The start line and the
 * process health name App Check as gated but unobserved.
 */
import { failClosedGate, readAdminApp, type AdminProjectGate } from './project-gate.js';
import { gatePrototypeMethods } from './prototype-gate.js';

const PATCHED = Symbol.for('pyric.live.admin.appCheck.gated');
const LOCAL_METHODS: ReadonlySet<string> = new Set(['validateVerifyAppCheckTokenOptions']);

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** The gate the row passes. */
export interface AdminAppCheckRow {
  readonly gate: AdminProjectGate;
}

/**
 * Gates `AppCheck.prototype` of the real `app-check.js` module
 * `appCheckModule` once. Later calls change nothing.
 */
export function observeAdminAppCheck(appCheckModule: unknown, row: AdminAppCheckRow): void {
  const defined: unknown = isObject(appCheckModule) ? Reflect.get(appCheckModule, 'AppCheck') : undefined;
  const prototype: unknown = typeof defined === 'function' ? Reflect.get(defined, 'prototype') : undefined;
  const isPatchable = isObject(prototype) && !Object.hasOwn(prototype, PATCHED);
  if (!isPatchable) return;
  const gate = failClosedGate(row.gate, 'AppCheck');
  gatePrototypeMethods(prototype, {
    gate,
    appOf: (self) => readAdminApp(self, 'app'),
    allowlist: LOCAL_METHODS,
  });
  Object.defineProperty(prototype, PATCHED, { value: true });
}
