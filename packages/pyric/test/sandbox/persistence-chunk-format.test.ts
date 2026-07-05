import { describe, test, expect } from 'bun:test';
import {
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
});
