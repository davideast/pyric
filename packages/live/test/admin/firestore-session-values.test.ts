/**
 * Unit tests for `admin/firestore-session-values.ts`: bounded copying of
 * `@google-cloud/firestore` document fields and write operations into session
 * ops, preserving the five serialized Firestore value shapes while rejecting
 * server-transform `FieldValue` sentinels, forbidden keys, and oversized docs.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import {
  adminAddDocFields,
  adminCreateDocOp,
  adminDocFields,
  adminFieldPathString,
  adminSetDocOp,
  adminUpdateDocOp,
} from '../../src/admin/firestore-session-values.js';

interface AdminFirestorePkg {
  Firestore: new (settings: { projectId: string }) => {
    doc(path: string): unknown;
    terminate(): Promise<void>;
  };
  Timestamp: new (seconds: number, nanoseconds: number) => unknown;
  GeoPoint: new (latitude: number, longitude: number) => unknown;
  FieldPath: new (...segments: string[]) => unknown;
  FieldValue: {
    delete(): unknown;
    serverTimestamp(): unknown;
    increment(n: number): unknown;
    arrayUnion(...elements: unknown[]): unknown;
    arrayRemove(...elements: unknown[]): unknown;
    vector(values: number[]): unknown;
  };
}

const fromAdmin = createRequire(createRequire(import.meta.url).resolve('firebase-admin/firestore'));
const sdk = fromAdmin('@google-cloud/firestore') as AdminFirestorePkg;

describe('admin/firestore-session-values', () => {
  test('validates and normalizes document paths across write ops', () => {
    expect(adminCreateDocOp('/items/a', { n: 1 })).toEqual({
      ok: true,
      value: { kind: 'set', path: 'items/a', data: { n: 1 } },
    });
    expect(adminSetDocOp('/items/a/sub/b', { n: 1 }, undefined)).toEqual({
      ok: true,
      value: { kind: 'set', path: 'items/a/sub/b', data: { n: 1 } },
    });
    expect(adminCreateDocOp('items', { n: 1 })).toEqual({ ok: false, reason: 'unsupported' });
    expect(adminCreateDocOp('', { n: 1 })).toEqual({ ok: false, reason: 'unsupported' });
    expect(adminCreateDocOp('items/__proto__', { n: 1 })).toEqual({ ok: false, reason: 'unsupported' });
  });

  test('converts strings and Admin FieldPath instances without literal dots to dotted paths', () => {
    expect(adminFieldPathString('profile.displayName')).toBe('profile.displayName');
    expect(adminFieldPathString(new sdk.FieldPath('stats', 'count'))).toBe('stats.count');
    expect(adminFieldPathString(new sdk.FieldPath('a.b', 'c'))).toBeUndefined();
    expect(adminFieldPathString(new sdk.FieldPath('__proto__', 'x'))).toBeUndefined();
    expect(adminFieldPathString('')).toBeUndefined();
  });

  test('serializes Timestamp, Date, GeoPoint, Buffer, VectorValue, and Admin DocumentReference in read fields', async () => {
    const db = new sdk.Firestore({ projectId: 'demo-values' });
    try {
      const targetRef = db.doc('teams/alpha');
      const copied = adminDocFields({
        label: 'entry',
        count: 7,
        active: true,
        empty: null,
        tags: ['one', 'two'],
        createdAt: new sdk.Timestamp(1_700_000_000, 250),
        updatedAt: new Date(1_700_000_123_456),
        coords: new sdk.GeoPoint(37.7749, -122.4194),
        payload: Buffer.from([4, 5, 6]),
        embedding: sdk.FieldValue.vector([0.5, -0.25]),
        owner: targetRef,
      });
      expect(copied).toEqual({
        ok: true,
        value: {
          label: 'entry',
          count: 7,
          active: true,
          empty: null,
          tags: ['one', 'two'],
          createdAt: { seconds: 1_700_000_000, nanoseconds: 250 },
          updatedAt: { seconds: 1_700_000_123, nanoseconds: 456_000_000 },
          coords: { latitude: 37.7749, longitude: -122.4194 },
          payload: { type: 'firestore/bytes/1.0', bytes: 'BAUG' },
          embedding: { __type__: '__vector__', value: [0.5, -0.25] },
          owner: { type: 'document', path: 'teams/alpha', id: 'alpha' },
        },
      });
    } finally {
      await db.terminate();
    }
  });

  test('rejects forbidden prototype keys, custom class instances, and oversized documents', () => {
    const poisoned = Object.create(null) as Record<string, unknown>;
    poisoned['__proto__'] = { admin: true };
    expect(adminDocFields(poisoned)).toEqual({ ok: false, reason: 'unsupported' });

    class CustomModel {
      readonly title = 'x';
    }
    expect(adminDocFields({ nested: new CustomModel() })).toEqual({ ok: false, reason: 'unsupported' });
    expect(
      adminDocFields({
        negZero: -0,
        nanVal: Number.NaN,
        posInf: Number.POSITIVE_INFINITY,
        negInf: Number.NEGATIVE_INFINITY,
        collidingNumMap: { type: 'pyric/number/1.0', value: 'NaN' },
      }),
    ).toEqual({
      ok: true,
      value: {
        negZero: { type: 'pyric/number/1.0', value: '-0' },
        nanVal: { type: 'pyric/number/1.0', value: 'NaN' },
        posInf: { type: 'pyric/number/1.0', value: 'Infinity' },
        negInf: { type: 'pyric/number/1.0', value: '-Infinity' },
        collidingNumMap: {
          type: 'pyric/map/1.0',
          fields: { type: 'pyric/number/1.0', value: 'NaN' },
        },
      },
    });

    expect(adminDocFields({ huge: 'x'.repeat(270 * 1024) })).toEqual({
      ok: false,
      reason: 'oversized',
    });
  });

  test('treats all server-transform FieldValue sentinels as unsupported across create, add, set, and update', () => {
    const sentinels = [
      sdk.FieldValue.serverTimestamp(),
      sdk.FieldValue.increment(1),
      sdk.FieldValue.arrayUnion('a'),
      sdk.FieldValue.arrayRemove('a'),
    ];
    for (const sentinel of sentinels) {
      expect(adminCreateDocOp('items/a', { v: sentinel })).toEqual({ ok: false, reason: 'unsupported' });
      expect(adminAddDocFields({ v: sentinel })).toEqual({ ok: false, reason: 'unsupported' });
      expect(adminSetDocOp('items/a', { v: sentinel }, undefined)).toEqual({ ok: false, reason: 'unsupported' });
      expect(adminSetDocOp('items/a', { v: sentinel }, { merge: true })).toEqual({
        ok: false,
        reason: 'unsupported',
      });
      expect(adminUpdateDocOp('items/a', [{ v: sentinel }])).toEqual({ ok: false, reason: 'unsupported' });
    }
  });

  test('builds create, add, overwrite set, merge set, and mergeFields ops with FieldValue.delete support', () => {
    expect(adminCreateDocOp('items/a', { n: 1 })).toEqual({
      ok: true,
      value: { kind: 'set', path: 'items/a', data: { n: 1 } },
    });
    expect(adminCreateDocOp('items/a', { old: sdk.FieldValue.delete() })).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(adminAddDocFields({ title: 'queued' })).toEqual({
      ok: true,
      value: { data: { title: 'queued' } },
    });

    expect(adminSetDocOp('items/a', { n: 2 }, undefined)).toEqual({
      ok: true,
      value: { kind: 'set', path: 'items/a', data: { n: 2 } },
    });
    expect(
      adminSetDocOp('items/a', { keep: 'yes', drop: sdk.FieldValue.delete() }, { merge: true }),
    ).toEqual({
      ok: true,
      value: { kind: 'set', path: 'items/a', data: { keep: 'yes' }, merge: true, deleteFields: ['drop'] },
    });
    expect(
      adminSetDocOp(
        'items/a',
        {
          keep: 'yes',
          nested: { stale: sdk.FieldValue.delete(), fresh: 3 },
          ignoredTransform: sdk.FieldValue.serverTimestamp(),
        },
        { mergeFields: ['keep', new sdk.FieldPath('nested', 'stale'), 'nested.fresh'] },
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: 'update',
        path: 'items/a',
        data: { keep: 'yes', 'nested.fresh': 3 },
        merge: true,
        deleteFields: ['nested.stale'],
      },
    });
  });

  test('builds update ops from object maps and variadic field/value pairs with optional trailing Precondition', () => {
    expect(
      adminUpdateDocOp('items/a', [
        { 'meta.count': 4, obsolete: sdk.FieldValue.delete() },
        { exists: true },
      ]),
    ).toEqual({
      ok: true,
      value: {
        kind: 'update',
        path: 'items/a',
        data: { 'meta.count': 4 },
        deleteFields: ['obsolete'],
      },
    });

    expect(
      adminUpdateDocOp('items/a', [
        'title',
        'renamed',
        new sdk.FieldPath('stats', 'stale'),
        sdk.FieldValue.delete(),
        { lastUpdateTime: new sdk.Timestamp(1_700_000_000, 0) },
      ]),
    ).toEqual({
      ok: true,
      value: {
        kind: 'update',
        path: 'items/a',
        data: { title: 'renamed' },
        deleteFields: ['stats.stale'],
      },
    });
  });
});
