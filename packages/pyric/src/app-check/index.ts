/**
 * `pyric/app-check`: the sandbox mirror of `firebase/app-check`.
 *
 * The sandbox has no attestation authority. Under a debug token it behaves
 * like production with a registered one: providers are never called, and
 * every token request succeeds with a token of production's shape. With no
 * debug token set, a `CustomProvider` is called as production calls it, and
 * the token it returns is what AI Logic's gate judges; the reCAPTCHA
 * providers still get a sandbox-minted token. The
 * conformance rows are in packages/conformance/registry/app-check.ts and the
 * suite in packages/pyric/test/app-check/oracle-conformance.test.ts.
 *
 * The value surface is exactly `firebase/app-check` 12.13.0's.
 */
import { getApp } from '../app/registry.js';
import type { FirebaseApp } from '../app/types.js';
import { appCheckError } from './errors.js';
import { CustomProvider, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider, sameProvider, type AppCheckProvider } from './providers.js';
import {
  activate,
  addObserver,
  cachedOrMint,
  mintLimitedUse,
  stateOf,
  type AppCheckState,
  type AppCheckTokenResult,
  type TokenObserver,
} from './state.js';

export { CustomProvider, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider };
export type { CustomProviderOptions, AppCheckTokenFromProvider as AppCheckToken } from './providers.js';
export type { AppCheckTokenResult } from './state.js';

export interface AppCheck {
  readonly app: FirebaseApp;
}

export interface AppCheckOptions {
  provider: AppCheckProvider;
  isTokenAutoRefreshEnabled?: boolean;
}

export type AppCheckTokenListener = (token: AppCheckTokenResult) => void;
export type Unsubscribe = () => void;
export interface PartialObserver<T> {
  next?: (value: T) => void;
  error?: (error: Error) => void;
  complete?: () => void;
}

class AppCheckHandle implements AppCheck {
  constructor(readonly app: FirebaseApp) {}
}

const handles = new WeakMap<FirebaseApp, AppCheckHandle>();

/**
 * Upstream (`@firebase/app-check` 0.13.1, firebase 12.19.0) compares the flags
 * as booleans, `!!initial === !!next`, so an omitted flag equals `false`.
 */
function hasSameOptions(state: AppCheckState, options: AppCheckOptions): boolean {
  const sameRefresh = Boolean(state.initialAutoRefresh) === Boolean(options.isTokenAutoRefreshEnabled);
  return sameRefresh && sameProvider(state.provider, options.provider);
}

export function initializeAppCheck(app: FirebaseApp | undefined, options: AppCheckOptions): AppCheck {
  const target = app ?? getApp();
  const existing = stateOf(target);
  if (existing) {
    if (!hasSameOptions(existing, options)) throw appCheckError('already-initialized', target.name);
    return handles.get(target)!;
  }
  activate(target, options.provider, options.isTokenAutoRefreshEnabled);
  const handle = new AppCheckHandle(target);
  handles.set(target, handle);
  // Last, as upstream: a provider that throws here leaves the app initialized,
  // so the same options then return this handle (see providers.ts).
  options.provider.initialize();
  return handle;
}

function activeState(appCheck: AppCheck): AppCheckState {
  const state = stateOf(appCheck.app);
  if (!state) throw appCheckError('use-before-activation', appCheck.app.name);
  return state;
}

export async function getToken(appCheck: AppCheck, forceRefresh = false): Promise<AppCheckTokenResult> {
  const state = activeState(appCheck);
  return cachedOrMint(appCheck.app, state, forceRefresh);
}

export async function getLimitedUseToken(appCheck: AppCheck): Promise<AppCheckTokenResult> {
  return mintLimitedUse(appCheck.app, activeState(appCheck));
}

export function setTokenAutoRefreshEnabled(appCheck: AppCheck, isTokenAutoRefreshEnabled: boolean): void {
  activeState(appCheck).isTokenAutoRefreshEnabled = isTokenAutoRefreshEnabled;
}

function toObserver(
  onNextOrObserver: AppCheckTokenListener | PartialObserver<AppCheckTokenResult>,
  onError?: (error: Error) => void,
  onCompletion?: () => void,
): TokenObserver {
  if (typeof onNextOrObserver === 'function') {
    return { next: onNextOrObserver, error: onError, complete: onCompletion };
  }
  return { next: onNextOrObserver.next ?? (() => {}), error: onNextOrObserver.error, complete: onNextOrObserver.complete };
}

export function onTokenChanged(
  appCheck: AppCheck,
  onNextOrObserver: AppCheckTokenListener | PartialObserver<AppCheckTokenResult>,
  onError?: (error: Error) => void,
  onCompletion?: () => void,
): Unsubscribe {
  return addObserver(activeState(appCheck), toObserver(onNextOrObserver, onError, onCompletion));
}
