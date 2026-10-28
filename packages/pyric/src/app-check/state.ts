/**
 * Per-app App Check state: the activation options, the cached token, and the
 * token listeners. Keyed by the app object, as upstream keys it.
 */
import type { FirebaseApp } from '../app/types.js';
import { mintAppCheckToken, type MintedAppCheckToken as MintedToken } from '../sandbox/internal/app-check-token.js';

/** Web App Check tokens live one hour (capture `app-check-client-debug-get-token`). */
const TTL_SECONDS = 3600;
import type { AppCheckProvider } from './providers.js';

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
}

const states = new WeakMap<FirebaseApp, AppCheckState>();

export function stateOf(app: FirebaseApp): AppCheckState | undefined {
  return states.get(app);
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

export function activate(app: FirebaseApp, provider: AppCheckProvider, isTokenAutoRefreshEnabled: boolean | undefined): AppCheckState {
  const state: AppCheckState = {
    provider,
    initialAutoRefresh: isTokenAutoRefreshEnabled,
    isTokenAutoRefreshEnabled: effectiveAutoRefresh(app, isTokenAutoRefreshEnabled),
    cached: null,
    inFlight: null,
    observers: new Set(),
  };
  states.set(app, state);
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

function isValid(token: MintedToken | null, nowMillis: number): token is MintedToken {
  return token !== null && token.expireTimeMillis > nowMillis;
}

/** Starts a mint unless one is in flight; only the call that starts it notifies observers. */
function sharedMint(app: FirebaseApp, state: AppCheckState, now: number): Promise<MintedToken> {
  if (state.inFlight) return state.inFlight;
  const mint = mintAppCheckToken(identityOf(app), TTL_SECONDS, now).then((minted) => {
    state.cached = minted;
    notify(state.observers, { token: minted.token });
    return minted;
  });
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

export async function mintLimitedUse(app: FirebaseApp): Promise<AppCheckTokenResult> {
  return { token: (await mintAppCheckToken(identityOf(app), TTL_SECONDS)).token };
}

export function addObserver(state: AppCheckState, observer: TokenObserver): () => void {
  state.observers.add(observer);
  if (isValid(state.cached, Date.now())) notify([observer], { token: state.cached.token });
  return () => {
    state.observers.delete(observer);
  };
}
