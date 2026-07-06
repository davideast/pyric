/**
 * Seed-apply logic for the host data-seed panel (SF-S2).
 *
 * Two layers, both headless (no DOM — the panel is a thin shell over
 * this module):
 *
 *   1. Pure parse/apply/clear logic against a fake admin surface
 *      (fast, exhaustive over the JSON shapes + partial-failure path).
 *   2. The gate's session-scoping property through the REAL
 *      `SandboxRunner` with a shared persistence backend (the
 *      runner-persistence test's IndexedDB analog): seed via the panel
 *      path → a fresh runner on the SAME key restores it (persists),
 *      a runner on a DIFFERENT key never sees it (session-switch =
 *      gone).
 */
import { describe, expect, it } from 'bun:test';
import type { PersistenceBackend } from 'pyric/sandbox';
import { SandboxRunner } from './runner';
import {
  applySeed,
  clearCollection,
  generateDocId,
  isValidCollectionId,
  isValidDocId,
  listSeeded,
  parseSeedJson,
  type AdminSeedSurface,
} from './seed-apply';

// A bun-test file shares one process with the rest of the package; an
// earlier suite may have left a partial `window` shim. The persistence
// controller registers a `beforeunload` listener whenever `window`
// exists — make sure a partial shim doesn't explode it.
{
  const w = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (w && typeof w.addEventListener !== 'function') {
    w.addEventListener = () => {};
    w.removeEventListener = () => {};
  }
}

/** In-memory admin surface — the unit-test fake for the pure logic. */
function makeFakeAdmin(): AdminSeedSurface & { store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    setDocument(path, data) {
      store.set(path, data);
    },
    deleteDocument(path) {
      const had = store.delete(path);
      return { deleted: had };
    },
    listDocuments(prefix) {
      const out: { path: string; data: unknown }[] = [];
      for (const [path, data] of store.entries()) {
        // Only direct children of `prefix` (one path segment after it).
        if (path.startsWith(`${prefix}/`) && path.slice(prefix.length + 1).indexOf('/') === -1) {
          out.push({ path, data });
        }
      }
      return out;
    },
  };
}

// --------------------------------------------------------------------------
// Validation + id generation

