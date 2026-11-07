/**
 * The Firebase modules live mode wraps, and the exports of each it
 * observes. A wrapped module carries every export of the real module: the
 * observed ones as wrappers that call the real function, the guarded ones
 * (`getFirestore` and `initializeFirestore`, which refuse a named database)
 * as wrappers that throw live mode's refusal or call the real function, and
 * the noted ones (`getAuth` and `initializeAuth`) as wrappers that note the
 * Auth they return so a call's record can name its account (`account.ts`),
 * and every other one (classes, constants, `doc`, `query`) as the real value
 * itself, so `instanceof` and identity checks see the SDK's own. Every
 * wrapper returns the SDK's own result, with three exceptions (`observe.ts`):
 * a promise comes back as a new promise that settles the same way, RTDB's
 * `push` reference comes back with its `then` and `catch` following the
 * write, and a Firestore listener the page's observer journals returns a
 * function that closes the listener's journal activity and then calls the
 * SDK's own unsubscribe.
 *
 * The database row (`database.ts`) also replaces `getDatabase`: an app whose
 * config names another project, or a URL that names another project's
 * default instance, is refused before the SDK's factory runs, and the
 * Database it returns is noted, so a reference's repo
 * names its app. The OnDisconnect `onDisconnect` returns gets observed
 * methods. Its `off` takes the app's callback and removes the recording one.
 *
 * The Firestore row replaces `writeBatch`: the batch it returns counts its
 * operations, and its `commit` is one observed `writeBatch` call (`firestore.ts`).
 *
 * The AI row (`ai.ts`) observes instances, not exports: the GenerativeModel
 * `getGenerativeModel` returns, and each one `new GenerativeModel(...)` or
 * `new ChatSession(...)` builds, gets own-property wrappers for the calls
 * that reach production, and `startChat` does the same to its chat. The SDK's
 * classes and prototypes stay its own. A stream call's result is the SDK's
 * own object, with its `response` replaced by a promise that follows the
 * SDK's and its `stream` by one that yields the SDK's own chunks.
 *
 * The Firestore, Database and Storage rows also hand their wrapped module to the
 * reads a live page answers for its host (`tab-reads.ts`), which notes each
 * instance their factories return.
 *
 * The Firestore row reads each call's path, the document or collection its
 * reference or query names, and a write's data through its context hook,
 * and a `getDoc`'s returned document through its result hook (`firestore.ts`).
 *
 * The Storage row (`storage.ts`) observes exports. `uploadBytesResumable`
 * returns the SDK's own UploadTask, its `then` and `catch` following the
 * task's settlement, and `getStream` returns a stream that follows the
 * SDK's.
 *
 * The Messaging rows (`messaging.ts`) observe `getToken` and `deleteToken`,
 * whose records list the Installations and FCM registration requests each
 * made, and the deliveries of `onMessage` (`firebase/messaging`) and
 * `onBackgroundMessage` (`firebase/messaging/sw`). A call that made no
 * request makes no record. The FID registration calls are refused.
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
import {
  databaseCode,
  databaseContext,
  databaseListener,
  databaseListenerArguments,
  databaseListenerAttached,
  databaseListenerCallback,
  guardedGetDatabase,
  observeOnDisconnect,
  offByCallback,
} from './database.js';
import { AI_REFUSED_CALLS, aiCode, aiContext, aiMessage, aiResult, observedChatClass, observedGetGenerativeModel, observedModelClass } from './ai.js';
import { firestoreContext, firestoreListener, firestoreResult, observedWriteBatch } from './firestore.js';
import { observedGetStream, STORAGE_CALLS, storageContext } from './storage.js';
import {
  MESSAGING_CALLS,
  MESSAGING_REFUSED_CALLS,
  MESSAGING_SW_REFUSED_CALLS,
  messagingCode,
  messagingContext,
  messagingRejection,
  messagingResult,
} from './messaging.js';
import { noMessage, observedCall, observedListener, type LiveObserver, type ObservedHooks, type ObservedSite, type UncaughtListenerError } from './observe.js';
import { liveCallRefusal, type LiveClient, type RefusedCall } from './refusal.js';
import { noteReadModule, readFactoryNames } from './tab-reads.js';

export type LiveModuleKey =
  | 'live-app'
  | 'live-auth'
  | 'live-firestore'
  | 'live-app-check'
  | 'live-database'
  | 'live-ai'
  | 'live-storage'
  | 'live-messaging'
  | 'live-messaging-sw';

type Callback = (this: unknown, ...args: unknown[]) => unknown;

/** Takes what an export returned, unrecorded, before the app gets it: to note it, or to observe its methods. */
export type Decorate = (returned: unknown, site: Omit<ObservedSite, 'name'>) => void;

