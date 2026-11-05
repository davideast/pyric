/**
 * The four Firebase modules live mode wraps, and the exports of each it
 * observes. A wrapped module carries every export of the real module: the
 * observed ones as wrappers that call the real function, the guarded ones
 * (`getFirestore` and `initializeFirestore`, which refuse a named database)
 * as wrappers that throw live mode's refusal or call the real function, and
 * the noted ones (`getAuth` and `initializeAuth`) as wrappers that note the
 * Auth they return so a call's record can name its account (`account.ts`),
 * and every other one (classes, constants, `doc`, `query`) as the real value
 * itself, so `instanceof` and identity checks see the SDK's own. Every
 * wrapper returns the SDK's own result, with two exceptions (`observe.ts`): a
 * promise comes back as a new promise that settles the same way, and a
 * Firestore listener the page's observer journals returns a function that
 * closes the listener's journal activity and then calls the SDK's own
 * unsubscribe.
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
import { accountOf, noteAuth } from './account.js';
import { observedCall, observedListener, type LiveObserver, type ObservedSite, type UncaughtListenerError } from './observe.js';
import { liveCallRefusal, type LiveClient, type RefusedCall } from './refusal.js';

export type LiveModuleKey = 'live-app' | 'live-auth' | 'live-firestore' | 'live-app-check';

export interface LiveModuleSpec {
  /** One-shot exports: each call's return, throw, resolution or rejection is recorded. */
  readonly calls: readonly string[];
  /** Listener exports: the subscribe call and each value or error handed to the app's callbacks are recorded. */
  readonly listeners: readonly string[];
  /**
   * What the module's SDK does with a listener error when the app passed no
   * error callback, given the installed `firebase` SDK version. Absent means
   * the SDK drops the error, as Auth and App Check do.
   */
  readonly uncaughtListenerError?: (sdkVersion: string) => UncaughtListenerError;
  /**
   * Exports that live mode serves only in part. Each check reads the app's
   * arguments and names the call when it reaches what live mode does not
   * serve; the wrapper then throws the refusal instead of calling the SDK, so
   * no request leaves. A call the check passes is the SDK's own, unrecorded.
   */
  readonly refused?: Readonly<Record<string, RefusalCheck>>;
  /**
   * Exports that hand the app its Auth instance. Each is called as the app
   * called it, unrecorded, and the instance it returns is noted, so later
   * records name the account its current user is.
   */
  readonly noted?: readonly string[];
}

/** The call an export's arguments make when live mode refuses it, or null when it serves them. */
export type RefusalCheck = (args: readonly unknown[]) => RefusedCall | null;

/** The id of the one Firestore database live mode serves. */
const DEFAULT_DATABASE = '(default)';

/** The refusal of a named Firestore database, or null for the default one. */
function namedDatabaseCall(call: string, databaseId: unknown): RefusedCall | null {
  const isDefault = databaseId === DEFAULT_DATABASE;
  if (isDefault) return null;
  return {
    call: `${call} with the database ${JSON.stringify(databaseId)}`,
    reaches: `the named Firestore database ${JSON.stringify(databaseId)}`,
    serves: 'only the (default) database',
  };
}

/**
 * `getFirestore(databaseId)` or `getFirestore(app, databaseId)`: a string
 * first argument is the database. An absent or empty database, in either
 * place, is `(default)`: `getFirestore('')` opens its own instance, but the
 * SDK's `DatabaseId` reads `''` as `(default)`, so it reaches the default
 * database.
 */
function getFirestoreDatabase(args: readonly unknown[]): RefusedCall | null {
  const first = args[0];
  const named = typeof first === 'string' ? first : args[1];
  return namedDatabaseCall('getFirestore', named || DEFAULT_DATABASE);
}

/** `initializeFirestore(app, settings, databaseId)`: an absent or empty database is `(default)`. */
function initializeFirestoreDatabase(args: readonly unknown[]): RefusedCall | null {
  return namedDatabaseCall('initializeFirestore', args[2] || DEFAULT_DATABASE);
}

/**
 * Firestore's log line for a snapshot listener error with no error callback,
 * as `AsyncObserver.error` writes it through the `@firebase/firestore`
 * logger's default handler: `logError('Uncaught Error in snapshot listener:',
 * error.toString())`.
 */
function firestoreUncaughtListenerError(sdkVersion: string): UncaughtListenerError {
  return (error) => {
    const message = (error as { toString(): string }).toString();
    console.error(`[${new Date().toISOString()}]  @firebase/firestore:`, `Firestore (${sdkVersion}): Uncaught Error in snapshot listener:`, message);
  };
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
    noted: ['getAuth', 'initializeAuth'],
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
    uncaughtListenerError: firestoreUncaughtListenerError,
    refused: {
      getFirestore: getFirestoreDatabase,
      initializeFirestore: initializeFirestoreDatabase,
    },
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

type Callback = (this: unknown, ...args: unknown[]) => unknown;

/** Replaces each export a check guards with one that throws the refusal, or calls the SDK when the check passes. */
function guardExports(wrapped: Record<string, unknown>, checks: Readonly<Record<string, RefusalCheck>>, client: LiveClient): void {
  for (const [name, check] of Object.entries(checks)) {
    const real = wrapped[name];
    if (typeof real !== 'function') continue;
    wrapped[name] = function guarded(this: unknown, ...args: unknown[]): unknown {
      const refusedCall = check(args);
      if (refusedCall !== null) throw liveCallRefusal(refusedCall, client);
      return Reflect.apply(real as Callback, this, args);
    };
  }
}

/** Replaces each noted export with one that calls the SDK and notes the Auth it returns. */
function noteExports(wrapped: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    const real = wrapped[name];
    if (typeof real !== 'function') continue;
    wrapped[name] = function noted(this: unknown, ...args: unknown[]): unknown {
      const auth = Reflect.apply(real as Callback, this, args);
      noteAuth(auth);
      return auth;
    };
  }
}

/** Where a wrapped module runs: who receives its records, the installed SDK's version, and the client. */
export interface LiveModuleSite {
  readonly observer: LiveObserver;
  /** The installed `firebase`'s `SDK_VERSION`, as `firebase/app` exports it; the SDK's own log lines carry it. */
  readonly sdkVersion: string;
  /** The client the module runs in, which a refusal names. */
  readonly client: LiveClient;
}

/**
 * The real module's exports with the observed ones wrapped and the refused
 * ones guarded. `specifier` is the module the app imported, as records name
 * it.
 */
export function wrapLiveModule<T extends object>(key: LiveModuleKey, specifier: string, real: T, site: LiveModuleSite): T {
  const spec = LIVE_MODULES[key];
  const wrapped: Record<string, unknown> = { ...(real as Record<string, unknown>) };
  const observedSite = { module: specifier, observer: site.observer, accountOf };
  wrapExports(wrapped, spec.calls, observedCall, observedSite);
  const uncaughtListenerError = spec.uncaughtListenerError?.(site.sdkVersion);
  wrapExports(wrapped, spec.listeners, observedListener, { ...observedSite, uncaughtListenerError });
  guardExports(wrapped, spec.refused ?? {}, site.client);
  noteExports(wrapped, spec.noted ?? []);
  return wrapped as T;
}

/** Every export a live module replaces: the observed, the refused and the noted ones. */
export function replacedExports(key: LiveModuleKey): string[] {
  const spec = LIVE_MODULES[key];
  return [...spec.calls, ...spec.listeners, ...Object.keys(spec.refused ?? {}), ...(spec.noted ?? [])];
}