describe('id validation', () => {
  it('rejects empty / slashed / dot collection ids', () => {
    expect(isValidCollectionId('menuItems')).toBe(true);
    expect(isValidCollectionId('  ')).toBe(false);
    expect(isValidCollectionId('a/b')).toBe(false);
    expect(isValidCollectionId('.')).toBe(false);
    expect(isValidCollectionId('..')).toBe(false);
  });

  it('rejects empty / slashed doc ids', () => {
    expect(isValidDocId('abc')).toBe(true);
    expect(isValidDocId('')).toBe(false);
    expect(isValidDocId('a/b')).toBe(false);
  });

  it('generates collision-resistant ids', () => {
    const a = generateDocId();
    const b = generateDocId();
    expect(a).not.toBe(b);
    expect(isValidDocId(a)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// JSON parsing

describe('parseSeedJson', () => {
  it('parses an object keyed by doc id', () => {
    const r = parseSeedJson('{ "a": { "x": 1 }, "b": { "y": 2 } }');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.docs).toEqual([
        { id: 'a', data: { x: 1 } },
        { id: 'b', data: { y: 2 } },
      ]);
    }
  });

  it('parses an array of bodies (auto ids)', () => {
    const r = parseSeedJson('[ { "x": 1 }, { "y": 2 } ]');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.docs.map((d) => d.id)).toEqual(['', '']);
      expect(r.docs.map((d) => d.data)).toEqual([{ x: 1 }, { y: 2 }]);
    }
  });

  it('lifts an `id` field out of an array entry', () => {
    const r = parseSeedJson('[ { "id": "latte", "price": 5 } ]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.docs).toEqual([{ id: 'latte', data: { price: 5 } }]);
  });

  it('rejects malformed JSON', () => {
    const r = parseSeedJson('{ not json');
    expect(r.ok).toBe(false);
  });

  it('rejects a top-level non-object/array', () => {
    expect(parseSeedJson('42').ok).toBe(false);
    expect(parseSeedJson('"x"').ok).toBe(false);
  });

  it('rejects empty input', () => {
    expect(parseSeedJson('   ').ok).toBe(false);
  });

  it('rejects an invalid key as a doc id', () => {
    expect(parseSeedJson('{ "a/b": {} }').ok).toBe(false);
  });

  it('rejects a non-object array entry', () => {
    expect(parseSeedJson('[ 1, 2 ]').ok).toBe(false);
  });
});

// --------------------------------------------------------------------------
// applySeed / clearCollection / listSeeded — pure logic

describe('applySeed', () => {
  it('writes docs at collection/id, generating ids when blank', () => {
    const admin = makeFakeAdmin();
    const r = applySeed(admin, 'menuItems', [
      { id: 'latte', data: { price: 5 } },
      { id: '', data: { price: 3 } },
    ]);
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(0);
    expect(admin.store.get('menuItems/latte')).toEqual({ price: 5 });
    // auto-id doc exists under the collection
    const autoKeys = [...admin.store.keys()].filter((k) => k !== 'menuItems/latte');
    expect(autoKeys).toHaveLength(1);
    expect(autoKeys[0]?.startsWith('menuItems/')).toBe(true);
  });

  it('rejects every doc when the collection id is invalid', () => {
    const admin = makeFakeAdmin();
    const r = applySeed(admin, 'a/b', [{ id: 'x', data: {} }]);
    expect(r.applied).toBe(0);
    expect(r.failed).toBe(1);
    expect(admin.store.size).toBe(0);
  });

  it('collects per-doc errors without sinking the batch', () => {
    const admin = makeFakeAdmin();
    // setDocument throws on one specific path
    const throwing: AdminSeedSurface = {
      ...admin,
      setDocument(path, data) {
        if (path.endsWith('/bad')) throw new Error('boom');
        admin.setDocument(path, data);
      },
    };
    const r = applySeed(throwing, 'c', [
      { id: 'ok', data: { a: 1 } },
      { id: 'bad', data: { a: 2 } },
    ]);
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors[0]?.id).toBe('bad');
    expect(admin.store.has('c/ok')).toBe(true);
  });
});

describe('listSeeded + clearCollection', () => {
  it('summarizes seeded docs and clears them', () => {
    const admin = makeFakeAdmin();
    applySeed(admin, 'menuItems', [
      { id: 'a', data: { x: 1, y: 2 } },
      { id: 'b', data: { z: 3 } },
    ]);
    const seeded = listSeeded(admin, 'menuItems');
    expect(seeded).toEqual([
      { id: 'a', fieldCount: 2 },
      { id: 'b', fieldCount: 1 },
    ]);
    const cleared = clearCollection(admin, 'menuItems');
    expect(cleared).toBe(2);
    expect(listSeeded(admin, 'menuItems')).toEqual([]);
  });

  it('skips phantom parents when clearing', () => {
    const admin = makeFakeAdmin();
    admin.setDocument('c/real', { a: 1 });
    const withPhantom: AdminSeedSurface = {
      ...admin,
      listDocuments() {
        return [
          { path: 'c/real', data: { a: 1 } },
          { path: 'c/ghost', data: {}, phantom: true },
        ];
      },
    };
    const cleared = clearCollection(withPhantom, 'c');
    expect(cleared).toBe(1);
  });
});

// --------------------------------------------------------------------------
// The gate: session-scoped + ephemeral, through the REAL runner.
//
// Shared backend = the IndexedDB-survives-reload analog (same trick the
// runner-persistence suite uses). Seeding via the panel's apply path
// must: (a) persist for the SAME session key across a fresh runner;
// (b) be invisible to a DIFFERENT session key.

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

function makeRunner(backend: PersistenceBackend, key: string): SandboxRunner {
  return new SandboxRunner({
    persistence: { key, injectedBackend: backend, flushIntervalMs: 5 },
  });
}

describe('seed-apply through the real runner (session scope + persistence)', () => {
  it('persists seeded data for the same session across a fresh runner', async () => {
    const backend = makeSharedBackend();

    const r1 = makeRunner(backend, KEY_A);
    await r1.ready;
    const result = applySeed(r1.admin, 'menuItems', [{ id: 'latte', data: { price: 5 } }]);
    expect(result.applied).toBe(1);
    // Flush the debounced persist (runner schedules it on admin write).
    await r1.getSandbox().flush();
    r1.dispose();

    // Fresh runner, SAME key → restored.
    const r2 = makeRunner(backend, KEY_A);
    await r2.ready;
    expect(r2.admin.getDocument('menuItems/latte')).toEqual({ price: 5 });
    expect(listSeeded(r2.admin, 'menuItems')).toEqual([{ id: 'latte', fieldCount: 1 }]);
    r2.dispose();
  });

  it('does not leak across sessions (switch session → gone)', async () => {
    const backend = makeSharedBackend();

    const rA = makeRunner(backend, KEY_A);
    await rA.ready;
    applySeed(rA.admin, 'menuItems', [{ id: 'latte', data: { price: 5 } }]);
    await rA.getSandbox().flush();
    rA.dispose();

    // Different session key → the seeded collection is absent.
    const rB = makeRunner(backend, KEY_B);
    await rB.ready;
    expect(rB.admin.getDocument('menuItems/latte')).toBeNull();
    expect(listSeeded(rB.admin, 'menuItems')).toEqual([]);
    rB.dispose();
  });

  it('clear removes seeded data and the clear persists', async () => {
    const backend = makeSharedBackend();

    const r1 = makeRunner(backend, KEY_A);
    await r1.ready;
    applySeed(r1.admin, 'menuItems', [
      { id: 'a', data: { x: 1 } },
      { id: 'b', data: { y: 2 } },
    ]);
    await r1.getSandbox().flush();
    expect(clearCollection(r1.admin, 'menuItems')).toBe(2);
    await r1.getSandbox().flush();
    r1.dispose();

    const r2 = makeRunner(backend, KEY_A);
    await r2.ready;
    expect(listSeeded(r2.admin, 'menuItems')).toEqual([]);
    r2.dispose();
  });
});