/** Builds the row's own function of the SDK's export, for the site its records go to. */
export type Replace = (real: Callback, site: Omit<ObservedSite, 'name'>) => Callback;

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
  /** One-shot exports whose result is a thenable, not a promise, whose settlement is production's answer. */
  readonly thenables?: readonly string[];
  /** Thenables whose SDK handles its own promise's rejection, so the promise that follows one is handled too (`observe.ts`). */
  readonly swallowsRejection?: readonly string[];
  /** What every wrapper of this module reads differently from Firestore and Auth (`observe.ts`). */
  readonly hooks?: ObservedHooks;
  /** Exports called as the app called them, unrecorded, whose result is decorated before the app gets it. */
  readonly decorated?: Readonly<Record<string, Decorate>>;
  /** Exports the row replaces with its own function of the SDK's, unrecorded. */
  readonly replaced?: Readonly<Record<string, Replace>>;
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
    hooks: { context: firestoreContext, resultOf: firestoreResult, listenerOf: firestoreListener },
    replaced: { writeBatch: observedWriteBatch },
    refused: {
      getFirestore: getFirestoreDatabase,
      initializeFirestore: initializeFirestoreDatabase,
    },
  },
  'live-app-check': {
    calls: ['initializeAppCheck', 'getToken', 'getLimitedUseToken'],
    listeners: ['onTokenChanged'],
  },
  'live-database': {
    calls: ['get', 'set', 'update', 'remove', 'push', 'runTransaction', 'setWithPriority', 'setPriority'],
    listeners: ['onValue', 'onChildAdded', 'onChildChanged', 'onChildRemoved', 'onChildMoved'],
    thenables: ['push'],
    hooks: {
      context: databaseContext,
      codeOf: databaseCode,
      listenerArguments: databaseListenerArguments,
      listenerCallback: databaseListenerCallback,
      listenerOf: databaseListener,
      listenerAttached: databaseListenerAttached,
    },
    decorated: { onDisconnect: observeOnDisconnect },
    replaced: { getDatabase: guardedGetDatabase, off: offByCallback },
  },
  'live-ai': {
    calls: [],
    listeners: [],
    hooks: { context: aiContext, codeOf: aiCode, messageOf: aiMessage, resultOf: aiResult },
    refused: AI_REFUSED_CALLS,
    replaced: {
      getGenerativeModel: observedGetGenerativeModel,
      GenerativeModel: observedModelClass,
      ChatSession: observedChatClass,
    },
  },
  'live-storage': {
    calls: STORAGE_CALLS,
    listeners: [],
    thenables: ['uploadBytesResumable'],
    swallowsRejection: ['uploadBytesResumable'],
    hooks: { context: storageContext, throwsLocally: true },
    replaced: { getStream: observedGetStream },
  },
  'live-messaging': {
    calls: MESSAGING_CALLS,
    listeners: ['onMessage'],
    hooks: { context: messagingContext, codeOf: messagingCode, messageOf: noMessage, resultOf: messagingResult, rejectionOf: messagingRejection },
    refused: MESSAGING_REFUSED_CALLS,
  },
  'live-messaging-sw': {
    calls: [],
    listeners: ['onBackgroundMessage'],
    hooks: { context: messagingContext, messageOf: noMessage },
    refused: MESSAGING_SW_REFUSED_CALLS,
  },
};

type Wrap = typeof observedCall;

