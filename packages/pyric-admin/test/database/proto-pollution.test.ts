/**
 * Prototype-pollution regression — `pyric-admin/database` sandbox RTDB.
 * See issue #762 (twin of the `pyric/database` DataTree fixed in #760).
 *
 * `writePath`/`readPath` walk caller-controlled `/`-separated segments into
 * a plain JS object tree via `pathSegments`. A path like
 * `/__proto__/polluted` (paths ride in via JSON/MCP transports) would
 * otherwise resolve `__proto__` to the shared `Object.prototype` and let a
 * rule-bypass admin write poison it process-wide. `pathSegments` now
 * rejects `__proto__`/`prototype`/`constructor`, and the walks read
 * own-only.
 */
import { afterEach, describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { initializeApp, deleteApp, getApps } from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';

// Deregister the unnamed default app after each test (the registry is
// module-global, mirroring firebase-admin's defaultAppStore).
afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function makeDb() {
  const app = initializeApp({ sandbox: initializeSandbox() });
  return getDatabase(app);
}

describe('pyric-admin/database sandbox — prototype-pollution guard', () => {
  test('set() through a `__proto__` segment does NOT pollute Object.prototype', () => {
    const db = makeDb();
    // `pathSegments` rejects the segment as the ref is built — the walk
    // never reaches (let alone writes through) the shared prototype.
    expect(() => db.ref('/__proto__/polluted').set(true)).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('update() through a `constructor` segment is rejected', async () => {
    const db = makeDb();
    await expect(
      db.ref('/users').update({ 'constructor/polluted': true }),
    ).rejects.toThrow(/constructor/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('child() with a `prototype` segment is rejected', () => {
    const db = makeDb();
    expect(() => db.ref('/a').child('prototype')).toThrow(/prototype/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('read of a `__proto__` path is rejected (never reaches the prototype)', () => {
    const db = makeDb();
    expect(() => db.ref('/__proto__').get()).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('legitimate nested writes + reads still work', async () => {
    const db = makeDb();
    await db.ref('/rooms/lobby').set({ topic: 'hello', count: 2 });
    const snap = await db.ref('/rooms/lobby').get();
    expect(snap.val()).toEqual({ topic: 'hello', count: 2 });

    await db.ref('/rooms/lobby').update({ count: 3 });
    const snap2 = await db.ref('/rooms/lobby/count').get();
    expect(snap2.val()).toBe(3);
  });
});
