/**
 * The four Firebase modules live mode wraps, and the exports of each it
 * observes. A wrapped module carries every export of the real module: the
 * observed ones as wrappers that call the real function, and every other one
 * (classes, constants, `doc`, `query`, `getFirestore`, `getAuth`) as the
 * real value itself, so `instanceof` and identity checks see the SDK's own.
 *
 * The real module is passed in. A plane loads it from the app's own installed
 * `firebase`, so the app object, Auth, Firestore and App Check all come from
 * one `@firebase/app` component registry. The app object the app holds is the
 * SDK's own app: Firestore, Auth and App Check read `.app` from its
 * container, so only the real app makes `db.app === app` hold. A Pyric app
 * that borrows a real app's container, as production AI mode's shadow app
 * does, gets back the shadow from `db.app` instead.
 *
 * This file imports no Firebase SDK, so nothing here adds a dependency on it.
 */
import { observedCall, observedListener, type LiveObserver, type ObservedSite } from './observe.js';

export type LiveModuleKey = 'live-app' | 'live-auth' | 'live-firestore' | 'live-app-check';

export interface LiveModuleSpec {
  /** One-shot exports: each call's return, throw, resolution or rejection is recorded. */
  readonly calls: readonly string[];
  /** Listener exports: the subscribe call and each value or error handed to the app's callbacks are recorded. */
  readonly listeners: readonly string[];
}

export const LIVE_MODULES: Readonly<Record<LiveModuleKey, LiveModuleSpec>> = {
  'live-app': {
    calls: ['initializeApp', 'getApp', 'deleteApp'],
    listeners: [],
  },
  'live-auth': {
    calls: [
      'signInWithEmailAndPassword',
      'signInAnonymously',
      'signInWithCustomToken',
      'signInWithCredential',
      'signInWithEmailLink',
      'signInWithPopup',
      'signInWithRedirect',
      'signInWithPhoneNumber',
      'getRedirectResult',
      'createUserWithEmailAndPassword',
      'signOut',
      'sendPasswordResetEmail',
      'sendEmailVerification',
      'sendSignInLinkToEmail',
      'updateProfile',
      'updateEmail',
      'updatePassword',
      'deleteUser',
      'linkWithCredential',
      'unlink',
      'reauthenticateWithCredential',
      'getIdToken',
      'getIdTokenResult',
    ],
    listeners: ['onAuthStateChanged', 'onIdTokenChanged'],
  },
  'live-firestore': {
    calls: [
      'getDoc',
      'getDocs',
      'getDocFromCache',
      'getDocFromServer',
      'getDocsFromCache',
      'getDocsFromServer',
      'getCountFromServer',
      'getAggregateFromServer',
      'setDoc',
      'updateDoc',
      'deleteDoc',
      'addDoc',
      'runTransaction',
    ],
    listeners: ['onSnapshot', 'onSnapshotResume'],
  },
  'live-app-check': {
    calls: ['initializeAppCheck', 'getToken', 'getLimitedUseToken'],
    listeners: ['onTokenChanged'],
  },
};

type Wrap = typeof observedCall;

function wrapExports(
  wrapped: Record<string, unknown>,
  names: readonly string[],
  wrap: Wrap,
  site: Omit<ObservedSite, 'name'>,
): void {
  for (const name of names) {
    const real = wrapped[name];
    // A name this SDK version does not export stays absent.
    if (typeof real !== 'function') continue;
    wrapped[name] = wrap({ ...site, name }, real as Parameters<Wrap>[1]);
  }
}

/**
 * The real module's exports with the observed ones wrapped. `specifier` is
 * the module the app imported, as records name it.
 */
export function wrapLiveModule<T extends object>(
  key: LiveModuleKey,
  specifier: string,
  real: T,
  observer: LiveObserver,
): T {
  const spec = LIVE_MODULES[key];
  const wrapped: Record<string, unknown> = { ...(real as Record<string, unknown>) };
  const site = { module: specifier, observer };
  wrapExports(wrapped, spec.calls, observedCall, site);
  wrapExports(wrapped, spec.listeners, observedListener, site);
  return wrapped as T;
}
