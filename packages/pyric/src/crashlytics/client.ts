/**
 * Sandbox mirror of `firebase/crashlytics` (`@firebase/crashlytics@0.2.0` /
 * `firebase@13.4.0` public preview).
 *
 * All telemetry stays strictly local inside the per-sandbox `CrashlyticsBroker`
 * (or the SharedWorker / `HostedRuntime` transport registered for served pages).
 * Off-machine `endpointUrl` values are refused before any network request can leave.
 */
import '../app/runtime.js';
import type { FirebaseApp } from '../app/types.js';
import { getClock } from '../sandbox/clock.js';
import { defaultClientApp, resolveClientApp } from '../sandbox/internal/client-app.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import type { Sandbox, SandboxContext } from '../sandbox/index.js';
import { SandboxContextImpl } from '../sandbox/index.js';
import { getCrashlyticsBroker, MAX_CRASHLYTICS_LOGS } from './broker.js';
import {
  attachPageLifecycleListeners,
  attachUnhandledErrorListeners,
  markErrorAsLogged,
  pushBoundedBreadcrumb,
  type BrowserCrashlyticsHooks,
} from './browser-listeners.js';
import {
  appKeyOf,
  areCrashlyticsOptionsEqual,
  normalizeCrashlyticsAttributes,
  normalizeThrownError,
  snapshotCrashlyticsOptions,
  validateCrashlyticsEndpointUrl,
} from './normalize.js';
import type {
  Attributes,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsBreadcrumb,
  CrashlyticsFeature,
  CrashlyticsLogInput,
  CrashlyticsOptions,
  CrashlyticsRecordErrorInput,
  PlainCrashlyticsValue,
} from './types.js';

export {
  areCrashlyticsOptionsEqual,
  normalizeCrashlyticsAttributes,
  normalizeThrownError,
  validateCrashlyticsEndpointUrl,
};

const BREADCRUMBS_FEATURE_TAG = Symbol('pyric.crashlytics.breadcrumbs');
const CRASHLYTICS_HANDLE_TAG = Symbol('pyric.crashlytics.handle');

/** Transport abstraction allowing served SharedWorker entries to forward Crashlytics ops to the host. */
export interface CrashlyticsClientTransport {
  log(input: CrashlyticsLogInput): Promise<void>;
  recordError(input: CrashlyticsRecordErrorInput): Promise<void>;
  flush(): Promise<void>;
}

interface CrashlyticsInstanceState {
  readonly app: FirebaseApp;
  readonly appId: string;
  readonly region: string;
  readonly appVersion: string | null;
  readonly configuredOptions: Record<string, unknown>;
  readonly baseAttributes: Record<string, PlainCrashlyticsValue>;
  readonly breadcrumbsEnabled: boolean;
  readonly breadcrumbsBuffer: CrashlyticsBreadcrumb[];
  readonly pendingWork: Set<Promise<void>>;
  now: () => number;
  transport: CrashlyticsClientTransport;
  deleted: boolean;
}

interface InternalCrashlyticsHandle extends Crashlytics {
  readonly [CRASHLYTICS_HANDLE_TAG]: CrashlyticsInstanceState;
}

const handlesByApp = new WeakMap<FirebaseApp, InternalCrashlyticsHandle>();
const handlesBySandbox = new WeakMap<Sandbox, InternalCrashlyticsHandle>();

function isSandboxContext(value: unknown): value is SandboxContext {
  return value instanceof SandboxContextImpl;
}

function isSandbox(value: unknown): value is Sandbox {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.withAuth === 'function' &&
    typeof record.onCurrentUserChanged === 'function' &&
    'currentUser' in record &&
    'admin' in record
  );
}

function isBreadcrumbsFeature(feature: unknown): boolean {
  if (typeof feature !== 'object' || feature === null) {
    return false;
  }
  if (BREADCRUMBS_FEATURE_TAG in feature) {
    return true;
  }
  return (feature as { name?: unknown }).name === 'breadcrumbs';
}

