/**
 * Per-app App Check state: the activation options, the cached token, and the
 * token listeners. Keyed by the app object, as upstream keys it.
 */
import type { FirebaseApp } from '../app/types.js';
import { mintAppCheckToken, type MintedAppCheckToken as MintedToken } from '../sandbox/internal/app-check-token.js';
import { appCheckActivationOf, recordAppCheckActivation } from '../sandbox/internal/app-check-activation.js';

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
  /** The option `initializeAppCheck` was called with; a later call is compared with this. */
  readonly initialAutoRefresh: boolean;
  isTokenAutoRefreshEnabled: boolean;
  cached: MintedToken | null;
  observers: Set<TokenObserver>;
}

/** The activation lookup is shared with `pyric/ai`, which reads it when `getAI(app)` builds a handle. */
export function stateOf(app: FirebaseApp): AppCheckState | undefined {
  return appCheckActivationOf<AppCheckState>(app)?.state;
}

function record(app: FirebaseApp, state: AppCheckState): void {
  recordAppCheckActivation(app, {
    state,
    token: async () => (await cachedOrMint(app, state, false)).token,
    limitedUseToken: async () => (await mintLimitedUse(app)).token,
  });
}

export function activate(app: FirebaseApp, provider: AppCheckProvider, isTokenAutoRefreshEnabled: boolean): AppCheckState {
  const state: AppCheckState = { provider, initialAutoRefresh: isTokenAutoRefreshEnabled, isTokenAutoRefreshEnabled, cached: null, observers: new Set() };
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

function isValid(token: MintedToken | null, nowMillis: number): token is MintedToken {
  return token !== null && token.expireTimeMillis > nowMillis;
}

export async function cachedOrMint(app: FirebaseApp, state: AppCheckState, forceRefresh: boolean): Promise<AppCheckTokenResult> {
  const now = Date.now();
  const reuse = !forceRefresh && isValid(state.cached, now);
  if (reuse) return { token: state.cached!.token };
  state.cached = await mintAppCheckToken(identityOf(app), TTL_SECONDS, now);
  const result = { token: state.cached.token };
  notify(state.observers, result);
  return result;
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
