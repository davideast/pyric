import type { PersistableService } from '../types/persistence.js';
import type { SandboxPersistenceOptions } from './types.js';

/**
 * Storage key for the persisted auth session uid. One key used across
 * both `local` and `session` stores -- the controller reads both (mode-
 * agnostic load) and writes only one (based on the current mode). This
 * mirrors how `pyric dev`'s `SessionStore` worked before the session
 * logic moved here.
 *
 * Prefixed `pyric:sandbox:` so it is immediately grepable and does not
 * collide with serve's `pyric:serve:` entries or app-level keys.
 */
const SESSION_STORAGE_KEY = 'pyric:sandbox:auth-session';

/** A signed-in session as web storage keeps it: its uid, the slot it came from, and its session key when saved with one. */
interface StoredSession {
  uid: string;
  mode: 'LOCAL' | 'SESSION';
  sessionKey?: string;
}

function sessionStorageKey(serviceName: string): string {
  const isDefaultAuth = serviceName === 'auth' || serviceName === 'auth-session:[DEFAULT]';
  if (isDefaultAuth) return SESSION_STORAGE_KEY;
  return `${SESSION_STORAGE_KEY}:${encodeURIComponent(serviceName)}`;
}

interface SessionPersistence {
  attachSessionSubscription(name: string, hooks: PersistableService): void;
  restoreSessionForService(name: string, hooks: PersistableService): void;
  loadAndRememberPending(name: string): void;
  unregisterService(name: string): void;
  dispose(): void;
}

/**
 * Owns per-service auth session persistence in web storage (`local` and
 * `session`). Each registered session provider owns a distinct web-storage
 * key so named Firebase app sessions stay independent while their service
 * state remains in one shared sandbox persistence blob.
 */
export function createSessionPersistence(
  sessionStorage: SandboxPersistenceOptions['sessionStorage'],
): SessionPersistence {
  const sessionUnsubs = new Map<string, () => void>();
  const pendingSessions = new Map<string, StoredSession>();

  const saveSession = (
    name: string,
    sessionHooks: NonNullable<PersistableService['session']>,
  ): void => {
    if (!sessionStorage) return;
    const { local, session } = sessionStorage;
    const key = sessionStorageKey(name);
    const uid = sessionHooks.currentUid();
    const mode = sessionHooks.mode();
    if (uid === null || mode === 'NONE') {
      local.removeItem(key);
      session.removeItem(key);
      return;
    }
    const sessionKey = sessionHooks.sessionKey?.();
    const record = sessionKey === undefined ? { uid } : { uid, sessionKey };
    const payload = JSON.stringify(record);
    if (mode === 'LOCAL') {
      session.removeItem(key);
      local.setItem(key, payload);
    } else {
      local.removeItem(key);
      session.setItem(key, payload);
    }
  };

  const loadStoredSession = (name: string): StoredSession | null => {
    if (!sessionStorage) return null;
    const key = sessionStorageKey(name);
    const stores = [
      ['LOCAL', sessionStorage.local],
      ['SESSION', sessionStorage.session],
    ] as const;
    for (const [mode, store] of stores) {
      const raw = store.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { uid?: unknown; sessionKey?: unknown };
        if (typeof parsed?.uid !== 'string') continue;
        const sessionKey = typeof parsed.sessionKey === 'string' ? parsed.sessionKey : undefined;
        return { uid: parsed.uid, mode, sessionKey };
      } catch {
        // Corrupt web-storage entry: remove it and continue checking remaining stores.
        store.removeItem(key);
      }
    }
    return null;
  };

  const clearStoredSession = (name: string): void => {
    if (!sessionStorage) return;
    const key = sessionStorageKey(name);
    sessionStorage.local.removeItem(key);
    sessionStorage.session.removeItem(key);
  };

  const tryRestoreSession = (
    name: string,
    stored: StoredSession,
    hooks: PersistableService,
  ): void => {
    if (!hooks.session) return;
    try {
      hooks.session.restore(stored.uid, stored.mode, stored.sessionKey);
      pendingSessions.delete(name);
    } catch (error) {
      console.warn(
        `[sandbox/persistence] session restore for uid '${stored.uid}' failed -- clearing stored session:`,
        error,
      );
      clearStoredSession(name);
      pendingSessions.delete(name);
    }
  };

  return {
    attachSessionSubscription(name, hooks) {
      if (!sessionStorage || !hooks.session || sessionUnsubs.has(name)) return;
      const sessionHooks = hooks.session;
      sessionUnsubs.set(name, sessionHooks.subscribe(() => saveSession(name, sessionHooks)));
    },
    restoreSessionForService(name, hooks) {
      if (!hooks.session) return;
      const stored = pendingSessions.get(name) ?? loadStoredSession(name);
      if (stored) tryRestoreSession(name, stored, hooks);
    },
    loadAndRememberPending(name) {
      const stored = loadStoredSession(name);
      if (stored !== null) pendingSessions.set(name, stored);
    },
    unregisterService(name) {
      sessionUnsubs.get(name)?.();
      sessionUnsubs.delete(name);
      pendingSessions.delete(name);
    },
    dispose() {
      for (const unsub of sessionUnsubs.values()) unsub();
      sessionUnsubs.clear();
    },
  };
}