function appendBreadcrumb(
  state: CrashlyticsInstanceState,
  message: string,
  attributes?: Record<string, PlainCrashlyticsValue>,
): void {
  const crumb: CrashlyticsBreadcrumb = {
    message,
    timestampMs: state.now(),
  };
  if (attributes !== undefined && Object.keys(attributes).length > 0) {
    crumb.attributes = attributes;
  }
  pushBoundedBreadcrumb(state.breadcrumbsBuffer, crumb, MAX_CRASHLYTICS_LOGS);
}

function requireCrashlyticsState(crashlytics: Crashlytics, callerName: string): CrashlyticsInstanceState {
  if (
    typeof crashlytics !== 'object' ||
    crashlytics === null ||
    !(CRASHLYTICS_HANDLE_TAG in crashlytics)
  ) {
    throw new FirebaseError(
      'crashlytics/invalid-argument',
      `Crashlytics: First argument to ${callerName}() must be a Crashlytics instance from getCrashlytics().`,
    );
  }
  return (crashlytics as InternalCrashlyticsHandle)[CRASHLYTICS_HANDLE_TAG];
}

/**
 * Verifies that repeat `getCrashlytics(app, options)` calls pass options matching
 * the initial `CrashlyticsOptions`, throwing the same error as `@firebase/crashlytics`
 * when they differ.
 */
export function assertMatchingCrashlyticsOptions(
  crashlytics: Crashlytics,
  options?: CrashlyticsOptions,
): void {
  const state = requireCrashlyticsState(crashlytics, 'getCrashlytics');
  if (!areCrashlyticsOptionsEqual(options, state.configuredOptions)) {
    throw new Error('getCrashlytics() cannot be called with different options');
  }
}

function trackPending(state: CrashlyticsInstanceState, work: Promise<void>): void {
  const guarded = work.catch(() => undefined).finally(() => {
    state.pendingWork.delete(guarded);
  });
  state.pendingWork.add(guarded);
}

function createBrokerTransport(sandbox: Sandbox, appId: string): CrashlyticsClientTransport {
  const broker = getCrashlyticsBroker(sandbox);
  return {
    async log(input) {
      broker.log({ ...input, appId });
    },
    async recordError(input) {
      broker.recordError({ ...input, appId });
    },
    async flush() {
      broker.flush(appId);
    },
  };
}

function enqueueRecordError(
  state: CrashlyticsInstanceState,
  error: unknown,
  attributes: CrashlyticsAttributes | undefined,
  fatal: boolean,
): void {
  const normalizedErr = normalizeThrownError(error);
  const mergedAttributes: Record<string, PlainCrashlyticsValue> = {
    ...state.baseAttributes,
    ...normalizeCrashlyticsAttributes(attributes),
  };
  const timestampMs = state.now();
  let breadcrumbsSnapshot: CrashlyticsBreadcrumb[] = [];
  if (state.breadcrumbsEnabled) {
    breadcrumbsSnapshot = state.breadcrumbsBuffer.map((crumb) => {
      const copy: CrashlyticsBreadcrumb = {
        message: crumb.message,
        timestampMs: crumb.timestampMs,
      };
      if (crumb.attributes !== undefined) {
        copy.attributes = { ...crumb.attributes };
      }
      return copy;
    });
    state.breadcrumbsBuffer.length = 0;
  }

  const payload: CrashlyticsRecordErrorInput = {
    appId: state.appId,
    name: normalizedErr.name,
    message: normalizedErr.message,
    stack: normalizedErr.stack,
    code: normalizedErr.code,
    cause: normalizedErr.cause,
    fatal,
    attributes: mergedAttributes,
    breadcrumbs: breadcrumbsSnapshot,
    timestampMs,
    appVersion: state.appVersion,
    region: state.region,
    sdkPlatform: 'web',
  };
  trackPending(state, state.transport.recordError(payload));
}

