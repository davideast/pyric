import { describe, test, expect } from 'bun:test';
import {
  decodeImportBundle,
} from '../../src/sandbox/persistence/import-bundle.js';
import { validateRtdbImportRecord } from '../../src/sandbox/persistence/rtdb-records.js';
import {
  persistedServiceHasData,
  validatePersistedService,
} from '../../src/sandbox/persistence/validate-services.js';
import {
  bundleRecords,
  pathToBucketId,
  serializeToBuckets,
  deserializeFromBuckets,
  parseBundle,
  migrateV2ToRecords,
  BUCKET_COUNT,
  META_RECORD_ID,
  CHUNK_FORMAT_VERSION,
  type MetaRecord,
  type BucketRecord,
} from '../../src/sandbox/persistence/chunk-format.js';
import { serializeSnapshot } from '../../src/sandbox/persistence/serialize.js';

describe('v2 -> v3 migration (C4)', () => {
  test('migrateV2ToRecords converts a legacy snapshot blob to v3 records', () => {
    const v2 = serializeSnapshot({ 'users/u1': { name: 'Alice' } }, { auth: { x: 1 } });
    const records = migrateV2ToRecords(v2);
    expect(records).not.toBeNull();
    const out = deserializeFromBuckets([...records!]);
    expect(out.firestore['users/u1']).toEqual({ name: 'Alice' });
    expect(out.services).toEqual({ auth: { x: 1 } });
  });

  test('migrateV2ToRecords returns null for a non-v2 blob', () => {
    expect(migrateV2ToRecords('not json')).toBeNull();
    expect(migrateV2ToRecords('{"unrelated":true}')).toBeNull();
  });

  test('parseBundle migrates a legacy v2 blob (serve committable file path)', () => {
    const v2 = serializeSnapshot({ 'posts/p1': { title: 'Hi' } });
    const records = parseBundle(v2);
    expect(deserializeFromBuckets([...records]).firestore['posts/p1']).toEqual({ title: 'Hi' });
  });

  test('migrateV2ToRecords, parseBundle, and decodeImportBundle partition legacy plain-tree services.rtdb into rtdb:* records', () => {
    const legacyV2 = serializeSnapshot(
      { 'docs/d1': { title: 'alpha' } },
      { rtdb: { users: { u1: { name: 'Alice' } } } },
    );
    const records = parseBundle(legacyV2);
    expect((records.get(META_RECORD_ID) as MetaRecord).services).not.toHaveProperty('rtdb');
    expect([...records.keys()].some((id) => id.startsWith('rtdb:'))).toBe(true);

    const decoded = deserializeFromBuckets(records);
    expect(decoded.firestore).toEqual({ 'docs/d1': { title: 'alpha' } });
    expect(decoded.services.rtdb).toEqual({
      '.pyricRtdbPersistence': 1,
      data: { users: { u1: { name: 'Alice' } } },
      priorities: {},
    });

    const imported = decodeImportBundle(legacyV2);
    expect(imported.services.rtdb).toEqual({
      '.pyricRtdbPersistence': 1,
      data: { users: { u1: { name: 'Alice' } } },
      priorities: {},
    });
  });
});

describe('per-bucket checksum quarantine (C5)', () => {
  test('serializeToBuckets sets a checksum on each bucket', () => {
    const records = serializeToBuckets({ 'a/1': { v: 1 } }, {}, 0);
    const bucket = records.get(pathToBucketId('a/1')) as BucketRecord;
    expect(typeof bucket.checksum).toBe('number');
  });

  test('a corrupted bucket (checksum mismatch) is quarantined; valid buckets survive', () => {
    const records = serializeToBuckets({ 'a/1': { v: 1 }, 'b/1': { v: 2 } }, {}, 0);
    const idA = pathToBucketId('a/1');
    const idB = pathToBucketId('b/1');
    // Tamper one bucket's docs but leave its (now stale) checksum.
    (records.get(idA) as BucketRecord).docs['a/1'] = { v: 999 };

    const out = deserializeFromBuckets([...records]);
    expect(out.firestore['a/1']).toBeUndefined(); // corrupt bucket dropped
    if (idA !== idB) expect(out.firestore['b/1']).toEqual({ v: 2 }); // others intact
  });

  test('a record without a checksum is accepted (backward-compat)', () => {
    const records = new Map<string, unknown>([['00', { docs: { 'a/1': { v: 1 } } }]]);
    expect(deserializeFromBuckets([...records]).firestore['a/1']).toEqual({ v: 1 });
  });
});

