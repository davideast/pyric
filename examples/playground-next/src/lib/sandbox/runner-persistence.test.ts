/**
 * Per-session workspace sandbox persistence — through the REAL
 * `SandboxRunner`, not the pyric controller in isolation.
 *
 * Covers the gates for step-SESSIONS-p3:
 *   - round-trip: seed → flush → fresh runner with the same key →
 *     data present (both explicit flush and the runner's debounced
 *     admin-write flush, since admin writes emit no sandbox events);
 *   - per-session key isolation: two session keys on one backend
 *     never see each other's data;
 *   - reset() clears the persisted blob (no resurrection on reload);
 *   - unrecognized legacy records are ignored and clean data still persists;
 *   - `getRunner()` derives `pyric:sandbox:{sessionId}` from the
 *     `?session={id}` URL param and stays ephemeral without one.
 *
 * Backends are injected (shared `Map`) — `createMemoryBackend()`
 * builds a fresh private Map per controller, which can't model "the
 * browser's IndexedDB surviving across page loads".
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { PersistenceBackend, WebStorageLike } from 'pyric/sandbox';
import { getAuth, createUserWithEmailAndPassword } from 'pyric/auth';
import { SandboxRunner, getRunner, disposeRunner } from './runner';

/** Map-backed WebStorageLike — the test analog of localStorage/sessionStorage
 *  persisting across reloads. */
function makeMemStorage(): WebStorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

// Other suites in this package shim `globalThis.window` partially
// (e.g. sandbox-headless's localStorage-only shim) and bun test files
// share one process. The persistence controller registers a
// `beforeunload` listener whenever `window` exists — make sure a
// partial shim left behind by an earlier file doesn't explode it.
{
  const w = (globalThis as unknown as { window?: Record<string, unknown> })
    .window;
  if (w && typeof w.addEventListener !== 'function') {
    w.addEventListener = () => {};
    w.removeEventListener = () => {};
  }
}

/** Shared-storage backend: one Map across many runner lifetimes — the
 *  test analog of IndexedDB persisting across page reloads. */
function makeSharedBackend(): PersistenceBackend & { store: Map<string, Map<string, unknown>> } {
  const store = new Map<string, Map<string, unknown>>();
  const bucket = (key: string) => {
    let records = store.get(key);
    if (!records) {
      records = new Map<string, unknown>();
      store.set(key, records);
    }
    return records;
  };
  return {
    store,
    async getRecord(key, recordId) {
      return store.get(key)?.get(recordId) ?? null;
    },
    async listRecords(key) {
      return [...(store.get(key)?.keys() ?? [])];
    },
    async putRecords(key, records) {
      const target = bucket(key);
      for (const [recordId, value] of records) target.set(recordId, value);
    },
    async deleteRecords(key, recordIds) {
      const target = store.get(key);
      if (!target) return;
      for (const recordId of recordIds) target.delete(recordId);
    },
    async clear(key) {
      store.delete(key);
    },
  };
}

const KEY_A = 'pyric:sandbox:session-a';
const KEY_B = 'pyric:sandbox:session-b';

