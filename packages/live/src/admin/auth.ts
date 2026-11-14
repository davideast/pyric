/**
 * The Admin Auth row: patches `BaseAuth.prototype` and its sibling sub-manager
 * prototypes (`TenantAwareAuth`, `TenantManager`, `ProjectConfigManager`) in
 * the real `firebase-admin/lib/auth/*`, so every Admin Auth RPC passes
 * `AdminProjectGate` before any request and makes a record with the project and
 * production's code (`auth/user-not-found`).
 *
 * A record never carries a token, password, email, phone number, claim value or
 * any other profile field.
 *
 * `verifyIdToken` and `verifySessionCookie` refuse a token a pyric sandbox
 * issued, by name, before any request and with no record: the error keeps
 * firebase-admin's `auth/argument-error` and adds `pyricCode:
 * 'PYRIC_MODE_MISMATCH'` (G-3 in the #2304 plan).
 */
import { createRequire } from 'node:module';
import { idTokenIssuer } from '@pyric/cli/register/internal/supplied-rows';
import { claimNamesOf } from '../account.js';
import type { CallContext, LiveAccount, LiveObserver, ResultReading } from '../observe.js';
import { liveModeMismatch } from '../refusal.js';
import {
  keepShape,
  markAdminMethodGated,
  patchAdminClass,
  type AdminMethod,
  type AdminRow,
} from './patch.js';
import { failClosedGate, UNREAD_APP, type AdminApp, type AdminProjectGate } from './project-gate.js';
import { entryRequire, gatePrototypeMethods, withExportedClass } from './prototype-gate.js';

/** The module an Admin Auth record names, which the page observer maps to the `auth` service. */
export const ADMIN_AUTH_MODULE = 'firebase-admin/auth';

const MAX_UID_LENGTH = 128;
const TENANT_AUTH_PATCHED = Symbol.for('pyric.live.admin.auth.tenantAware');
const EMPTY_LOCAL: ReadonlySet<string> = new Set();
const TENANT_MANAGER_LOCAL: ReadonlySet<string> = new Set(['authForTenant']);

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

/** The Admin app an Auth, TenantAwareAuth, TenantManager, or ProjectConfigManager belongs to. */
function adminAppOf(self: unknown): unknown {
  if (!isObject(self)) return undefined;
  const handler: unknown = Reflect.get(self, 'authRequestHandler');
  const fromHandler: unknown = isObject(handler) ? Reflect.get(handler, 'app') : undefined;
  if (isObject(fromHandler)) return fromHandler;
  const direct: unknown = Reflect.get(self, 'app');
  return isObject(direct) ? direct : undefined;
}

/** The app the gate checks: firebase-admin's own `App`, or `UNREAD_APP` so `failClosedGate` refuses an unreadable receiver. */
function appOf(self: unknown): AdminApp {
  const app = adminAppOf(self);
  const hasOptions = isObject(app) && isObject(Reflect.get(app, 'options'));
  return hasOptions ? (app as AdminApp) : UNREAD_APP;
}

/** The project the app was given, without asking its credential to resolve one. */
function projectIdOf(self: unknown): string | undefined {
  const app = adminAppOf(self);
  const options: unknown = isObject(app) ? Reflect.get(app, 'options') : undefined;
  const projectId: unknown = isObject(options) ? Reflect.get(options, 'projectId') : undefined;
  return typeof projectId === 'string' && projectId !== '' ? projectId : undefined;
}

/** The methods whose first argument is the uid of the one user they act on. */
const TARGET_ARGUMENT: ReadonlySet<string> = new Set([
  'getUser',
  'updateUser',
  'deleteUser',
  'setCustomUserClaims',
  'revokeRefreshTokens',
  'createCustomToken',
]);

/** One call's context: its project, and the account it names so far. */
function contextOf(name: string, args: readonly unknown[], self: unknown): CallContext {
  const target: Target = {};
  const method = name.slice(name.indexOf('.') + 1);
  if (TARGET_ARGUMENT.has(method) && isUid(args[0])) target.uid = args[0];
  if (method === 'verifyIdToken' || method === 'verifySessionCookie') {
    target.claimNames = claimNamesOf(args[0]);
  }
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
  if (target.claimNames === undefined) return { uid: target.uid };
  return { uid: target.uid, claimNames: [...target.claimNames] };
}

const HOOKS = { context: contextOf, accountOf, throwsLocally: true } as const;

function calls(names: readonly string[], extra: Partial<AdminMethod> = {}): AdminMethod[] {
  return names.map((name) => ({ name, ...HOOKS, ...extra }));
}

const METHODS: readonly AdminMethod[] = [
  ...calls([
    'getUser',
    'updateUser',
    'deleteUser',
    'setCustomUserClaims',
    'revokeRefreshTokens',
    'createCustomToken',
    'createSessionCookie',
    'getUsers',
    'listUsers',
    'deleteUsers',
    'importUsers',
    'generatePasswordResetLink',
    'generateEmailVerificationLink',
    'generateVerifyAndChangeEmailLink',
    'generateSignInWithEmailLink',
    'listProviderConfigs',
    'getProviderConfig',
    'deleteProviderConfig',
    'updateProviderConfig',
    'createProviderConfig',
    '_verifyAuthBlockingToken',
  ]),
  ...calls(
    [
      'verifyIdToken',
      'verifySessionCookie',
      'getUserByEmail',
      'getUserByPhoneNumber',
      'getUserByProviderUid',
      'createUser',
    ],
    { resultOf: resultUid },
  ),
];