describe('pathToBucketId', () => {
  test('is stable and in range', () => {
    const id = pathToBucketId('users/u1');
    expect(id).toBe(pathToBucketId('users/u1'));
    expect(id).toMatch(/^[0-9a-f]{2}$/);
    const n = parseInt(id, 16);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(BUCKET_COUNT);
  });

  test('distributes across many buckets', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(pathToBucketId(`col/doc${i}`));
    // 2000 distinct paths should spread across most of the 256 buckets.
    expect(ids.size).toBeGreaterThan(200);
  });
});

describe('serializeToBuckets / deserializeFromBuckets', () => {
  test('round-trips firestore docs and services', () => {
    const firestore = {
      'users/u1': { name: 'Alice', age: 30 },
      'users/u2': { name: 'Bob', tags: ['x', 'y'] },
      'posts/p1': { title: 'Hi', meta: { likes: 5 } },
    };
    const services = { auth: { users: [{ uid: 'u1' }] } };
    const records = serializeToBuckets(firestore, services, 1234);
    const out = deserializeFromBuckets(records);
    expect(out.firestore).toEqual(firestore);
    expect(out.services).toEqual(services);
  });

  test('emits a meta record carrying version + savedAt', () => {
    const records = serializeToBuckets({ 'a/b': { v: 1 } }, {}, 999);
    const meta = records.get(META_RECORD_ID) as MetaRecord;
    expect(meta.version).toBe(CHUNK_FORMAT_VERSION);
    expect(meta.savedAt).toBe(999);
  });

  test('each doc lands in its hashed bucket; record count is bounded', () => {
    const firestore: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 1000; i++) firestore[`col/doc${i}`] = { i };
    const records = serializeToBuckets(firestore, {}, 0);
    expect(records.size).toBeLessThanOrEqual(BUCKET_COUNT + 1); // meta + buckets
    const id = pathToBucketId('col/doc500');
    const bucket = records.get(id) as BucketRecord;
    expect(bucket.docs['col/doc500']).toEqual({ i: 500 });
  });

  test('empty firestore yields just the meta record', () => {
    const records = serializeToBuckets({}, {}, 0);
    expect(records.size).toBe(1);
    expect(records.has(META_RECORD_ID)).toBe(true);
    expect(deserializeFromBuckets(records).firestore).toEqual({});
  });

  test('partitions services.rtdb into separate rtdb:* records across instances, priorities, and rules', () => {
    const rtdbEnvelope = {
      '.pyricRtdbPersistence': 1,
      data: {
        workspaces: {
          w1: { cursors: { u1: { x: 10, y: 20 }, u2: { x: 30, y: 40 } } },
          w2: { cursors: { u1: { x: 5, y: 6 } } },
        },
        banner: 'welcome',
      },
      priorities: {
        '/banner': 1,
        '/workspaces/w1/cursors/u1': 99,
      },
      rules: { rules: { '.read': 'auth != null', '.write': 'auth != null' } },
      instances: {
        'secondary-rtdb': {
          '.pyricRtdbPersistence': 1,
          data: { counters: { hits: 7 } },
          priorities: { '/counters/hits': 'high' },
          rules: { rules: { counters: { '.read': true } } },
        },
      },
    };
    const services = {
      auth: { users: [{ uid: 'u1' }], providers: {} },
      rtdb: rtdbEnvelope,
    };

    const records = serializeToBuckets({ 'docs/d1': { ok: true } }, services, 500);
    const meta = records.get(META_RECORD_ID) as MetaRecord;
    expect(meta.services).not.toHaveProperty('rtdb');
    expect(meta.services).toEqual({ auth: { users: [{ uid: 'u1' }], providers: {} } });

    const rtdbIds = [...records.keys()].filter((id) => id.startsWith('rtdb:'));
    expect(rtdbIds.length).toBeGreaterThanOrEqual(3);

    const roundTripped = deserializeFromBuckets(records);
    expect(roundTripped.firestore).toEqual({ 'docs/d1': { ok: true } });
    expect(roundTripped.services).toEqual(services);

    const imported = decodeImportBundle(bundleRecords(records));
    expect(imported.services).toEqual(services);
  });

  test('rejects metadata version 3 and inline meta.services.rtdb on import and ignores inline rtdb on bucket deserialize', () => {
    const inlineRtdb = {
      '.pyricRtdbPersistence': 1,
      data: { rooms: { general: { name: 'General' } } },
      priorities: { '/rooms/general': 5 },
      rules: { rules: { '.read': true } },
    };
    const v3Records = new Map<string, unknown>([
      [META_RECORD_ID, { version: 3, savedAt: 10, services: { auth: { users: [] }, rtdb: inlineRtdb } }],
    ]);
    expect(() => decodeImportBundle(bundleRecords(v3Records))).toThrow(
      `State import requires metadata version ${CHUNK_FORMAT_VERSION}.`,
    );

    const v4InlineRtdbRecords = new Map<string, unknown>([
      [META_RECORD_ID, { version: CHUNK_FORMAT_VERSION, savedAt: 10, services: { auth: { users: [] }, rtdb: inlineRtdb } }],
    ]);
    expect(() => decodeImportBundle(bundleRecords(v4InlineRtdbRecords))).toThrow(
      "State import requires Realtime Database state in 'rtdb:*' records, not 'meta.services.rtdb'.",
    );
    expect(deserializeFromBuckets(v4InlineRtdbRecords).services).toEqual({ auth: { users: [] } });
  });

  test('quarantines a checksum-corrupted rtdb bucket on restore and rejects it on strict import', () => {
    const records = serializeToBuckets({}, {
      rtdb: {
        '.pyricRtdbPersistence': 1,
        data: { a: { b: { c: { d1: { v: 1 } } } }, x: { y: { z: { w1: { v: 2 } } } } },
        priorities: {},
      },
    }, 0);
    const bucketIds = [...records.keys()].filter((id) => id.startsWith('rtdb:b:'));
    expect(bucketIds.length).toBeGreaterThanOrEqual(1);
    const targetId = bucketIds[0]!;
    const targetBucket = records.get(targetId) as { nodes: Record<string, unknown> };
    const firstKey = Object.keys(targetBucket.nodes)[0]!;
    targetBucket.nodes[firstKey] = { v: 9999 };

    expect(() => decodeImportBundle(bundleRecords(records))).toThrow(/checksum/i);
    const partial = deserializeFromBuckets(records);
    const restoredData = (partial.services.rtdb as { data: Record<string, unknown> }).data;
    expect(restoredData).not.toHaveProperty(firstKey.split('/')[1]!);
  });

  test('recognizes rules-only RTDB persisted state as non-empty and rejects invalid RTDB rules in record and service validators', () => {
    const emptyRtdb = {
      '.pyricRtdbPersistence': 1 as const,
      data: {},
      priorities: {},
    };
    expect(persistedServiceHasData('rtdb', emptyRtdb)).toBe(false);

    const rulesOnlyDefault = {
      ...emptyRtdb,
      rules: { rules: { users: { $uid: { '.read': 'auth.uid === $uid' } } } },
    };
    expect(persistedServiceHasData('rtdb', rulesOnlyDefault)).toBe(true);

    const rulesOnlyNamed = {
      ...emptyRtdb,
      instances: {
        'secondary-rtdb': {
          ...emptyRtdb,
          rules: { rules: { items: { '.read': true } } },
        },
      },
    };
    expect(persistedServiceHasData('rtdb', rulesOnlyNamed)).toBe(true);

    expect(() =>
      validateRtdbImportRecord('rtdb:i:(default)', {
        version: 1,
        instance: '(default)',
        priorities: {},
        rules: { rules: { '.unknownDirective': true, '.read': 'auth.uid ===' } },
      }),
    ).toThrow(/invalid rules|compile/i);

    expect(() =>
      validatePersistedService('rtdb', {
        ...emptyRtdb,
        rules: { rules: { '.unknownDirective': true } },
      }),
    ).toThrow(/rules|compile/i);
  });
});
