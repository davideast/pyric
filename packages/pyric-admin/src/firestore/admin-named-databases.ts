/**
 * Named Firestore database resolution, local/remote handle scoping, undeclared
 * database C3 `NOT_FOUND` enforcement, worker protocol v1 refusal, and C4
 * cross-database mismatch validation for `pyric-admin/firestore` (ADR-0021).
 */

import { FirebaseError } from 'pyric/app';
import {
  declareFirestoreDatabase,
  getDatabaseEnv,
  isFirestoreDatabaseDeclared,
} from 'pyric/firestore/internal';
import {
  isRemoteSandbox,
  REMOTE_SANDBOX,
  SandboxContextImpl,
  SandboxError,
  type AuthState,
  type RemoteSandbox,
  type RemoteSandboxChannel,
  type Sandbox,
  type SandboxContext,
} from 'pyric/sandbox';
import {
  bindOperationContext,
  getInternalEnv,
  LocalEnvironment,
} from 'pyric/sandbox/internal';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import { createAdminGrpcError, createPrefixedAdminGrpcError } from './admin-grpc-errors.js';
import { GrpcStatus } from './admin-grpc-log.js';
import {
  adminRawDbSandbox,
  DEFAULT_ADMIN_DATABASE_ID,
  getAdminHandleDatabaseId,
  getAdminHandleProjectId,
  isAppBackedRoot,
} from './admin-handle-registry.js';

export { assertSameDatabaseTarget, hasCrossDatabaseMismatch } from './admin-snapshot-named-db.js';

const SANDBOX_ENV_SYMBOL = Symbol.for('pyric.sandbox.internalEnv');
const MIN_NAMED_DB_WORKER_PROTOCOL = 2;
const REMOTE_PROTOCOL_PROBE_TIMEOUT_MS = 2000;
const CLI_UPGRADE_VERSION = '0.1.0-alpha.35';
const MAX_WIRE_DATABASE_ID_LENGTH = 256;

const UNDECLARED_PLACEHOLDER_ENV = new LocalEnvironment();

export function isBoundToUndeclaredPlaceholderEnv(rawTarget: object): boolean {
  const candidate = rawTarget as { env?: unknown };
  return candidate.env === UNDECLARED_PLACEHOLDER_ENV;
}

const remoteProtocolVersionCache = new WeakMap<RemoteSandbox, Promise<number>>();
const rootOriginalSandbox = new WeakMap<object, Sandbox>();

export function declareAdminSandboxDatabase(sandbox: Sandbox, databaseId: string): void {
  if (databaseId === DEFAULT_ADMIN_DATABASE_ID) {
    return;
  }
  declareFirestoreDatabase(sandbox, databaseId);
}

export function isAdminSandboxDatabaseDeclared(sandbox: Sandbox, databaseId: string): boolean {
  if (databaseId === DEFAULT_ADMIN_DATABASE_ID) {
    return true;
  }
  return isFirestoreDatabaseDeclared(sandbox, databaseId);
}

export function resolveAdminSandboxDatabaseEnv(
  sandbox: Sandbox,
  databaseId: string,
): LocalEnvironment {
  if (databaseId === DEFAULT_ADMIN_DATABASE_ID) {
    return getInternalEnv(sandbox);
  }
  return getDatabaseEnv(sandbox, databaseId);
}

export function resolveOptionalAdminDatabaseId(databaseId: unknown): string {
  if (!databaseId) {
    return DEFAULT_ADMIN_DATABASE_ID;
  }
  if (typeof databaseId !== 'string') {
    throw createAdminGrpcError(
      GrpcStatus.INVALID_ARGUMENT as number,
      'Value for argument "settings.databaseId" is not a valid string.',
    );
  }
  return databaseId;
}

