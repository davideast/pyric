/**
 * The Admin Auth row: patches `BaseAuth.prototype` in the real
 * `firebase-admin/lib/auth/base-auth.js` (`patch.ts`), the class `Auth` and
 * each tenant's Auth extend, so each Admin call makes a record named
 * `Auth.<method>` with the project and production's code
 * (`auth/user-not-found`).
 *
 * Observed: `verifyIdToken`, `getUser`, `getUserByEmail`,
 * `getUserByPhoneNumber`, `getUsers`, `listUsers`, `createUser`,
 * `updateUser`, `deleteUser`, `deleteUsers`, `setCustomUserClaims` and
 * `revokeRefreshTokens`.
 *
 * The account a record names: on `verifyIdToken`, the decoded token's uid
 * and the names of its claims; on a call about one user, that user's uid
 * (the argument, or the returned user's for a lookup by email or phone
 * number and for `createUser`); none on `listUsers`, `getUsers` and
 * `deleteUsers`. A record never carries a token, password, email, phone
 * number, claim value or any other profile field.
 */
import { claimNamesOf } from '../account.js';
import type { CallContext, LiveAccount, LiveObserver, ResultReading } from '../observe.js';
import { patchAdminClass, type AdminMethod, type AdminRow } from './patch.js';
import type { AdminApp, AdminProjectGate } from './project-gate.js';

/** The module an Admin Auth record names, which the page observer maps to the `auth` service. */
export const ADMIN_AUTH_MODULE = 'firebase-admin/auth';

const MAX_UID_LENGTH = 128;

/** The account one call names, filled in as the call's arguments and result are read. */
interface Target {
  uid?: string;
  claimNames?: readonly string[];
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isUid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_UID_LENGTH;
}

/** The Admin app an Auth belongs to: its request handler's, which `Auth` and a tenant's Auth both keep. */
function adminAppOf(self: unknown): unknown {
  const handler: unknown = isObject(self) ? Reflect.get(self, 'authRequestHandler') : undefined;
  const app: unknown = isObject(handler) ? Reflect.get(handler, 'app') : undefined;
  return isObject(app) ? app : undefined;
}

/** Stands in for an Auth whose app cannot be read: it names no project, so the gate lets it run. */
const NO_APP: AdminApp = { options: {} };

/** The app the gate checks: firebase-admin's own `App`, whose options and credential resolve its project. */
function appOf(self: unknown): AdminApp {
  const app = adminAppOf(self);
  const hasOptions = isObject(app) && isObject(Reflect.get(app, 'options'));
  return hasOptions ? (app as AdminApp) : NO_APP;
}

/** The project the app was given, without asking its credential to resolve one. */
function projectIdOf(self: unknown): string | undefined {
  const app = adminAppOf(self);
  const options: unknown = isObject(app) ? Reflect.get(app, 'options') : undefined;
  const projectId: unknown = isObject(options) ? Reflect.get(options, 'projectId') : undefined;
  return typeof projectId === 'string' && projectId !== '' ? projectId : undefined;
}

/** The methods whose first argument is the uid of the one user they act on. */
const TARGET_ARGUMENT: ReadonlySet<string> = new Set(['getUser', 'updateUser', 'deleteUser', 'setCustomUserClaims', 'revokeRefreshTokens']);

/** One call's context: its project, and the account it names so far. */
function contextOf(name: string, args: readonly unknown[], self: unknown): CallContext {
  const target: Target = {};
  const method = name.slice(name.indexOf('.') + 1);
  if (TARGET_ARGUMENT.has(method) && isUid(args[0])) target.uid = args[0];
  if (method === 'verifyIdToken') target.claimNames = claimNamesOf(args[0]);
  const projectId = projectIdOf(self);
  return projectId === undefined ? { subject: target } : { subject: target, projectId };
}

/** A resolved value's uid: the returned user's, or the decoded token's. Adds nothing else to the record. */
function resultUid(site: { readonly subject?: unknown }, value: unknown): ResultReading {
  const uid: unknown = isObject(value) ? Reflect.get(value, 'uid') : undefined;
  const target = site.subject as Target | undefined;
  if (target !== undefined && isUid(uid)) target.uid = uid;
  return {};
}

/** The account a call's target names, or none. */
function accountOf(subject: unknown): LiveAccount | undefined {
  const target = subject as Target | undefined;
  if (target?.uid === undefined) return undefined;
  const names = target.claimNames === undefined ? {} : { claimNames: [...target.claimNames] };
  return { uid: target.uid, ...names };
}

const HOOKS = { context: contextOf, accountOf, throwsLocally: true } as const;

function calls(names: readonly string[], extra: Partial<AdminMethod> = {}): AdminMethod[] {
  return names.map((name) => ({ name, ...HOOKS, ...extra }));
}

const METHODS: readonly AdminMethod[] = [
  ...calls(['getUser', 'updateUser', 'deleteUser', 'setCustomUserClaims', 'revokeRefreshTokens', 'getUsers', 'listUsers', 'deleteUsers']),
  ...calls(['verifyIdToken', 'getUserByEmail', 'getUserByPhoneNumber', 'createUser'], { resultOf: resultUid }),
];

/** Where the records go and which gate the calls pass. */
export interface AdminAuthRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
}

/**
 * Patches `BaseAuth.prototype` of the real `base-auth.js` module `baseAuth`
 * once. Later calls change nothing.
 */
export function observeAdminAuth(baseAuth: unknown, row: AdminAuthRow): void {
  const defined: unknown = isObject(baseAuth) ? Reflect.get(baseAuth, 'BaseAuth') : undefined;
  const prototype: unknown = typeof defined === 'function' ? Reflect.get(defined, 'prototype') : undefined;
  const adminRow: AdminRow = { module: ADMIN_AUTH_MODULE, observer: row.observer, gate: row.gate, appOf };
  patchAdminClass(isObject(prototype) ? prototype : undefined, 'Auth', METHODS, adminRow);
}
