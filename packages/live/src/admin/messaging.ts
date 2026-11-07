/**
 * The Admin Messaging row: patches `Messaging.prototype` in the real
 * `firebase-admin/lib/messaging/messaging.js` (`patch.ts`), so each Admin call
 * passes the project gate and makes a record named `Messaging.<method>` with
 * the project and production's code (`messaging/invalid-argument`).
 *
 * Observed: `send`, `sendEach`, `sendEachForMulticast`, `subscribeToTopic`
 * and `unsubscribeFromTopic`. `sendEachForMulticast` calls `sendEach`, and
 * makes one record. A record names no account and never carries a
 * registration token, a topic, a condition or any part of a message.
 */
import type { CallContext, LiveObserver } from '../observe.js';
import { patchAdminClass, type AdminMethod, type AdminRow } from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';

/** The module an Admin Messaging record names, which the page observer maps to the `messaging` service. */
export const ADMIN_MESSAGING_MODULE = 'firebase-admin/messaging';

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Stands in for a Messaging whose app cannot be read: it names no project, so the gate lets it run. */
const NO_APP: AdminApp = { options: {} };

/** The Admin app a Messaging belongs to, which it keeps as `appInternal`. */
function appOf(self: unknown): AdminApp {
  const app: unknown = isObject(self) ? Reflect.get(self, 'appInternal') : undefined;
  const hasOptions = isObject(app) && isObject(Reflect.get(app, 'options'));
  return hasOptions ? (app as AdminApp) : NO_APP;
}

/** One call's context: the project the app was given, and nothing from its arguments. */
function contextOf(_name: string, _args: readonly unknown[], self: unknown): CallContext {
  const projectId = appOf(self).options.projectId;
  return projectId === undefined || projectId === '' ? {} : { projectId };
}

const METHODS: readonly AdminMethod[] = ['send', 'sendEach', 'sendEachForMulticast', 'subscribeToTopic', 'unsubscribeFromTopic'].map(
  (name) => ({ name, context: contextOf, throwsLocally: true }),
);

/** Where the records go, and which gate the calls pass. */
export interface AdminMessagingRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
}

/**
 * Patches `Messaging.prototype` of the real `messaging.js` module
 * `messagingModule` once. Later calls change nothing.
 */
export function observeAdminMessaging(messagingModule: unknown, row: AdminMessagingRow): void {
  const defined: unknown = isObject(messagingModule) ? Reflect.get(messagingModule, 'Messaging') : undefined;
  const prototype: unknown = typeof defined === 'function' ? Reflect.get(defined, 'prototype') : undefined;
  const adminRow: AdminRow = { module: ADMIN_MESSAGING_MODULE, observer: row.observer, gate: row.gate, appOf };
  patchAdminClass(isObject(prototype) ? prototype : undefined, 'Messaging', METHODS, adminRow);
}