/**
 * Enables Crashlytics breadcrumb collection when passed in `CrashlyticsOptions.features`.
 */
export function breadcrumbs(): CrashlyticsFeature {
  const feature: Record<string, unknown> = { name: 'breadcrumbs' };
  Object.defineProperty(feature, BREADCRUMBS_FEATURE_TAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(feature);
}

/**
 * Creates a standalone `Crashlytics` handle backed by a custom transport
 * (used by `@pyric/cli`'s served SharedWorker / `HostedRuntime` client entry).
 */
export function createTransportCrashlytics(
  app: FirebaseApp,
  transport: CrashlyticsClientTransport,
  options?: CrashlyticsOptions,
  registerCleanup?: (cleanup: () => void) => void,
  now?: () => number,
): Crashlytics {
  validateCrashlyticsEndpointUrl(options?.endpointUrl);
  const appId = appKeyOf(app);
  let region = 'global';
  if (typeof options?.region === 'string' && options.region.length > 0) {
    region = options.region;
  }
  let appVersion: string | null = null;
  if (typeof options?.appVersion === 'string' && options.appVersion.length > 0) {
    appVersion = options.appVersion;
  }
  const breadcrumbsEnabled =
    Array.isArray(options?.features) && options.features.some(isBreadcrumbsFeature);

  const state: CrashlyticsInstanceState = {
    app,
    appId,
    region,
    appVersion,
    configuredOptions: snapshotCrashlyticsOptions(options),
    baseAttributes: normalizeCrashlyticsAttributes(options?.customAttributes),
    breadcrumbsEnabled,
    breadcrumbsBuffer: [],
    pendingWork: new Set<Promise<void>>(),
    now: now ?? (() => Date.now()),
    transport,
    deleted: false,
  };

  const handle: InternalCrashlyticsHandle = {
    app,
    [CRASHLYTICS_HANDLE_TAG]: state,
  };

  const hooks: BrowserCrashlyticsHooks = {
    isDeleted: () => state.deleted,
    breadcrumbsEnabled,
    appendBreadcrumb: (message, attrs) => {
      appendBreadcrumb(state, message, attrs);
    },
    recordUnhandledError: (error) => {
      enqueueRecordError(state, error, undefined, true);
    },
    flushOnHide: () => {
      void flush(handle);
    },
  };

  let detachUnhandled = (): void => {};
  if (options?.captureUnhandledErrors !== false) {
    detachUnhandled = attachUnhandledErrorListeners(hooks);
  }
  const detachLifecycle = attachPageLifecycleListeners(hooks);

  if (registerCleanup !== undefined) {
    registerCleanup(() => {
      state.deleted = true;
      state.breadcrumbsBuffer.length = 0;
      detachUnhandled();
      detachLifecycle();
    });
  }

  return handle;
}

/**
 * Replaces the backing transport on an existing `Crashlytics` handle.
 */
export function registerCrashlyticsTransport(
  crashlytics: Crashlytics,
  transport: CrashlyticsClientTransport,
): void {
  const state = requireCrashlyticsState(crashlytics, 'registerCrashlyticsTransport');
  if (state.deleted) {
    throw new FirebaseError(
      'app/app-deleted',
      `Firebase: Firebase App named '${state.app.name}' already deleted (app/app-deleted).`,
    );
  }
  state.transport = transport;
}

/**
 * Returns the default `Crashlytics` instance associated with `app` (or the
 * default `FirebaseApp` when `app` is omitted).
 */
export function getCrashlytics(
  app?: FirebaseApp | Sandbox | SandboxContext,
  options?: CrashlyticsOptions,
): Crashlytics {
  validateCrashlyticsEndpointUrl(options?.endpointUrl);

  const target = app ?? (defaultClientApp() as FirebaseApp);
  if (isSandbox(target) || isSandboxContext(target)) {
    let sandbox: Sandbox;
    if (isSandboxContext(target)) {
      sandbox = target.sandbox;
    } else {
      sandbox = target;
    }
    const existingBySandbox = handlesBySandbox.get(sandbox);
    if (existingBySandbox !== undefined && !existingBySandbox[CRASHLYTICS_HANDLE_TAG].deleted) {
      assertMatchingCrashlyticsOptions(existingBySandbox, options);
      return existingBySandbox;
    }
    const syntheticApp: FirebaseApp = {
      name: '[DEFAULT]',
      options: {},
      automaticDataCollectionEnabled: true,
    };
    const handle = createTransportCrashlytics(
      syntheticApp,
      createBrokerTransport(sandbox, 'default'),
      options,
      undefined,
      () => getClock(sandbox).now(),
    ) as InternalCrashlyticsHandle;
    handlesBySandbox.set(sandbox, handle);
    return handle;
  }

  const clientApp = target as FirebaseApp;
  const runtime = resolveClientApp(clientApp);
  if (!runtime) {
    throw new TypeError('pyric/crashlytics: unrecognized FirebaseApp handle');
  }
  runtime.assertAlive();

  const existing = handlesByApp.get(clientApp);
  if (existing !== undefined && !existing[CRASHLYTICS_HANDLE_TAG].deleted) {
    assertMatchingCrashlyticsOptions(existing, options);
    return existing;
  }

  const appId = appKeyOf(clientApp);
  const handle = createTransportCrashlytics(
    clientApp,
    createBrokerTransport(runtime.sandbox, appId),
    options,
    (cleanup) => {
      runtime.onDelete(() => {
        handlesByApp.delete(clientApp);
        cleanup();
      });
    },
    () => getClock(runtime.sandbox).now(),
  ) as InternalCrashlyticsHandle;
  handlesByApp.set(clientApp, handle);
  return handle;
}

/**
 * Queues a log message (and optional structured attributes) for Crashlytics.
 */
export function log(
  crashlytics: Crashlytics,
  message: string,
  attributes?: Attributes,
): void {
  const state = requireCrashlyticsState(crashlytics, 'log');
  if (state.deleted) {
    return;
  }
  const mergedAttributes: Record<string, PlainCrashlyticsValue> = {
    ...state.baseAttributes,
    ...normalizeCrashlyticsAttributes(attributes),
  };
  const timestampMs = state.now();
  const hasAttrs = Object.keys(mergedAttributes).length > 0;

  if (state.breadcrumbsEnabled) {
    let crumbAttributes: Record<string, PlainCrashlyticsValue> | undefined;
    if (hasAttrs) {
      crumbAttributes = mergedAttributes;
    }
    appendBreadcrumb(state, message, crumbAttributes);
  }

  const logInput: CrashlyticsLogInput = {
    appId: state.appId,
    message,
    timestampMs,
  };
  if (hasAttrs) {
    logInput.attributes = mergedAttributes;
  }
  trackPending(state, state.transport.log(logInput));
}

/**
 * Queues an error (and optional structured attributes) to be recorded by Crashlytics.
 */
export function recordError(
  crashlytics: Crashlytics,
  error: unknown,
  attributes?: Attributes,
): void {
  const state = requireCrashlyticsState(crashlytics, 'recordError');
  if (state.deleted) {
    return;
  }
  markErrorAsLogged(error);
  enqueueRecordError(state, error, attributes, false);
}

/**
 * Immediately flushes all enqueued Crashlytics logs and error reports.
 */
export async function flush(crashlytics: Crashlytics): Promise<void> {
  const state = requireCrashlyticsState(crashlytics, 'flush');
  if (state.deleted) {
    return;
  }
  while (state.pendingWork.size > 0) {
    await Promise.all([...state.pendingWork]);
  }
  await state.transport.flush();
}
