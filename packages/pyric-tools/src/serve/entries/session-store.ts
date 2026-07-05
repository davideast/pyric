/**
 * Auth session persistence for `pyric serve` — the one genuine
 * client-fidelity item in the persistence model (flow doc §3c): real
 * Firebase keeps you signed in across reloads by DEFAULT
 * (`browserLocalPersistence`), so the served sandbox does too.
 *
 * The user *database* persists with the substrate (`--persist`); the
 * *session* persists like the real client — independent of data mode, in
 * web storage, honoring `setPersistence` semantics:
 *
 *   LOCAL  (default) → localStorage     (survives reload + browser restart)
 *   SESSION          → sessionStorage   (survives reload, not the tab)
 *   NONE             → nothing stored
 *
 * A restored session only resolves when the referenced uid still exists in
 * the sandbox user DB — so ephemeral mode drops helper-created sessions on
 * reload, consistently (`sandbox.restoreSession` throws, we clear).
 *
 * Pure over injected Storage objects so the logic is bun-testable; the
 * browser wiring (real storages, `onAuthStateChanged` recording, restore at
 * init) lives in the entries that import this.
 */

export type SessionMode = 'LOCAL' | 'SESSION' | 'NONE';

const KEY = 'pyric:serve:auth-session';

export interface SessionStores {
  local: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export interface StoredSession {
  uid: string;
}

export class SessionStore {
  private mode: SessionMode = 'LOCAL'; // firebase's default persistence

  constructor(private readonly stores: SessionStores) {}

  /** `setPersistence` parity: switch the backing store and MIGRATE any
   *  current session into it (the real SDK carries the session over). */
  setMode(mode: SessionMode): void {
    const current = this.load();
    this.clear();
    this.mode = mode;
    if (current) this.save(current.uid);
  }

  save(uid: string): void {
    this.clear(); // a session lives in exactly one store
    if (this.mode === 'NONE') return;
    this.backing().setItem(KEY, JSON.stringify({ uid } satisfies StoredSession));
  }

  /** Reads BOTH storages (localStorage first — matches lookup order when a
   *  prior page used a different mode). */
  load(): StoredSession | null {
    for (const store of [this.stores.local, this.stores.session]) {
      const raw = store.getItem(KEY);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as StoredSession;
        if (parsed && typeof parsed.uid === 'string') return parsed;
      } catch {
        store.removeItem(KEY); // corrupt → drop, never throw at page init
      }
    }
    return null;
  }

  clear(): void {
    this.stores.local.removeItem(KEY);
    this.stores.session.removeItem(KEY);
  }

  private backing(): SessionStores['local'] {
    return this.mode === 'SESSION' ? this.stores.session : this.stores.local;
  }
}
