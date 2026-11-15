import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  doc,
  getDoc,
  getFirestore,
  setDoc,
} from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getBytes,
  getStorageSandbox,
  ref,
  uploadString,
} from 'pyric/storage';

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{d=**} {
    allow read, write: if true;
  }
}
`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /check-maps/{itemId} {
      allow write: if true;
      allow read: if firestore.get(/databases/(default)/documents/items/$(itemId)).data.loc is map
        && !(firestore.get(/databases/(default)/documents/items/$(itemId)).data.loc is latlng)
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.meta is map
        && !(firestore.get(/databases/(default)/documents/items/$(itemId)).data.meta is path)
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.payload is map
        && !(firestore.get(/databases/(default)/documents/items/$(itemId)).data.payload is timestamp)
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.geoJson is map
        && !(firestore.get(/databases/(default)/documents/items/$(itemId)).data.geoJson is latlng);
    }
    match /check-typed/{itemId} {
      allow write: if true;
      allow read: if firestore.get(/databases/(default)/documents/items/$(itemId)).data.realGeo is latlng
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.realRef is path
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.realTs is timestamp
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.realDate is timestamp
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.realBytes is bytes;
    }
    match /reject-plain-latlng/{itemId} {
      allow write: if true;
      allow read: if firestore.get(/databases/(default)/documents/items/$(itemId)).data.loc is latlng;
    }
  }
}
`;

const FIRESTORE_CHECK_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow get: if resource.data.loc is map
        && resource.data.meta is map
        && resource.data.payload is map
        && resource.data.geoJson is map
        && resource.data.realGeo is latlng
        && resource.data.realRef is path
        && resource.data.realTs is timestamp
        && resource.data.realDate is timestamp
        && resource.data.realBytes is bytes;
    }
  }
}
`;

describe('Storage sandbox firestore.get() preserves plain user maps and typed Firestore values', () => {
  test('keeps plain maps as map while converting real GeoPoint, DocumentReference, Timestamp, Date, and Bytes', async () => {
    const sandbox = initializeSandbox({ projectId: 'demo-storage-maps' });
    const db = getFirestore(sandbox);
    const storage = getStorageSandbox(sandbox, { rules: STORAGE_RULES });

    setRules(sandbox, OPEN_FIRESTORE_RULES);
    await setDoc(doc(db, 'items/doc1'), {
      loc: { latitude: 37.7, longitude: -122.4 },
      meta: { id: 'doc1', path: 'items/doc1' },
      payload: { __type: 'timestamp', seconds: 100, nanos: 0 },
      geoJson: { type: 'firestore/geoPoint/1.0', latitude: 1, longitude: 2 },
      realGeo: new GeoPoint(37.7, -122.4),
      realRef: doc(db, 'items/other'),
      realTs: Timestamp.fromMillis(1700000000000),
      realDate: new Date(1700000000000),
      realBytes: Bytes.fromBase64String('AQID'),
    });

    await uploadString(ref(storage, 'check-maps/doc1'), 'hello');
    await uploadString(ref(storage, 'check-typed/doc1'), 'hello');
    await uploadString(ref(storage, 'reject-plain-latlng/doc1'), 'hello');

    setRules(sandbox, FIRESTORE_CHECK_RULES);
    const fsSnap = await getDoc(doc(db, 'items/doc1'));
    expect(fsSnap.data()).toBeDefined();

    const mapBytes = await getBytes(ref(storage, 'check-maps/doc1'));
    expect(mapBytes.byteLength).toBe(5);

    const typedBytes = await getBytes(ref(storage, 'check-typed/doc1'));
    expect(typedBytes.byteLength).toBe(5);

    await expect(getBytes(ref(storage, 'reject-plain-latlng/doc1'))).rejects.toThrow();
  });

  test('preserves plain colliding maps seeded via sandbox.admin.setDocument()', async () => {
    const sandbox = initializeSandbox({ projectId: 'demo-storage-admin-maps' });
    const storage = getStorageSandbox(sandbox, { rules: STORAGE_RULES });

    sandbox.admin.setDocument('items/doc2', {
      loc: { latitude: 10, longitude: 20 },
      meta: { id: 'doc2', path: 'items/doc2' },
      payload: { __type: 'timestamp', seconds: 200, nanos: 0 },
      geoJson: { type: 'firestore/geoPoint/1.0', latitude: 3, longitude: 4 },
    });

    await uploadString(ref(storage, 'check-maps/doc2'), 'hello');
    await uploadString(ref(storage, 'reject-plain-latlng/doc2'), 'hello');

    const mapBytes = await getBytes(ref(storage, 'check-maps/doc2'));
    expect(mapBytes.byteLength).toBe(5);

    await expect(getBytes(ref(storage, 'reject-plain-latlng/doc2'))).rejects.toThrow();
  });
});