export function isCalledFromLegacyRootAdminNamespace(receiver: unknown): boolean {
  // `packages/pyric-admin/src/admin.ts` invokes `firestoreModule.getFirestore(app)`
  // on an ES module namespace object (`[object Module]`). Checking `receiver`
  // survives JavaScriptCore's proper tail-call optimization in Bun as well as V8.
  if (
    typeof receiver === 'object' &&
    receiver !== null &&
    Object.prototype.toString.call(receiver) === '[object Module]'
  ) {
    return true;
  }
  const stack = new Error().stack;
  if (typeof stack !== 'string') {
    return false;
  }
  const frames = stack.split('\n');
  for (let i = 1; i < Math.min(frames.length, 5); i += 1) {
    const line = frames[i] ?? '';
    if (/pyric-admin\/(?:src|dist)\/admin\.[tj]s\b/.test(line)) {
      return true;
    }
  }
  return false;
}

function formatMissingDatabaseDetails(databaseId: string, projectId: string): string {
  return (
    `The database ${databaseId} does not exist for project ${projectId} ` +
    `Please visit https://console.cloud.google.com/datastore/setup?project=${projectId} ` +
    'to add a Cloud Datastore or Cloud Firestore database. '
  );
}

export function recordAdminRootOriginalSandbox(rootOrRawDb: object, sandbox: Sandbox | undefined): void {
  if (sandbox !== undefined) {
    rootOriginalSandbox.set(rootOrRawDb, sandbox);
  }
}

export function getAdminRootOriginalSandbox(rootOrRawDb: object): Sandbox | undefined {
  return rootOriginalSandbox.get(rootOrRawDb);
}

export function assertAdminRootDatabaseDeclared(rootDb: SandboxFirestore): void {
  const databaseId = getAdminHandleDatabaseId(rootDb);
  if (databaseId === DEFAULT_ADMIN_DATABASE_ID) {
    return;
  }
  let sandbox = rootOriginalSandbox.get(rootDb);
  if (sandbox === undefined) {
    sandbox = adminRawDbSandbox.get(rootDb);
  }
  if (sandbox === undefined || isRemoteSandbox(sandbox)) {
    return;
  }
  if (isAdminSandboxDatabaseDeclared(sandbox, databaseId)) {
    return;
  }
  const projectId = getAdminHandleProjectId(rootDb);
  const details = formatMissingDatabaseDetails(databaseId, projectId);
  if (isAppBackedRoot(rootDb)) {
    throw createPrefixedAdminGrpcError(GrpcStatus.NOT_FOUND as number, 'NOT_FOUND', details);
  }
  throw new SandboxError('not-found', details);
}

function extractWorkerProtocolVersion(res: unknown): number | undefined {
  if (res !== null && typeof res === 'object') {
    const version = (res as { workerProtocol?: unknown }).workerProtocol;
    if (typeof version === 'number' && Number.isFinite(version)) {
      return version;
    }
  }
  return undefined;
}

async function queryRemoteWorkerProtocol(remoteSandbox: RemoteSandbox): Promise<number> {
  try {
    const epochRes = await remoteSandbox.channel.op({ method: 'getRuntimeEpoch' });
    const fromEpoch = extractWorkerProtocolVersion(epochRes);
    if (fromEpoch !== undefined) {
      return fromEpoch;
    }
  } catch {
    // Fall back to `getVersion` when `getRuntimeEpoch` is rejected by a stub or older peer.
  }
  try {
    const versionRes = await remoteSandbox.channel.op({ method: 'getVersion' });
    const fromVersion = extractWorkerProtocolVersion(versionRes);
    if (fromVersion !== undefined) {
      return fromVersion;
    }
  } catch {
    return 1;
  }
  return 1;
}

function probeRemoteWorkerProtocol(remoteSandbox: RemoteSandbox): Promise<number> {
  const existing = remoteProtocolVersionCache.get(remoteSandbox);
  if (existing !== undefined) {
    return existing;
  }
  const pending = new Promise<number>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(1);
      }
    }, REMOTE_PROTOCOL_PROBE_TIMEOUT_MS);
    timer.unref?.();
    void queryRemoteWorkerProtocol(remoteSandbox).then((version) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(version);
      }
    });
  });
  remoteProtocolVersionCache.set(remoteSandbox, pending);
  return pending;
}