const TENANT_MANAGER_METHODS: readonly AdminMethod[] = calls([
  'getTenant',
  'listTenants',
  'deleteTenant',
  'createTenant',
  'updateTenant',
]);

const PROJECT_CONFIG_METHODS: readonly AdminMethod[] = calls([
  'getProjectConfig',
  'updateProjectConfig',
]);

/** Where the records go, which gate the calls pass, and the live host's project a mode mismatch names. */
export interface AdminAuthRow {
  readonly observer: LiveObserver;
  readonly gate: AdminProjectGate;
  readonly hostProjectId: string;
}

/** The calls that take a token a page sends: a sandbox-issued one is refused before them. */
const TOKEN_CALLS = ['verifyIdToken', 'verifySessionCookie'] as const;

type Method = (this: unknown, ...args: unknown[]) => unknown;

function refusingSandboxTokens(real: Method, hostProjectId: string): Method {
  const refusing = function verifyToken(this: unknown, ...args: unknown[]): unknown {
    const [token] = args;
    const isSandboxToken = typeof token === 'string' && idTokenIssuer(token) === 'sandbox';
    if (isSandboxToken) return Promise.reject(liveModeMismatch(hostProjectId));
    return Reflect.apply(real, this, args);
  };
  return markAdminMethodGated(keepShape(refusing, real));
}

/** Wraps each token call on `prototype` with the sandbox-token refusal, over the row's own wrapper where it has one. */
function refuseSandboxTokens(prototype: object, hostProjectId: string): void {
  for (const name of TOKEN_CALLS) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value !== 'function') continue;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value: refusingSandboxTokens(descriptor.value as Method, hostProjectId),
    });
  }
}

function resolveAuthRequire(entryFile: string | undefined): ((id: string) => unknown) | undefined {
  try {
    const targetFile = entryFile ?? createRequire(import.meta.url).resolve('firebase-admin/auth');
    return entryRequire(targetFile);
  } catch {
    return undefined;
  }
}

function safeLoadSibling(req: ((id: string) => unknown) | undefined, specifier: string): unknown {
  if (req === undefined) return undefined;
  try {
    return req(specifier);
  } catch {
    return undefined;
  }
}

function patchSubManagers(
  entryFile: string | undefined,
  adminRow: AdminRow,
  hostProjectId: string,
): void {
  const req = resolveAuthRequire(entryFile);
  const tenantMod = safeLoadSibling(req, './tenant-manager');
  withExportedClass(tenantMod, 'TenantAwareAuth', (ctor) => {
    const proto: unknown = Reflect.get(ctor, 'prototype');
    if (!isObject(proto) || Object.hasOwn(proto, TENANT_AUTH_PATCHED)) return;
    gatePrototypeMethods(proto, {
      gate: adminRow.gate,
      appOf,
      allowlist: EMPTY_LOCAL,
      skipWhenObserving: true,
    });
    refuseSandboxTokens(proto, hostProjectId);
    Object.defineProperty(proto, TENANT_AUTH_PATCHED, { value: true });
  });
  withExportedClass(tenantMod, 'TenantManager', (ctor) => {
    const proto: unknown = Reflect.get(ctor, 'prototype');
    const target = isObject(proto) ? proto : undefined;
    if (patchAdminClass(target, 'TenantManager', TENANT_MANAGER_METHODS, adminRow)) {
      gatePrototypeMethods(target, {
        gate: adminRow.gate,
        appOf,
        allowlist: TENANT_MANAGER_LOCAL,
        skipWhenObserving: true,
      });
    }
  });
  const projectConfigMod = safeLoadSibling(req, './project-config-manager');
  withExportedClass(projectConfigMod, 'ProjectConfigManager', (ctor) => {
    const proto: unknown = Reflect.get(ctor, 'prototype');
    const target = isObject(proto) ? proto : undefined;
    if (patchAdminClass(target, 'ProjectConfigManager', PROJECT_CONFIG_METHODS, adminRow)) {
      gatePrototypeMethods(target, {
        gate: adminRow.gate,
        appOf,
        allowlist: EMPTY_LOCAL,
        skipWhenObserving: true,
      });
    }
  });
}

/**
 * Patches `BaseAuth.prototype` and sibling Auth sub-managers once. Later calls
 * change nothing.
 */
export function observeAdminAuth(baseAuth: unknown, row: AdminAuthRow, entryFile?: string): void {
  const defined: unknown = isObject(baseAuth) ? Reflect.get(baseAuth, 'BaseAuth') : undefined;
  const prototype: unknown = typeof defined === 'function' ? Reflect.get(defined, 'prototype') : undefined;
  const gate = failClosedGate(row.gate, 'Auth');
  const adminRow: AdminRow = {
    module: ADMIN_AUTH_MODULE,
    observer: row.observer,
    gate,
    appOf,
  };
  const target = isObject(prototype) ? prototype : undefined;
  const isFirstPatch = patchAdminClass(target, 'Auth', METHODS, adminRow);
  if (isFirstPatch && target !== undefined) {
    gatePrototypeMethods(target, { gate, appOf, allowlist: EMPTY_LOCAL, skipWhenObserving: true });
    refuseSandboxTokens(target, row.hostProjectId);
  }
  patchSubManagers(entryFile, adminRow, row.hostProjectId);
}
