/**
 * Per-app App Check state: the activation options, the cached token, and the
 * token listeners. Keyed by the app object, as upstream keys it.
 *
 * Where a token comes from follows upstream `getToken`: with no debug token
 * set, a `CustomProvider` is called and its token is used as given, so AI
 * Logic's gate judges it (#1642). Under a debug token, and for the reCAPTCHA
 * providers the sandbox cannot run, the sandbox mints its own token.
 */
import type { FirebaseApp } from '../app/types.js';
import { SANDBOX_CLOCK, type SandboxClock } from '../sandbox/clock.js';
import { isRemoteSandbox } from '../sandbox/remote.js';
import { resolveClientAppIncludingDeleted } from '../sandbox/internal/client-app.js';
import {
  APP_CHECK_PLACEHOLDER_TOKEN,
  mintAppCheckToken,
  type MintedAppCheckToken as MintedToken,
} from '../sandbox/internal/app-check-token.js';
import { appCheckActivationOf, recordAppCheckActivation } from '../sandbox/internal/app-check-activation.js';
import { warnIfProductionNeverSettles } from './never-settles-warning.js';
import { CustomProvider, type AppCheckProvider } from './providers.js';
import {
  bindSandboxClockSubscriber,
  computeNextRefreshDelayMillis,
  issuedAtTimeMillisOf,
  TokenRefresher,
  type TimedAppCheckToken,
} from './refresher.js';

/** Web App Check tokens live one hour (capture `app-check-client-debug-get-token`). */
const TTL_SECONDS = 3600;
/** Production's limited-use TTL, fixed at 5 minutes (capture `app-check-client-limited-use-token`). */
const LIMITED_USE_TTL_SECONDS = 300;

export interface AppCheckTokenResult {
  readonly token: string;
}

/** Internal token exchange outcome mirroring `@firebase/app-check` 0.13.1 `AppCheckTokenResult`. */
interface InternalTokenResult {
  readonly token: string;
  readonly error?: Error;
  readonly internalError?: Error;
}

type ListenerKind = 'external' | 'internal';

export interface TokenObserver {
  next: (result: AppCheckTokenResult) => void;
  error?: (error: Error) => void;
  complete?: () => void;
  kind?: ListenerKind;
}

export interface AppCheckState {
  provider: AppCheckProvider;
  /** The raw option `initializeAppCheck` was called with, `undefined` included; a later call is compared with this. */
  readonly initialAutoRefresh: boolean | undefined;
  isTokenAutoRefreshEnabled: boolean;
  cached: TimedAppCheckToken | null;
  /** The one mint in flight for this app; concurrent `getToken` calls share it, as upstream shares `exchangeTokenPromise`. */
  inFlight: Promise<TimedAppCheckToken> | null;
  observers: Set<TokenObserver>;
  refresher: TokenRefresher | null;
  /** The `CustomProvider` this app's tokens come from, or `null` when the sandbox mints them. */
  readonly attestedBy: CustomProvider | null;
  /** Whether the debug token was set when this app's App Check was initialized. */
  readonly debugMode: boolean;
  /** App identity snapshotted at activation so cold post-delete token mints do not read `deletedApp.options`. */
  readonly identity: { readonly appId: string; readonly projectId: string };
}

/** The activation lookup is shared with `pyric/ai`, which reads it when `getAI(app)` builds a handle. */
export function stateOf(app: FirebaseApp): AppCheckState | undefined {
  return appCheckActivationOf<AppCheckState>(app)?.state;
}

function record(app: FirebaseApp, state: AppCheckState): void {
  recordAppCheckActivation(app, {
    state,
    token: () => tokenForService(app, state),
    limitedUseToken: async () => (await mintLimitedUse(app, state)).token,
  });
}

const BLOCKED_REFRESH_WARNING =
  '`isTokenAutoRefreshEnabled` is true but `automaticDataCollectionEnabled` was set to false during `initializeApp()`. This blocks automatic token refresh.';

/** Asserts that an app registered through `createAppForSandbox` or `initializeApp` has not been deleted. */
export function assertAppAlive(app: FirebaseApp): void {
  const runtime = resolveClientAppIncludingDeleted(app);
  if (runtime !== undefined) {
    runtime.assertAlive();
  }
}

/** Upstream `_activate`: always reads `app.automaticDataCollectionEnabled` (throwing `app/app-deleted` if deleted). */
function effectiveAutoRefresh(app: FirebaseApp, requested: boolean | undefined): boolean {
  assertAppAlive(app);
  const automaticDataCollectionEnabled = app.automaticDataCollectionEnabled;
  const wanted = requested === true;
  if (!automaticDataCollectionEnabled && wanted) {
    console.warn(BLOCKED_REFRESH_WARNING);
  }
  return wanted && automaticDataCollectionEnabled;
}

/**
 * Upstream `initializeDebugMode`: debug mode is on when the global
 * `FIREBASE_APPCHECK_DEBUG_TOKEN` is `true` or a string. Upstream reads it at
 * the first `initializeAppCheck` in the page or process; the sandbox reads it
 * at each one, which differs only when the global changes between two apps.
 */
