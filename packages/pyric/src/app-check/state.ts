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
import {
  APP_CHECK_PLACEHOLDER_TOKEN,
  mintAppCheckToken,
  type MintedAppCheckToken as MintedToken,
} from '../sandbox/internal/app-check-token.js';
import { appCheckActivationOf, recordAppCheckActivation } from '../sandbox/internal/app-check-activation.js';
import { CustomProvider, type AppCheckProvider } from './providers.js';

/** Web App Check tokens live one hour (capture `app-check-client-debug-get-token`). */
const TTL_SECONDS = 3600;

export interface AppCheckTokenResult {
  readonly token: string;
}

export interface TokenObserver {
  next: (result: AppCheckTokenResult) => void;
  error?: (error: Error) => void;
  complete?: () => void;
}

export interface AppCheckState {
  provider: AppCheckProvider;
  /** The raw option `initializeAppCheck` was called with, `undefined` included; a later call is compared with this. */
  readonly initialAutoRefresh: boolean | undefined;
  isTokenAutoRefreshEnabled: boolean;
  cached: MintedToken | null;
  /** The one mint in flight for this app; concurrent `getToken` calls share it, as upstream shares `exchangeTokenPromise`. */
  inFlight: Promise<MintedToken> | null;
  observers: Set<TokenObserver>;
  /** The `CustomProvider` this app's tokens come from, or `null` when the sandbox mints them. */
  readonly attestedBy: CustomProvider | null;
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

/** Upstream `_activate`: an omitted flag is `false`, and `automaticDataCollectionEnabled: false` blocks `true`. */
function effectiveAutoRefresh(app: FirebaseApp, requested: boolean | undefined): boolean {
  const wanted = requested ?? false;
  const blocked = wanted && !app.automaticDataCollectionEnabled;
  if (blocked) console.warn(BLOCKED_REFRESH_WARNING);
  return wanted && app.automaticDataCollectionEnabled;
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

function attestationProvider(provider: AppCheckProvider): CustomProvider | null {
  const callsProvider = provider instanceof CustomProvider && !isDebugTokenSet();
  return callsProvider ? provider : null;
}

export function activate(app: FirebaseApp, provider: AppCheckProvider, isTokenAutoRefreshEnabled: boolean | undefined): AppCheckState {
  const state: AppCheckState = {
    provider,
    initialAutoRefresh: isTokenAutoRefreshEnabled,
    isTokenAutoRefreshEnabled: effectiveAutoRefresh(app, isTokenAutoRefreshEnabled),
    cached: null,
    inFlight: null,
    observers: new Set(),
    attestedBy: attestationProvider(provider),
  };
  record(app, state);
  return state;
}

function identityOf(app: FirebaseApp) {
  const options = app.options as { appId?: string; projectId?: string };
  return { appId: options.appId ?? '', projectId: options.projectId ?? '' };
}

/** Delivers a token to observers off the caller's stack, as the SDK does. */
function notify(observers: Iterable<TokenObserver>, result: AppCheckTokenResult): void {
  for (const observer of observers) {
    queueMicrotask(() => observer.next(result));
  }
}

/** Upstream `notifyTokenListeners` sends a failed exchange to an `onTokenChanged` observer's error handler. */
function notifyError(observers: Iterable<TokenObserver>, error: unknown): void {
  for (const observer of observers) {
    queueMicrotask(() => observer.error?.(error as Error));
  }
}

/** The app's provider token, or a sandbox-minted one when it has no provider to call. */
function freshToken(app: FirebaseApp, state: AppCheckState, now: number): Promise<MintedToken> {
  if (state.attestedBy === null) return mintAppCheckToken(identityOf(app), TTL_SECONDS, now);
  return state.attestedBy.getToken();
}

function isValid(token: MintedToken | null, nowMillis: number): token is MintedToken {
  return token !== null && token.expireTimeMillis > nowMillis;
}

/** Starts a mint unless one is in flight; only the call that starts it notifies observers. */
function sharedMint(app: FirebaseApp, state: AppCheckState, now: number): Promise<MintedToken> {
  if (state.inFlight) return state.inFlight;
  const mint = freshToken(app, state, now).then(
    (minted) => {
      state.cached = minted;
      notify(state.observers, { token: minted.token });
      return minted;
    },
    (error: unknown) => {
      notifyError(state.observers, error);
      throw error;
    },
  );
  state.inFlight = mint.finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}

export async function cachedOrMint(app: FirebaseApp, state: AppCheckState, forceRefresh: boolean): Promise<AppCheckTokenResult> {
  const now = Date.now();
  const reuse = !forceRefresh && isValid(state.cached, now);
  if (reuse) return { token: state.cached!.token };
  const minted = await sharedMint(app, state, now);
  return { token: minted.token };
}

/**
 * The token a service such as AI Logic sends: upstream's internal `getToken`
 * never rejects, and sends its placeholder when the provider fails, which AI
 * Logic refuses.
 */
async function tokenForService(app: FirebaseApp, state: AppCheckState): Promise<string> {
  try {
    return (await cachedOrMint(app, state, false)).token;
  } catch {
    return APP_CHECK_PLACEHOLDER_TOKEN;
  }
}

/** Upstream `getLimitedUseToken` skips the cache and calls the provider; a rejection propagates. */
export async function mintLimitedUse(app: FirebaseApp, state: AppCheckState): Promise<AppCheckTokenResult> {
  const minted = await freshToken(app, state, Date.now());
  return { token: minted.token };
}

export function addObserver(state: AppCheckState, observer: TokenObserver): () => void {
  state.observers.add(observer);
  if (isValid(state.cached, Date.now())) notify([observer], { token: state.cached.token });
  return () => {
    state.observers.delete(observer);
  };
}
