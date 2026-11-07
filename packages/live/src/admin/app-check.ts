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
import { keepShape } from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';

type Method = (this: unknown, ...args: unknown[]) => unknown;

/** The calls the gate checks. */
const GATED_METHODS = ['verifyToken', 'createToken'] as const;

const PATCHED = Symbol.for('pyric.live.admin.appCheck.gated');

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Stands in for an AppCheck whose app cannot be read: it names no project, so the gate lets it run. */
const NO_APP: AdminApp = { options: {} };

/** The Admin app an AppCheck belongs to, which it keeps as `app`. */
function appOf(self: unknown): AdminApp {
  const app: unknown = isObject(self) ? Reflect.get(self, 'app') : undefined;
  const hasOptions = isObject(app) && isObject(Reflect.get(app, 'options'));
  return hasOptions ? (app as AdminApp) : NO_APP;
}

/** The gate the row passes. */
export interface AdminAppCheckRow {
  readonly gate: AdminProjectGate;
}

function gated(gate: AdminProjectGate, real: Method): Method {
  return keepShape(function gatedCall(this: unknown, ...args: unknown[]): unknown {
    return gate(appOf(this), () => Reflect.apply(real, this, args));
  }, real);
}

/**
 * Gates `verifyToken` and `createToken` on `AppCheck.prototype` of the real
 * `app-check.js` module `appCheckModule` once. Later calls change nothing.
 */
export function observeAdminAppCheck(appCheckModule: unknown, row: AdminAppCheckRow): void {
  const defined: unknown = isObject(appCheckModule) ? Reflect.get(appCheckModule, 'AppCheck') : undefined;
  const prototype: unknown = typeof defined === 'function' ? Reflect.get(defined, 'prototype') : undefined;
  const isPatchable = isObject(prototype) && !Object.hasOwn(prototype, PATCHED);
  if (!isPatchable) return;
  for (const name of GATED_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value !== 'function') continue;
    Object.defineProperty(prototype, name, { ...descriptor, value: gated(row.gate, descriptor.value as Method) });
  }
  Object.defineProperty(prototype, PATCHED, { value: true });
}