function makeRunner(
  backend: PersistenceBackend,
  key: string,
  flushIntervalMs = 10,
): SandboxRunner {
  return new SandboxRunner({
    persistence: { key, injectedBackend: backend, flushIntervalMs },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Silence the one-line `[sandbox] … restored N doc(s)` status info
 *  (and return the spy so tests can assert on it). */
function quietInfo() {
  return spyOn(console, 'info').mockImplementation(() => {});
}

const liveRunners: SandboxRunner[] = [];
function track(r: SandboxRunner): SandboxRunner {
  liveRunners.push(r);
  return r;
}

afterEach(() => {
  for (const r of liveRunners.splice(0)) r.dispose();
});

describe('SandboxRunner auth persistence (the reported bug)', () => {
  it('persists auth users AND the signed-in session across a reload', async () => {
    const infoSpy = quietInfo();
    try {
      const backend = makeSharedBackend();
      const local = makeMemStorage();
      const session = makeMemStorage();
      const make = (): SandboxRunner =>
        new SandboxRunner({
          persistence: { key: KEY_A, injectedBackend: backend, flushIntervalMs: 10, sessionStorage: { local, session } },
        });

      // First "page load": sign a user up (createUser signs them in).
      const first = track(make());
      await first.ready;
      const auth1 = getAuth(first.getSandbox());
      await createUserWithEmailAndPassword(auth1, 'alice@example.com', 'pw123456');
      expect(auth1.currentUser?.email).toBe('alice@example.com');
      await sleep(40); // let the debounced user-DB flush + session save land

      // "Reload": fresh runner, SAME durable backend + SAME session storage.
      const second = track(make());
      await second.ready;
      const auth2 = getAuth(second.getSandbox());
      // The user DB survived (user exists) AND the session restored (signed in).
      expect(auth2.currentUser?.email).toBe('alice@example.com');
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('SandboxRunner per-session persistence', () => {
  it('round-trips seeded data into a fresh runner with the same key', async () => {
    const infoSpy = quietInfo();
    try {
      const backend = makeSharedBackend();

      // "Page load 1": seed through the runner's admin wrapper, flush.
      const first = track(makeRunner(backend, KEY_A));
      await first.ready;
      first.admin.setDocument('todos/t1', { title: 'persist me', done: false });
      await first.getSandbox().flush();

      // "Page load 2": same key, same storage → data restored.
      const second = track(makeRunner(backend, KEY_A));
      await second.ready;
      expect(second.readState()).toEqual({
        'todos/t1': { title: 'persist me', done: false },
      });
      // The restore status surfaced as the one console line.
      expect(
        infoSpy.mock.calls.some((c) =>
          String(c[0]).includes(`workspace persistence on '${KEY_A}'`),
        ),
      ).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('flushes admin writes without an explicit flush (debounced wrapper path)', async () => {
    const infoSpy = quietInfo();
    try {
      const backend = makeSharedBackend();
      const first = track(makeRunner(backend, KEY_A, 10));
      await first.ready;

      // Admin writes emit NO sandbox events — only the runner's
      // wrapper-scheduled flush can land them in the blob.
      first.admin.setDocument('users/u1', { name: 'Ada' });
      expect(backend.store.has(KEY_A)).toBe(false); // not yet (debounce)
      await sleep(60);
      expect(backend.store.has(KEY_A)).toBe(true);

      const second = track(makeRunner(backend, KEY_A));
      await second.ready;
      expect(second.readState()['users/u1']).toEqual({ name: 'Ada' });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('isolates sessions: two keys on one storage never bleed', async () => {
    const infoSpy = quietInfo();
    try {
      const backend = makeSharedBackend();

      const a = track(makeRunner(backend, KEY_A));
      await a.ready;
      a.admin.setDocument('docs/a', { from: 'a' });
      await a.getSandbox().flush();

      // Opening session B sees nothing of A.
      const b = track(makeRunner(backend, KEY_B));
      await b.ready;
      expect(b.readState()).toEqual({});
      b.admin.setDocument('docs/b', { from: 'b' });
      await b.getSandbox().flush();

      // Switching back: each session restores ONLY its own data.
      const a2 = track(makeRunner(backend, KEY_A));
      await a2.ready;
      expect(a2.readState()).toEqual({ 'docs/a': { from: 'a' } });
      const b2 = track(makeRunner(backend, KEY_B));
      await b2.ready;
      expect(b2.readState()).toEqual({ 'docs/b': { from: 'b' } });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('reset() clears the persisted blob — no resurrection on reload', async () => {
    const infoSpy = quietInfo();
    try {
      const backend = makeSharedBackend();
      const first = track(makeRunner(backend, KEY_A, 10));
      await first.ready;
      first.admin.setDocument('docs/x', { v: 1 });
      await first.getSandbox().flush();
      expect(backend.store.has(KEY_A)).toBe(true);

      await first.reset();
      expect(first.readState()).toEqual({}); // in-memory wiped
      // Wait past every debounce window: neither the runner's admin
      // timer nor the controller's session_boundary flush may
      // resurrect the blob.
      await sleep(60);
      expect(backend.store.has(KEY_A)).toBe(false);

      // "Reload after reset" comes up empty.
      const second = track(makeRunner(backend, KEY_A));
      await second.ready;
      expect(second.readState()).toEqual({});
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('ignores an unrecognized legacy blob and starts clean', async () => {
    const infoSpy = quietInfo();
    try {
      const backend = makeSharedBackend();
      await backend.putRecords(KEY_A, new Map([['legacy', '{definitely not json']]));

      const runner = track(makeRunner(backend, KEY_A));
      await runner.ready;

      // Clean start. The unrecognized legacy record is ignored, not restored.
      expect(runner.readState()).toEqual({});
      expect(await backend.getRecord(KEY_A, 'legacy')).toBe('{definitely not json');

      // And the session still persists normally afterwards.
      runner.admin.setDocument('docs/fresh', { ok: true });
      await runner.getSandbox().flush();
      const second = track(makeRunner(backend, KEY_A));
      await second.ready;
      expect(second.readState()).toEqual({ 'docs/fresh': { ok: true } });
      expect(await backend.getRecord(KEY_A, 'legacy')).toBe('{definitely not json');
    } finally {
      infoSpy.mockRestore();
    }
  });

});

describe('getRunner() session key derivation', () => {
  const g = globalThis as { window?: unknown };

  it('derives pyric:sandbox:{sessionId} from ?session= and stays ephemeral without it', async () => {
    const infoSpy = quietInfo();
    const priorWindow = g.window;
    try {
      // With a session id in the URL → per-session key. (No real
      // IndexedDB in bun; the controller falls back to memory, which
      // is fine — we only assert the key derivation here. The
      // listener no-ops satisfy the controller's beforeunload wiring.)
      g.window = {
        location: { search: '?session=abc-123' },
        addEventListener() {},
        removeEventListener() {},
      };
      disposeRunner();
      const keyed = getRunner();
      expect(keyed.persistenceKey).toBe('pyric:sandbox:abc-123');
      await keyed.ready;

      // Without one (home page, headless window shims) → ephemeral.
      g.window = {
        location: { search: '' },
        addEventListener() {},
        removeEventListener() {},
      };
      disposeRunner();
      const ephemeral = getRunner();
      expect(ephemeral.persistenceKey).toBeNull();
      await ephemeral.ready;
    } finally {
      disposeRunner();
      if (priorWindow === undefined) delete g.window;
      else g.window = priorWindow;
      infoSpy.mockRestore();
    }
  });
});
