/**
 * One measurement of what production billed or moved for an observed call,
 * read from the SDK-shaped value the call resolved with. Both senders (page
 * and Node) share it, so a call measures the same on either plane.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ObservedUsage } from '../../src/sandbox/index.js';
import { measureObservedUsage } from '../../src/sandbox/internal/index.js';

const FIRESTORE = 'firebase/firestore';
const DATABASE = 'firebase/database';
const STORAGE = 'firebase/storage';

function docSnapshot(exists: boolean, fromCache = false) {
  return { exists: () => exists, metadata: { fromCache, hasPendingWrites: false } };
}

function querySnapshot(size: number, fromCache = false) {
  const docs = Array.from({ length: size }, () => docSnapshot(true, fromCache));
  return { docs, size, metadata: { fromCache, hasPendingWrites: false } };
}

function aggregateSnapshot(data: Record<string, number>) {
  return { data: () => data };
}

describe('Firestore reads', () => {
  const rows: [string, unknown, ObservedUsage][] = [
    ['getDoc', docSnapshot(true), { documentReads: 1 }],
    ['getDoc', docSnapshot(false), { documentReads: 1 }],
    ['getDocFromServer', docSnapshot(true), { documentReads: 1 }],
    ['getDocs', querySnapshot(3), { documentReads: 3 }],
    ['getDocs', querySnapshot(0), { documentReads: 1 }],
    ['getDocsFromServer', querySnapshot(2), { documentReads: 2 }],
    ['getDocFromCache', docSnapshot(true, true), { documentReads: 0 }],
    ['getDocsFromCache', querySnapshot(4, true), { documentReads: 0 }],
    ['getCountFromServer', aggregateSnapshot({ count: 0 }), { documentReads: 1 }],
    ['getCountFromServer', aggregateSnapshot({ count: 1000 }), { documentReads: 1 }],
    ['getCountFromServer', aggregateSnapshot({ count: 1001 }), { documentReads: 2 }],
    ['getAggregateFromServer', aggregateSnapshot({ total: 42 }), { documentReads: 1, unmeasured: 1 }],
  ];
  for (const [method, value, usage] of rows) {
    it(`${method} measures ${JSON.stringify(usage)}`, () => {
      expect(measureObservedUsage(FIRESTORE, method, value)).toEqual(usage);
    });
  }
});

describe('Firestore writes', () => {
  const rows: [string, ObservedUsage][] = [
    ['setDoc', { documentWrites: 1 }],
    ['updateDoc', { documentWrites: 1 }],
    ['addDoc', { documentWrites: 1 }],
    ['deleteDoc', { documentDeletes: 1 }],
    ['runTransaction', { documentWrites: 1, unmeasured: 1 }],
  ];
  for (const [method, usage] of rows) {
    it(`${method} measures ${JSON.stringify(usage)}`, () => {
      expect(measureObservedUsage(FIRESTORE, method, undefined)).toEqual(usage);
    });
  }
});

describe('Realtime Database reads', () => {
  it('get measures the JSON size of the delivered value', () => {
    const value = { val: () => ({ name: 'é', n: 1 }) };
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'é', n: 1 })).byteLength;
    expect(measureObservedUsage(DATABASE, 'get', value)).toEqual({ payloadBytes: bytes });
  });
});

describe('Storage transfers', () => {
  function storageRows(): [string, unknown, ObservedUsage][] {
    const bytes = new Uint8Array(7).buffer;
    return [
      ['uploadBytes', { metadata: { size: 12 }, ref: {} }, { uploadedBytes: 12 }],
      ['uploadString', { metadata: { size: 5 }, ref: {} }, { uploadedBytes: 5 }],
      ['uploadBytesResumable', { bytesTransferred: 9, totalBytes: 9, metadata: { size: 9 } }, { uploadedBytes: 9 }],
      ['getBytes', bytes, { downloadedBytes: 7 }],
      ['getBlob', { size: 30, type: 'text/plain' }, { downloadedBytes: 30 }],
    ];
  }

  const saved = { Blob: globalThis.Blob, TextEncoder: globalThis.TextEncoder };
  afterEach(() => {
    globalThis.Blob = saved.Blob;
    globalThis.TextEncoder = saved.TextEncoder;
  });

  it('measures uploaded and downloaded bytes', () => {
    for (const [method, value, usage] of storageRows()) {
      expect(measureObservedUsage(STORAGE, method, value)).toEqual(usage);
    }
  });

  it('measures the same bytes where Blob and TextEncoder are missing', () => {
    const withGlobals = storageRows().map(([method, value]) => measureObservedUsage(STORAGE, method, value));
    const globals = globalThis as { Blob?: unknown; TextEncoder?: unknown };
    delete globals.Blob;
    delete globals.TextEncoder;
    const without = storageRows().map(([method, value]) => measureObservedUsage(STORAGE, method, value));
    expect(without).toEqual(withGlobals);
  });
});

describe('calls with nothing to measure', () => {
  const rows: [string, string, unknown][] = [
    [FIRESTORE, 'onSnapshot', querySnapshot(2)],
    ['firebase/auth', 'signInWithEmailAndPassword', {}],
    ['firebase/ai', 'generateContent', {}],
    [STORAGE, 'getDownloadURL', 'https://example.test/o'],
  ];
  for (const [module, method, value] of rows) {
    it(`${module} ${method} has no usage`, () => {
      expect(measureObservedUsage(module, method, value)).toBeUndefined();
    });
  }
});

describe('Admin calls, measured as the client method each counts as', () => {
  const ADMIN_FIRESTORE = '@google-cloud/firestore';
  /** firebase-admin's snapshots: `exists` is a property, and a query has no metadata. */
  const adminDoc = { exists: true };
  const adminQuery = { docs: [adminDoc, adminDoc, adminDoc], size: 3 };
  const rows: [string, string, unknown, ObservedUsage][] = [
    [ADMIN_FIRESTORE, 'DocumentReference.get', adminDoc, { documentReads: 1 }],
    [ADMIN_FIRESTORE, 'Query.get', adminQuery, { documentReads: 3 }],
    [ADMIN_FIRESTORE, 'Firestore.getAll', [adminDoc, adminDoc], { documentReads: 2 }],
    [ADMIN_FIRESTORE, 'DocumentReference.set', {}, { documentWrites: 1 }],
    [ADMIN_FIRESTORE, 'DocumentReference.delete', {}, { documentDeletes: 1 }],
    [ADMIN_FIRESTORE, 'WriteBatch.commit', [{}, {}], { documentWrites: 2 }],
    ['@firebase/database-compat/standalone', 'Query.once', { val: () => ({ n: 1 }) }, { payloadBytes: 7 }],
    ['@google-cloud/storage', 'File.save', undefined, { unmeasured: 1 }],
  ];
  for (const [module, method, value, expected] of rows) {
    it(`${method} measures ${JSON.stringify(expected)}`, () => {
      expect(measureObservedUsage(module, method, value)).toEqual(expected);
    });
  }
});