function buildProtocolOneRefusal(serveUrl: string, databaseId: string): FirebaseError {
  return new FirebaseError(
    'failed-precondition',
    `pyric: the host at ${serveUrl} speaks worker protocol 1, which has no Firestore database ids. ` +
      `Restart it with @pyric/cli ${CLI_UPGRADE_VERSION} or later to use getFirestore(app, "${databaseId}").`,
  );
}

function rewriteRemoteMissingDatabaseError(
  err: unknown,
  databaseId: string,
  projectId: string,
): unknown {
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (
      typeof message === 'string' &&
      message.startsWith('The database ') &&
      message.includes(' does not exist for project ')
    ) {
      return new SandboxError('not-found', formatMissingDatabaseDetails(databaseId, projectId));
    }
  }
  return err;
}

export function createDatabaseScopedSandbox(
  sandbox: Sandbox,
  databaseId: string,
  projectId?: string,
): Sandbox {
  if (databaseId === DEFAULT_ADMIN_DATABASE_ID) {
    return sandbox;
  }
  let effectiveProjectId = 'pyric-sandbox';
  if (typeof projectId === 'string' && projectId.length > 0) {
    effectiveProjectId = projectId;
  }
  if (isRemoteSandbox(sandbox)) {
    const channel: RemoteSandboxChannel = {
      async op(opPayload: { method: string } & Record<string, unknown>): Promise<unknown> {
        if (opPayload.method === 'getVersion' || opPayload.method === 'getRuntimeEpoch') {
          return sandbox.channel.op(opPayload);
        }
        const protocol = await probeRemoteWorkerProtocol(sandbox);
        if (protocol < MIN_NAMED_DB_WORKER_PROTOCOL) {
          throw buildProtocolOneRefusal(sandbox.serveUrl, databaseId);
        }
        if (databaseId.length > MAX_WIRE_DATABASE_ID_LENGTH) {
          throw new SandboxError(
            'not-found',
            formatMissingDatabaseDetails(databaseId, effectiveProjectId),
          );
        }
        const scopedOp: { method: string } & Record<string, unknown> = {
          ...opPayload,
          databaseId,
        };
        try {
          return await sandbox.channel.op(scopedOp);
        } catch (err) {
          throw rewriteRemoteMissingDatabaseError(err, databaseId, effectiveProjectId);
        }
      },
      subscribe(sub, onSnap, onError) {
        let activeUnsub: (() => void) | null = null;
        let cancelled = false;
        void probeRemoteWorkerProtocol(sandbox).then((protocol) => {
          if (cancelled) {
            return;
          }
          if (protocol < MIN_NAMED_DB_WORKER_PROTOCOL) {
            if (onError !== undefined) {
              const refusal = buildProtocolOneRefusal(sandbox.serveUrl, databaseId);
              onError(refusal as Error & { code: string });
            }
            return;
          }
          if (databaseId.length > MAX_WIRE_DATABASE_ID_LENGTH) {
            if (onError !== undefined) {
              const missingErr = new SandboxError(
                'not-found',
                formatMissingDatabaseDetails(databaseId, effectiveProjectId),
              );
              onError(missingErr as Error & { code: string });
            }
            return;
          }
          let nextTarget: unknown = sub.target;
          if (sub.target !== null && typeof sub.target === 'object') {
            nextTarget = { ...(sub.target as Record<string, unknown>), databaseId };
          }
          const wrappedOnSnap = (snap: unknown) => {
            if (!cancelled) {
              onSnap(snap);
            }
          };
          let wrappedOnError = onError;
          if (onError !== undefined) {
            wrappedOnError = (err) => {
              if (cancelled) {
                return;
              }
              onError(
                rewriteRemoteMissingDatabaseError(
                  err,
                  databaseId,
                  effectiveProjectId,
                ) as Error & { code: string },
              );
            };
          }
          activeUnsub = sandbox.channel.subscribe(
            { ...sub, target: nextTarget },
            wrappedOnSnap,
            wrappedOnError,
          );
        });
        return () => {
          cancelled = true;
          if (activeUnsub !== null) {
            activeUnsub();
          }
        };
      },
    };
    if (typeof sandbox.channel.byteRoute === 'function') {
      channel.byteRoute = () => sandbox.channel.byteRoute!();
    }
    const remoteWrapper = Object.create(sandbox) as RemoteSandbox;
    Object.defineProperties(remoteWrapper, {
      [REMOTE_SANDBOX]: {
        value: true,
        enumerable: true,
        configurable: true,
      },
      serveUrl: {
        get(): string {
          return sandbox.serveUrl;
        },
        enumerable: true,
        configurable: true,
      },
      channel: {
        value: channel,
        enumerable: true,
        configurable: true,
      },
      withAuth: {
        value(auth: AuthState): SandboxContext {
          return new SandboxContextImpl(remoteWrapper, auth);
        },
        enumerable: true,
        configurable: true,
      },
    });
    return remoteWrapper;
  }

  const readEnv = (): LocalEnvironment => {
    if (!isAdminSandboxDatabaseDeclared(sandbox, databaseId)) {
      return UNDECLARED_PLACEHOLDER_ENV;
    }
    return resolveAdminSandboxDatabaseEnv(sandbox, databaseId);
  };

  const localWrapper: Sandbox = {
    get currentUser() {
      return sandbox.currentUser;
    },
    set currentUser(user: AuthState) {
      sandbox.currentUser = user;
    },
    get admin() {
      return sandbox.admin;
    },
    withAuth(auth: AuthState): SandboxContext {
      return new SandboxContextImpl(localWrapper, auth);
    },
    onCurrentUserChanged(cb) {
      return sandbox.onCurrentUserChanged(cb);
    },
    onEvent(cb) {
      return sandbox.onEvent(cb);
    },
    enableTabSync(opts) {
      return sandbox.enableTabSync(opts);
    },
    enablePersistence(opts) {
      return sandbox.enablePersistence(opts);
    },
    clearPersistence() {
      return sandbox.clearPersistence();
    },
    flush() {
      return sandbox.flush();
    },
    registerPersistableService(name, hooks) {
      return sandbox.registerPersistableService(name, hooks);
    },
    snapshot() {
      return sandbox.snapshot();
    },
    loadSnapshot(data) {
      sandbox.loadSnapshot(data);
    },
    history() {
      return sandbox.history();
    },
    reset() {
      sandbox.reset();
    },
    resetAll() {
      return sandbox.resetAll();
    },
    dispose() {
      sandbox.dispose();
    },
  };
  if (typeof sandbox.runWithProvenance === 'function') {
    localWrapper.runWithProvenance = <T>(
      provenance: Parameters<NonNullable<Sandbox['runWithProvenance']>>[0],
      fn: () => T,
    ): T => sandbox.runWithProvenance!(provenance, fn);
  }
  Object.defineProperty(localWrapper, SANDBOX_ENV_SYMBOL, {
    value: readEnv,
    enumerable: false,
  });
  return localWrapper;
}

export function createDatabaseScopedContext(
  ctx: SandboxContext,
  databaseId: string,
  projectId?: string,
): SandboxContext {
  if (databaseId === DEFAULT_ADMIN_DATABASE_ID) {
    return ctx;
  }
  const scopedSandbox = createDatabaseScopedSandbox(ctx.sandbox, databaseId, projectId);
  const baseScoped = scopedSandbox.withAuth(ctx.auth);
  let opCtx: Parameters<typeof bindOperationContext>[1];
  if (ctx.operationContext.planId !== undefined) {
    opCtx = {
      source: ctx.operationContext.source,
      authLens: ctx.operationContext.authLens,
      planId: ctx.operationContext.planId,
    };
  } else {
    opCtx = {
      source: ctx.operationContext.source,
      authLens: ctx.operationContext.authLens,
    };
  }
  return bindOperationContext(baseScoped, opCtx);
}
