import { describe, expect, it } from 'bun:test';
import {
  EMPTY_OBSERVED_SNAPSHOT,
  buildObservedSeedPayload,
  parseObservedSessionSnapshot,
} from '../../src/shell/observed-session-parse.js';

const fullStats = {
  firestoreDocs: 1,
  rtdbInstances: 2,
  byteEstimate: 64,
  truncated: false,
  droppedCount: 0,
};

describe('parseObservedSessionSnapshot', () => {
  it('rejects a payload that is not a JSON object', () => {
    expect(() => parseObservedSessionSnapshot(null)).toThrow('expected JSON object');
    expect(() => parseObservedSessionSnapshot([])).toThrow('expected JSON object');
  });

  it('reads a well-formed snapshot field for field', () => {
    const raw = {
      revision: 7,
      updatedAt: 1000,
      projectId: 'demo-project',
      firestore: { 'items/a': { name: 'A' } },
      rtdb: { 'demo-default-rtdb': { rooms: { r1: true } } },
      defaultRtdbInstance: 'demo-default-rtdb',
      stats: fullStats,
    };
    expect(parseObservedSessionSnapshot(raw)).toEqual(raw);
  });

  it('defaults missing fields and derives counts from the parsed data', () => {
    const parsed = parseObservedSessionSnapshot({
      firestore: { 'items/a': { n: 1 }, 'items/b': { n: 2 } },
      rtdb: { inst: { k: 1 } },
    });
    expect(parsed.revision).toBe(0);
    expect(parsed.updatedAt).toBeNull();
    expect(parsed.projectId).toBe('');
    expect(parsed.defaultRtdbInstance).toBeNull();
    expect(parsed.stats).toEqual({
      firestoreDocs: 2,
      rtdbInstances: 1,
      byteEstimate: 0,
      truncated: false,
      droppedCount: 0,
    });
  });

  it('drops prototype keys, non-object documents, and empty RTDB trees', () => {
    const raw = JSON.parse(
      '{"firestore":{"__proto__":{"x":1},"items/a":{"ok":true},"items/b":5},"rtdb":{"constructor":{},"a":null,"b":{"k":1}}}',
    );
    const parsed = parseObservedSessionSnapshot(raw);
    expect(Object.keys(parsed.firestore)).toEqual(['items/a']);
    expect(Object.keys(parsed.rtdb)).toEqual(['b']);
  });

  it('keeps skips only when something was skipped', () => {
    const none = parseObservedSessionSnapshot({
      skips: { oversized: 0, unsupported: 0, truncated: 0, failed: 0, admin: 0 },
    });
    expect('skips' in none).toBe(false);

    const some = parseObservedSessionSnapshot({ skips: { truncated: 2 } });
    expect(some.skips).toEqual({ oversized: 0, unsupported: 0, truncated: 2, failed: 0, admin: 0 });
  });

  it('keeps sources only when client or admin has contributed', () => {
    const emptySources = parseObservedSessionSnapshot({
      sources: { client: false, admin: false },
    });
    expect('sources' in emptySources).toBe(false);

    const malformed = parseObservedSessionSnapshot({ sources: 'admin' });
    expect('sources' in malformed).toBe(false);

    const adminOnly = parseObservedSessionSnapshot({
      sources: { client: false, admin: true },
    });
    expect(adminOnly.sources).toEqual({ client: false, admin: true });

    const both = parseObservedSessionSnapshot({
      sources: { client: true, admin: true },
    });
    expect(both.sources).toEqual({ client: true, admin: true });
  });

  it('parses optional storage catalog with sources/skips preserved and omits storage from seed payloads', () => {
    const parsed = parseObservedSessionSnapshot({
      projectId: 'demo-project',
      defaultStorageBucket: 'demo-project.firebasestorage.app',
      sources: { client: true, admin: true },
      skips: { failed: 1 },
      storage: {
        'demo-project.firebasestorage.app': {
          prefixes: ['items'],
          objects: {
            'items/a.png': {
              bucket: 'demo-project.firebasestorage.app',
              fullPath: 'items/a.png',
              name: 'a.png',
              size: 128,
            },
          },
        },
      },
    });
    expect(parsed.sources).toEqual({ client: true, admin: true });
    expect(parsed.skips).toEqual({ oversized: 0, unsupported: 0, truncated: 0, failed: 1, admin: 0 });
    expect(parsed.stats.storageBuckets).toBe(1);
    expect(parsed.stats.storageObjects).toBe(1);
    expect(parsed.defaultStorageBucket).toBe('demo-project.firebasestorage.app');
    expect(parsed.storage?.['demo-project.firebasestorage.app']?.objects['items/a.png']?.size).toBe(128);
    expect(buildObservedSeedPayload(parsed)).toEqual({ firestore: {} });
  });
});

describe('buildObservedSeedPayload', () => {
  const snapshot = {
    ...EMPTY_OBSERVED_SNAPSHOT,
    firestore: { 'users/u1': { name: 'One' } },
    rtdb: { primary: { rooms: { r1: true } }, secondary: { items: { i1: 1 } }, scalar: 3 },
    defaultRtdbInstance: 'primary',
  };

  it('holds only Firestore documents for an empty snapshot', () => {
    expect(buildObservedSeedPayload(EMPTY_OBSERVED_SNAPSHOT)).toEqual({ firestore: {} });
  });

  it('uses the default RTDB instance when none is chosen', () => {
    expect(buildObservedSeedPayload(snapshot)).toEqual({
      firestore: { 'users/u1': { name: 'One' } },
      database: { rooms: { r1: true } },
    });
  });

  it('uses the chosen RTDB instance over the default', () => {
    expect(buildObservedSeedPayload(snapshot, 'secondary').database).toEqual({ items: { i1: 1 } });
  });

  it('omits the database when the chosen tree is not an object', () => {
    expect('database' in buildObservedSeedPayload(snapshot, 'scalar')).toBe(false);
    expect('database' in buildObservedSeedPayload(snapshot, 'missing')).toBe(false);
  });
});