function isDebugTokenSet(): boolean {
  const value = (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN;
  return value === true || typeof value === 'string';
}

function attestationProvider(provider: AppCheckProvider, debugMode: boolean): CustomProvider | null {
  const callsProvider = provider instanceof CustomProvider && !debugMode;
  return callsProvider ? provider : null;
}

function clockOf(app: FirebaseApp): SandboxClock | null {
  const runtime = resolveClientAppIncludingDeleted(app);
  if (runtime === undefined) return null;
  if (isRemoteSandbox(runtime.sandbox)) return null;
  const carried = (runtime.sandbox as Partial<Record<typeof SANDBOX_CLOCK, SandboxClock>>)[SANDBOX_CLOCK];
  if (carried === undefined) return null;
  return carried;
}

function clockNow(app: FirebaseApp): number {
  const clock = clockOf(app);
  if (clock !== null) return clock.now();
  return Date.now();
}

export function activate(app: FirebaseApp, provider: AppCheckProvider, isTokenAutoRefreshEnabled: boolean | undefined): AppCheckState {
  const debugMode = isDebugTokenSet();
  const state: AppCheckState = {
    provider,
    initialAutoRefresh: isTokenAutoRefreshEnabled,
    isTokenAutoRefreshEnabled: effectiveAutoRefresh(app, isTokenAutoRefreshEnabled),
    cached: null,
    inFlight: null,
    observers: new Set(),
    refresher: null,
    attestedBy: attestationProvider(provider, debugMode),
    debugMode,
    identity: identityOf(app),
  };
  const runtime = resolveClientAppIncludingDeleted(app);
  if (runtime !== undefined) {
    runtime.onDelete(() => {
      stopAutoRefreshOnDelete(state);
    });
  }
  record(app, state);
  return state;
}

function stopAutoRefreshOnDelete(state: AppCheckState): void {
  state.observers.clear();
  if (state.refresher !== null) {
    state.refresher.stop();
  }
}

function identityOf(app: FirebaseApp): { readonly appId: string; readonly projectId: string } {
  const options = app.options as { appId?: string; projectId?: string };
  let appId = '';
  if (typeof options.appId === 'string') {
    appId = options.appId;
  }
  let projectId = '';
  if (typeof options.projectId === 'string') {
    projectId = options.projectId;
  }
  return { appId, projectId };
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** Delivers an exchange result to observers off the caller's stack, swallowing listener throws (#1909). */
function notifyTokenListeners(observers: Iterable<TokenObserver>, result: InternalTokenResult): void {
  const snapshot = [...observers];
  const hasError = 'error' in result;
  for (const observer of snapshot) {
    const sendToErrorHandler = observer.kind !== 'internal' && hasError;
    if (sendToErrorHandler) {
      const onError = observer.error;
      if (onError === undefined) continue;
      const tokenError = result.error as Error;
      queueMicrotask(() => {
        try {
          onError(tokenError);
        } catch (listenerError) {
          // Matches @firebase/app-check: errors thrown inside listener callbacks are ignored (#1909).
          void listenerError;
        }
      });
      continue;
    }
    const onNext = observer.next;
    queueMicrotask(() => {
      try {
        onNext(result);
      } catch (listenerError) {
        // Matches @firebase/app-check: errors thrown inside listener callbacks are ignored (#1909).
        void listenerError;
      }
    });
  }
}

/** The app's provider token, or a sandbox-minted one when it has no provider to call. */
async function freshToken(
  app: FirebaseApp,
  state: AppCheckState,
  now: number,
  ttlSeconds: number = TTL_SECONDS,
): Promise<TimedAppCheckToken> {
  const provider = state.attestedBy;
  if (provider !== null) {
    const customToken = await Promise.resolve().then(() => provider.getToken());
    const receiptNow = clockNow(app);
    return {
      token: customToken.token,
      expireTimeMillis: customToken.expireTimeMillis,
      issuedAtTimeMillis: issuedAtTimeMillisOf(customToken.token, receiptNow),
    };
  }
  warnIfProductionNeverSettles(state.provider, state.debugMode);
  const minted: MintedToken = await mintAppCheckToken(state.identity, ttlSeconds, now);
  return {
    token: minted.token,
    expireTimeMillis: minted.expireTimeMillis,
    issuedAtTimeMillis: Math.floor(now / 1000) * 1000,
  };
}

function isValid(token: TimedAppCheckToken | null, nowMillis: number): token is TimedAppCheckToken {
  return token !== null && token.expireTimeMillis > nowMillis;
}

/**
 * Resolves a token as `@firebase/app-check` 0.13.1 internal `getToken` does:
 * never rejects; failures carry `error` (no valid cache) or `internalError`
 * (forced refresh failed while a valid cached token remains).
 */
async function resolveTokenInternal(
  app: FirebaseApp,
  state: AppCheckState,
  forceRefresh: boolean,
): Promise<InternalTokenResult> {
  const now = clockNow(app);
  let cached = state.cached;
  if (cached !== null && !isValid(cached, now)) {
    state.cached = null;
    cached = null;
  }
  if (!forceRefresh && cached !== null) {
    return { token: cached.token };
  }

  let shouldCallListeners = false;
  if (state.inFlight === null) {
    shouldCallListeners = true;
    state.inFlight = freshToken(app, state, now).finally(() => {
      state.inFlight = null;
    });
  }

  let exchanged: TimedAppCheckToken | null = null;
  let failed = false;
  let failure: unknown;
  try {
    exchanged = await state.inFlight;
  } catch (err) {
    failed = true;
    failure = err;
  }

  let interopResult: InternalTokenResult;
  if (!failed && exchanged !== null) {
    state.cached = exchanged;
    interopResult = { token: exchanged.token };
  } else {
    const remaining = cached;
    if (remaining !== null && isValid(remaining, clockNow(app))) {
      // Valid cached token survives a failed forced refresh; downstream observers
      // receive `next` with `internalError` so 3P listeners keep the live token (#1656).
      interopResult = {
        token: remaining.token,
        internalError: failure as Error,
      };
    } else {
      interopResult = {
        token: APP_CHECK_PLACEHOLDER_TOKEN,
        error: failure as Error,
      };
    }
  }

  if (shouldCallListeners) {
    notifyTokenListeners(state.observers, interopResult);
  }
  return interopResult;
}

export async function cachedOrMint(
  app: FirebaseApp,
  state: AppCheckState,
  forceRefresh: boolean,
): Promise<AppCheckTokenResult> {
  const result = await resolveTokenInternal(app, state, forceRefresh);
  if ('error' in result) {
    throw result.error;
  }
  if ('internalError' in result) {
    throw result.internalError;
  }
  return { token: result.token };
}

/**
 * The token a service such as AI Logic sends: upstream's internal `getToken`
 * never rejects, and sends its placeholder when the provider fails, which AI
 * Logic refuses. Logs production's warning on the placeholder path (#1656).
 */
async function tokenForService(app: FirebaseApp, state: AppCheckState): Promise<string> {
  const result = await resolveTokenInternal(app, state, false);
  if ('error' in result) {
    console.warn(`Unable to obtain a valid App Check token: ${errorMessageOf(result.error)}`);
  }
  return result.token;
}

/** Upstream `getLimitedUseToken` skips the cache and calls the provider; a rejection propagates. */
export async function mintLimitedUse(app: FirebaseApp, state: AppCheckState): Promise<AppCheckTokenResult> {
  const minted = await freshToken(app, state, clockNow(app), LIMITED_USE_TTL_SECONDS);
  return { token: minted.token };
}

function ensureTokenRefresher(app: FirebaseApp, state: AppCheckState): TokenRefresher {
  if (state.refresher !== null) return state.refresher;
  const clock = clockOf(app);
  const refresher = new TokenRefresher({
    operation: async () => {
      const forceRefresh = state.cached !== null;
      const result = await resolveTokenInternal(app, state, forceRefresh);
      if ('error' in result) {
        throw result.error;
      }
      if ('internalError' in result) {
        throw result.internalError;
      }
    },
    getWaitDuration: () => computeNextRefreshDelayMillis(state.cached, clockNow(app)),
    now: () => clockNow(app),
    subscribeClock: bindSandboxClockSubscriber(clock),
  });
  state.refresher = refresher;
  return refresher;
}

function startRefresherIfEnabled(app: FirebaseApp, state: AppCheckState): void {
  if (state.observers.size === 0) return;
  const refresher = ensureTokenRefresher(app, state);
  if (!refresher.isRunning() && state.isTokenAutoRefreshEnabled) {
    refresher.start();
  }
}

export function addObserver(app: FirebaseApp, state: AppCheckState, observer: TokenObserver): () => void {
  state.observers.add(observer);
  ensureTokenRefresher(app, state);
  const validCached = state.cached;
  if (isValid(validCached, clockNow(app))) {
    notifyTokenListeners([observer], { token: validCached.token });
  }
  queueMicrotask(() => {
    startRefresherIfEnabled(app, state);
  });
  return () => {
    state.observers.delete(observer);
    if (state.observers.size === 0 && state.refresher !== null && state.refresher.isRunning()) {
      state.refresher.stop();
    }
  };
}

/**
 * Adds upstream's internal listener when `initializeAppCheck` runs with
 * auto-refresh enabled so the refresher fetches and maintains a token proactively.
 */
export function startInitialAutoRefresh(app: FirebaseApp, state: AppCheckState): void {
  if (!state.isTokenAutoRefreshEnabled) return;
  addObserver(app, state, { next: () => {}, kind: 'internal' });
}

/** Matches upstream `setTokenAutoRefreshEnabled`: starts/stops an existing refresher immediately. */
export function updateAutoRefreshEnabled(state: AppCheckState, isTokenAutoRefreshEnabled: boolean): void {
  if (state.refresher !== null) {
    if (isTokenAutoRefreshEnabled === true) {
      if (!state.refresher.isRunning() && state.observers.size > 0) {
        state.refresher.start();
      }
    } else {
      state.refresher.stop();
    }
  }
  state.isTokenAutoRefreshEnabled = isTokenAutoRefreshEnabled;
}
