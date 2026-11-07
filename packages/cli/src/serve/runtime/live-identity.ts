/**
 * Live mode's signed-in user, read in the page from the app's own Firebase
 * Auth. `@pyric/live` lists each Auth instance its row hands the app on the
 * page hub (`Symbol.for('pyric.live.auths')`, `packages/live/src/account.ts`);
 * this store listens to each one with the instance's own
 * `onAuthStateChanged`, so pyric never calls production Auth on its own
 * behalf. The one exception is the chip's Sign out, which the developer
 * presses: it calls each instance's own `signOut`, as the app would.
 * Outside live mode the hub stays empty and the store signed out.
 *
 * The uid, email, display name and provider stay in this module's memory:
 * they never reach call records, the event stream, capture files, browser
 * storage or a request to the host. The recent users are this page
 * session's only, newest first, and end with the page.
 */

/** The user the app's Auth holds, as the page runtime keeps it. */
export interface LiveIdentity {
  uid: string;
  email: string | null;
  displayName: string | null;
  /** The first linked provider (`google.com`, `password`), `anonymous`, or null when the user names none. */
  providerId: string | null;
}

/** The page hub `@pyric/live` writes: the Auth instances it handed the app, and who to tell of a new one. */
export interface LiveAuthHub {
  readonly auths: object[];
  readonly listeners: Set<(auth: object) => void>;
}

export interface LiveIdentityStore {
  /** The user the app signed in last, or null once it signed out or before it signs in. */
  current(): LiveIdentity | null;
  /** The users signed in during this page session, newest first, each once. */
  recent(): LiveIdentity[];
  subscribe(listener: (user: LiveIdentity | null) => void): () => void;
  /**
   * Signs the user out of every Auth the app made, with each instance's own
   * `signOut`, as the app's own sign-out would. Rejects with the first
   * failure, after every instance was asked.
   */
  signOut(): Promise<void>;
  dispose(): void;
}

const LIVE_AUTH_HUB_KEY = Symbol.for('pyric.live.auths');
const MAX_RECENT_USERS = 10;

type Fields = Record<string, unknown>;
type Unsubscribe = () => void;

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function providerOf(user: Fields): string | null {
  const providers = Array.isArray(user.providerData) ? user.providerData : [];
  const first: unknown = providers[0];
  if (isObject(first) && typeof first.providerId === 'string') return first.providerId;
  return user.isAnonymous === true ? 'anonymous' : null;
}

/** The identity of an Auth user, or null for no user or a value without a uid. */
export function liveIdentityOf(user: unknown): LiveIdentity | null {
  if (!isObject(user)) return null;
  const uid = user.uid;
  const hasUid = typeof uid === 'string' && uid.length > 0;
  if (!hasUid) return null;
  return { uid, email: textOrNull(user.email), displayName: textOrNull(user.displayName), providerId: providerOf(user) };
}

/** One Auth's own sign-out; an instance without one has nothing to sign out. */
async function signOutOf(auth: object): Promise<void> {
  const signOut = (auth as Fields).signOut;
  if (typeof signOut !== 'function') return;
  await Reflect.apply(signOut, auth, []);
}

/** A store that follows every Auth on `hub`, those listed now and those listed later. */
export function createLiveIdentity(hub: LiveAuthHub): LiveIdentityStore {
  let current: LiveIdentity | null = null;
  let recent: LiveIdentity[] = [];
  const listeners = new Set<(user: LiveIdentity | null) => void>();
  const watched = new Map<object, Unsubscribe>();

  function changed(user: unknown): void {
    current = liveIdentityOf(user);
    if (current !== null) {
      const uid = current.uid;
      recent = [current, ...recent.filter((seen) => seen.uid !== uid)].slice(0, MAX_RECENT_USERS);
    }
    for (const listener of listeners) listener(current);
  }

  function watch(auth: object): void {
    if (watched.has(auth)) return;
    const onAuthStateChanged = (auth as Fields).onAuthStateChanged;
    if (typeof onAuthStateChanged !== 'function') return;
    try {
      const unsubscribe: unknown = Reflect.apply(onAuthStateChanged, auth, [changed]);
      watched.set(auth, typeof unsubscribe === 'function' ? (unsubscribe as Unsubscribe) : () => {});
    } catch {
      // An Auth that refuses a listener leaves the store as it was; the app's Auth is unchanged.
    }
  }

  hub.auths.forEach(watch);
  hub.listeners.add(watch);
  return {
    current: () => current,
    recent: () => [...recent],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async signOut() {
      const signOuts = [...watched.keys()].map(signOutOf);
      const failed = (await Promise.allSettled(signOuts)).find((result) => result.status === 'rejected');
      if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
    },
    dispose() {
      hub.listeners.delete(watch);
      for (const unsubscribe of watched.values()) unsubscribe();
      watched.clear();
      listeners.clear();
    },
  };
}

let pageStore: LiveIdentityStore | undefined;

/** The page's one store, on the hub `@pyric/live` shares; the hub is made here when the runtime loads first. */
export function pageLiveIdentity(): LiveIdentityStore {
  const scope = globalThis as { [LIVE_AUTH_HUB_KEY]?: LiveAuthHub };
  const hub = scope[LIVE_AUTH_HUB_KEY] ??= { auths: [], listeners: new Set() };
  pageStore ??= createLiveIdentity(hub);
  return pageStore;
}
