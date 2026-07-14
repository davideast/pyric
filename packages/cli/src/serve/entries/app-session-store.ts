/** App-owned browser auth-session stores for the served Firebase adapters. */
import type { FirebaseApp } from 'pyric/app';
import { registerAppCleanup } from 'pyric/app/internal';
import { SessionStore, type SessionStores } from './session-store.js';

export interface AppSessionStores {
  forApp(app: FirebaseApp): SessionStore;
}

/**
 * Build an app-identity-keyed store registry. The durable key inside each
 * SessionStore remains app-name-keyed, so deleting/recreating an app can
 * restore the same session while its in-memory mode/callback state is fresh.
 */
export function createAppSessionStores(stores: SessionStores): AppSessionStores {
  const byApp = new WeakMap<FirebaseApp, SessionStore>();
  return {
    forApp(app) {
      const existing = byApp.get(app);
      if (existing) return existing;
      const store = new SessionStore(stores, app.name);
      byApp.set(app, store);
      registerAppCleanup(app, () => { byApp.delete(app); });
      return store;
    },
  };
}

function memoryStorage(): SessionStores['local'] {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const browserStores: SessionStores =
  typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined'
    ? { local: localStorage, session: sessionStorage }
    : { local: memoryStorage(), session: memoryStorage() };

const servedStores = createAppSessionStores(browserStores);

export function sessionStoreForApp(app: FirebaseApp): SessionStore {
  return servedStores.forApp(app);
}
