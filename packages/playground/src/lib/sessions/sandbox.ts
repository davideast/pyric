/**
 * Dedicated sandbox for playground sessions. Lives separately from the
 * workspace sandbox (`lib/sandbox/runner.ts`) because the two have
 * conflicting rules requirements:
 *
 *   - Workspace sandbox: rules are the **subject under test**. The
 *     user iterates on them, the simulator denies/allows, the UI shows
 *     the trace. Empty rules are a meaningful starting state.
 *   - Sessions sandbox: rules need to permit reads/writes at the
 *     sessions collection unconditionally — sessions are internal
 *     plumbing, not something the user authors against.
 *
 * Sharing one sandbox would force the user's WIP rules to also gate
 * session storage, breaking the home page list whenever they're
 * mid-edit. A dedicated sandbox with a permanent open ruleset keeps
 * the boundary clean: workspace data and session metadata are
 * independent persisted stores.
 *
 * Persistence key: `pyric:playground:sessions`. Different from any
 * future workspace persistence so the two stores can be cleared
 * independently.
 */

import {
  createIndexedDBBackend,
  initializeSandbox,
  type PersistenceBackend,
  type Sandbox,
} from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getFirestore, type Firestore } from 'pyric/firestore';
import { isSessionWriter } from './writer-lock';

/** IndexedDB database name for sessions persistence. */
const SESSIONS_PERSISTENCE_KEY = 'pyric:playground:sessions';

/**
 * Wrap a persistence backend so writes only land while THIS tab is the
 * session writer (see `writer-lock.ts`). The persistence controller
 * flushes the ENTIRE sandbox snapshot — including its unconditional
 * `beforeunload` flush — so a read-only tab flushing its stale
 * in-memory copy would silently revert everything the writer tab
 * saved since this tab loaded. Gating at the backend boundary catches
 * every flush path with one check, evaluated at write time so a
 * take-over immediately re-enables writes.
 *
 * Reads are never gated — read-only tabs still restore and display.
 */
export function writerGatedBackend(real: PersistenceBackend): PersistenceBackend {
  return {
    // Reads are never gated — read-only tabs still restore + display.
    getRecord: (key, recordId) => real.getRecord(key, recordId),
    listRecords: (key) => real.listRecords(key),
    // Writes land only while THIS tab holds the session writer lock.
    putRecords: (key, records) =>
      isSessionWriter() ? real.putRecords(key, records) : Promise.resolve(),
    deleteRecords: (key, recordIds) =>
      isSessionWriter() ? real.deleteRecords(key, recordIds) : Promise.resolve(),
    clear: (key) => (isSessionWriter() ? real.clear(key) : Promise.resolve()),
  };
}

/**
 * Open ruleset deployed at construction. Permits reads and writes on
 * every path; the sessions module only ever touches paths under
 * `pyric/playground/sessions/{userId}/items` so a blanket allow is
 * fine — nothing else writes to this sandbox.
 */
const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

class SessionsSandbox {
  private sandbox: Sandbox;
  private db: Firestore;
  /**
   * Resolves once the persistence backend has restored any prior
   * snapshot into the live sandbox. Callers that subscribe to the
   * session list should `await ready` first — otherwise the initial
   * onSnapshot fires against an empty pre-restore state and produces
   * a brief flash of "no sessions" before the real list populates.
   */
  readonly ready: Promise<void>;

  constructor() {
    this.sandbox = initializeSandbox();
    this.db = getFirestore(this.sandbox);
    // Deploy the open ruleset before any reads/writes. `seed()` is
    // the only entry that initializes rulesSource on a fresh
    // LocalEnvironment; `deployRules()` requires an existing parsed
    // ruleset to re-evaluate listeners against. Either works on a
    // pristine env — seed is the documented init path.
    getInternalEnv(this.sandbox).seed({ rules: OPEN_RULES });
    // Fire-and-forget the persistence enable; the resulting promise is
    // exposed as `ready` so callers can await restoration before they
    // read. Persistence failures are non-fatal — log and proceed with
    // an empty in-memory store.
    //
    // In the browser the IndexedDB backend is wrapped in the
    // writer-gate (see `writerGatedBackend`); outside the browser
    // (`typeof indexedDB === 'undefined'`) we pass no backend and the
    // controller falls back to its in-memory backend exactly as
    // before.
    this.ready = this.sandbox
      .enablePersistence({
        key: SESSIONS_PERSISTENCE_KEY,
        ...(typeof indexedDB !== 'undefined'
          ? { injectedBackend: writerGatedBackend(createIndexedDBBackend()) }
          : {}),
      })
      .catch((e) => {
        console.warn('[sessions] sandbox persistence failed to enable:', e);
      });
  }

  getSandbox(): Sandbox {
    return this.sandbox;
  }

  getDb(): Firestore {
    return this.db;
  }

  dispose(): void {
    this.sandbox.dispose();
  }
}

let instance: SessionsSandbox | null = null;

export function getSessionsSandbox(): SessionsSandbox {
  if (!instance) instance = new SessionsSandbox();
  return instance;
}

/** Tear down the singleton. Used by tests for isolation. */
export function disposeSessionsSandbox(): void {
  instance?.dispose();
  instance = null;
}