function wrapExports(
  wrapped: Record<string, unknown>,
  names: readonly string[],
  wrap: Wrap,
  site: Omit<ObservedSite, 'name'>,
  thenables: readonly string[] = [],
  swallowing: readonly string[] = [],
): void {
  for (const name of names) {
    const real = wrapped[name];
    // A name this SDK version does not export stays absent.
    if (typeof real !== 'function') continue;
    const followsThenable = thenables.includes(name);
    const swallowsRejection = followsThenable && swallowing.includes(name);
    const thenable = { ...(followsThenable ? { followsThenable } : {}), ...(swallowsRejection ? { swallowsRejection } : {}) };
    wrapped[name] = wrap({ ...site, name, ...thenable }, real as Parameters<Wrap>[1]);
  }
}

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

/** Replaces each decorated export with one that calls the SDK and decorates what it returns. A decorator never throws to the app. */
function decorateExports(wrapped: Record<string, unknown>, decorators: Readonly<Record<string, Decorate>>, site: Omit<ObservedSite, 'name'>): void {
  for (const [name, decorate] of Object.entries(decorators)) {
    const real = wrapped[name];
    if (typeof real !== 'function') continue;
    wrapped[name] = function decorated(this: unknown, ...args: unknown[]): unknown {
      const returned = Reflect.apply(real as Callback, this, args);
      try {
        decorate(returned, site);
      } catch {
        // Noting or observing the result never changes what the app sees.
      }
      return returned;
    };
  }
}

/** Replaces each export the row rewires with its own function of the SDK's. */
function replaceExports(wrapped: Record<string, unknown>, replacements: Readonly<Record<string, Replace>>, site: Omit<ObservedSite, 'name'>): void {
  for (const [name, replace] of Object.entries(replacements)) {
    const real = wrapped[name];
    if (typeof real === 'function') wrapped[name] = replace(real as Callback, site);
  }
}

/** Where a wrapped module runs: who receives its records, the installed SDK's version, and the client. */
export interface LiveModuleSite {
  readonly observer: LiveObserver;
  /** The installed `firebase`'s `SDK_VERSION`, as `firebase/app` exports it; the SDK's own log lines carry it. */
  readonly sdkVersion: string;
  /** The client the module runs in, which a refusal names. */
  readonly client: LiveClient;
  /**
   * The SDK's initialized apps, `getApps()` of the app's own `firebase/app`.
   * No row observes `getApps`, so reading it records nothing; the app row
   * observes `getApp`, so a row never calls that.
   */
  readonly apps?: () => readonly unknown[];
}

/**
 * The real module's exports with the observed ones wrapped and the refused
 * ones guarded. `specifier` is the module the app imported, as records name
 * it.
 */
export function wrapLiveModule<T extends object>(key: LiveModuleKey, specifier: string, real: T, site: LiveModuleSite): T {
  const spec = LIVE_MODULES[key];
  const wrapped: Record<string, unknown> = { ...(real as Record<string, unknown>) };
  const apps = site.apps === undefined ? {} : { apps: site.apps };
  const observedSite = { module: specifier, observer: site.observer, accountOf, ...apps, ...spec.hooks };
  wrapExports(wrapped, spec.calls, observedCall, observedSite, spec.thenables, spec.swallowsRejection);
  const uncaughtListenerError = spec.uncaughtListenerError?.(site.sdkVersion);
  wrapExports(wrapped, spec.listeners, observedListener, { ...observedSite, uncaughtListenerError });
  guardExports(wrapped, spec.refused ?? {}, site.client);
  noteExports(wrapped, spec.noted ?? []);
  decorateExports(wrapped, spec.decorated ?? {}, observedSite);
  replaceExports(wrapped, spec.replaced ?? {}, observedSite);
  noteReadModule(key, wrapped);
  return wrapped as T;
}

/**
 * Every export a live module replaces: the observed, the refused, the noted,
 * the decorated and the rewired ones, and the factories whose instances the
 * page's reads use (`tab-reads.ts`), each once.
 */
export function replacedExports(key: LiveModuleKey): string[] {
  const spec = LIVE_MODULES[key];
  return [...new Set([
    ...spec.calls,
    ...spec.listeners,
    ...Object.keys(spec.refused ?? {}),
    ...(spec.noted ?? []),
    ...Object.keys(spec.decorated ?? {}),
    ...Object.keys(spec.replaced ?? {}),
    ...readFactoryNames(key),
  ])];
}
