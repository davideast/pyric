import { afterAll, describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realFirestore from 'firebase/firestore';
import { firestoreContext } from '../src/firestore.js';
import { firestoreResult } from '../src/firestore-session-capture.js';
import {
  sessionDocFields,
  sessionSetDocOp,
  sessionUpdateDocOp,
  sessionWriteFields,
} from '../src/firestore-session-values.js';
import { observedCallOf } from '../src/page-observer.js';
import type { LiveCallRecord } from '../src/index.js';

const SIX_COLLIDING_USER_MAPS: Readonly<Record<string, Record<string, unknown>>> = {
  internalTag: { __type: 'timestamp', seconds: 100, nanos: 0 },
  envelopeTag: { type: 'pyric/map/1.0', fields: { label: 'nested' } },
  wireTimestampTag: { type: 'firestore/timestamp/1.0', seconds: 100, nanoseconds: 0 },
  vectorTag: { __type__: '__vector__', value: [1, 2, 3] },
  sentinelServerTs: { _methodName: 'serverTimestamp' },
  sentinelDelete: { _methodName: 'deleteField' },
  wrapperTypeTag: { typeName: 'timestamp', seconds: 100 },
  refIdPathPair: { id: 'doc-1', path: 'docs/doc-1' },
};

describe('firestore colliding user maps in live capture', () => {
  const app = realApp.initializeApp(
    { apiKey: 'demo', projectId: 'demo-colliding', appId: '1:1:web:colliding' },
    'live-colliding-maps',
  );
  const db = realFirestore.getFirestore(app);
  const ref = realFirestore.doc(db, 'items/item-1');

  afterAll(async () => {
    await realFirestore.terminate(db);
    await realApp.deleteApp(app);
  });

  test('firestoreContext escapes all 6 colliding user-map marker shapes in writeData and survives observedCallOf', () => {
    const ctx = firestoreContext('setDoc', [ref, { ...SIX_COLLIDING_USER_MAPS, plain: { ok: true } }]);
    expect(ctx.writeData).toBeDefined();
    const writeRecord = ctx.writeData as Readonly<Record<string, unknown>>;
    expect(writeRecord.plain).toEqual({ ok: true });

    for (const [key, expectedFields] of Object.entries(SIX_COLLIDING_USER_MAPS)) {
      expect(writeRecord[key]).toEqual({
        type: 'pyric/map/1.0',
        fields: expectedFields,
      });
    }

    const record: LiveCallRecord = {
      module: 'firebase/firestore',
      name: 'setDoc',
      path: 'items/item-1',
      outcome: 'rejected',
      code: 'permission-denied',
      writeData: ctx.writeData,
    };
    const observed = observedCallOf(record, 10);
    expect(observed?.writeData as unknown).toEqual(writeRecord);
  });

  test('firestoreContext escapes root-level colliding user maps in setDoc while keeping dotted updateDoc writeData omitted', () => {
    const rootColliding = { __type: 'timestamp', seconds: 42, nanos: 0 };
    const setCtx = firestoreContext('setDoc', [ref, rootColliding]);
    expect(setCtx.writeData).toEqual({
      type: 'pyric/map/1.0',
      fields: rootColliding,
    });

    const dottedUpdateCtx = firestoreContext('updateDoc', [ref, { 'meta.nanos': 0, __type: 'timestamp' }]);
    expect(dottedUpdateCtx.writeData).toBeUndefined();
  });

  test('firestoreResult escapes colliding user maps in returned getDoc document payloads', () => {
    const snap = {
      exists: () => true,
      metadata: { hasPendingWrites: false, fromCache: false },
      ref: { path: 'items/item-1', converter: null },
      data: () => ({
        meta: { __type: 'timestamp', seconds: 100, nanos: 0 },
        sentinelLookalike: { _methodName: 'serverTimestamp' },
        plain: { count: 1 },
      }),
    };
    const reading = firestoreResult(
      {
        module: 'firebase/firestore',
        observer: () => undefined,
        name: 'getDoc',
        path: 'items/item-1',
        subject: ref,
      },
      snap,
    );
    expect(typeof reading).toBe('object');
    if (typeof reading === 'object') {
      expect(reading.document).toEqual({
        meta: { type: 'pyric/map/1.0', fields: { __type: 'timestamp', seconds: 100, nanos: 0 } },
        sentinelLookalike: { type: 'pyric/map/1.0', fields: { _methodName: 'serverTimestamp' } },
        plain: { count: 1 },
      });
    }
  });

  test('sessionDocFields, sessionWriteFields, sessionSetDocOp, and sessionUpdateDocOp preserve plain _methodName maps without treating them as FieldValue sentinels', () => {
    const docCopied = sessionDocFields(SIX_COLLIDING_USER_MAPS);
    expect(docCopied.ok).toBe(true);
    if (docCopied.ok) {
      for (const [key, expectedFields] of Object.entries(SIX_COLLIDING_USER_MAPS)) {
        expect(docCopied.value[key]).toEqual({
          type: 'pyric/map/1.0',
          fields: expectedFields,
        });
      }
    }

    const writeCopied = sessionWriteFields(SIX_COLLIDING_USER_MAPS);
    expect(writeCopied.ok).toBe(true);
    if (writeCopied.ok) {
      expect(writeCopied.value.partial).toBeUndefined();
      expect(writeCopied.value.deleteFields).toBeUndefined();
      for (const [key, expectedFields] of Object.entries(SIX_COLLIDING_USER_MAPS)) {
        expect(writeCopied.value.data[key]).toEqual({
          type: 'pyric/map/1.0',
          fields: expectedFields,
        });
      }
    }

    const setOp = sessionSetDocOp('items/item-1', SIX_COLLIDING_USER_MAPS, undefined);
    expect(setOp.ok).toBe(true);
    if (setOp.ok && setOp.value.kind === 'set') {
      expect(setOp.value.partial).toBeUndefined();
      expect(setOp.value.deleteFields).toBeUndefined();
      expect(setOp.value.data.sentinelDelete).toEqual({
        type: 'pyric/map/1.0',
        fields: { _methodName: 'deleteField' },
      });
    }

    const updateOp = sessionUpdateDocOp('items/item-1', [
      {
        'nested.sentinelTs': { _methodName: 'serverTimestamp' },
        'nested.sentinelDel': { _methodName: 'deleteField' },
        realDeleted: realFirestore.deleteField(),
      },
    ]);
    expect(updateOp).toEqual({
      ok: true,
      value: {
        kind: 'update',
        path: 'items/item-1',
        data: {
          'nested.sentinelTs': {
            type: 'pyric/map/1.0',
            fields: { _methodName: 'serverTimestamp' },
          },
          'nested.sentinelDel': {
            type: 'pyric/map/1.0',
            fields: { _methodName: 'deleteField' },
          },
        },
        deleteFields: ['realDeleted'],
      },
    });
  });
});
