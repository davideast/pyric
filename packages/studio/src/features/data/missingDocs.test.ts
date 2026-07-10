/**
 * Missing/phantom parent documents (the Console-parity browse seam).
 *
 * Seeding ONLY a deep path (`zones/village/players/anonymous-2`) stores no
 * doc at `zones/village` — a "missing" parent with real descendants. These
 * pin the contract the Firestore pane composes over:
 *   - `handles.listDocuments` (via `listDocumentsForBrowse`, the mapping both
 *     in-process handle builders share) is phantom-INCLUSIVE,
 *   - queries (`getDocs`) and `getDoc` stay phantom-FREE (Firebase parity),
 *   - the recursive delete walks THROUGH phantoms, so deep leaves are found
 *     and removed when an ancestor collection is deleted,
 *   - the clear-sandbox sweep (`collectAllDocPaths`) reaches stored docs
 *     under phantoms and collects nothing for the phantoms themselves.
 *
 * Handles are built off the internal env directly (not `makeHandles`, whose
 * storage handle needs IndexedDB) — the same `getInternalEnv` wiring both
 * handle builders use.
 */

import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getAdminFirestore,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  startAfter,
} from 'pyric/firestore';
import type { FirestoreApi } from '@pyric/ui/firestore';
import {
  collectAllDocPaths,
  listDocumentsForBrowse,
  type StudioDataHandles,
} from './sandbox.js';
import { makeRecursiveDeleteImpl } from './recursiveDelete.js';

/** `exists` is a method on modular snapshots, a boolean on compat shapes. */
function exists(snap: unknown): boolean {
  const e = (snap as { exists: boolean | (() => boolean) }).exists;
  return typeof e === 'function' ? e.call(snap) : e;
}

/** A sandbox whose ONLY data is one deep leaf under a missing parent. */
async function seedDeepOnly() {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  const db = getAdminFirestore(sandbox);
  const handles: Pick<
    StudioDataHandles,
    'listRootCollections' | 'listSubcollections' | 'listDocuments'
  > = {
    listRootCollections: () => env.listRootCollections(),
    listSubcollections: (docPath: string) => env.listSubcollections(docPath),
    listDocuments: (collectionPath: string) => listDocumentsForBrowse(env, collectionPath),
  };
  await setDoc(doc(db, 'zones/village/players/anonymous-2'), { hp: 10 });
  return { handles, db };
}

describe('StudioDataHandles.listDocuments (phantom-inclusive browse)', () => {
  it('lists a missing parent as phantom; queries + getDoc stay phantom-free', async () => {
    const { handles, db } = await seedDeepOnly();

    expect(handles.listRootCollections()).toEqual(['zones']);
    expect(await handles.listDocuments('zones')).toEqual([
      { path: 'zones/village', phantom: true },
    ]);

    // Firebase parity: a query over `zones` matches stored docs only…
    const snap = await getDocs(query(collection(db, 'zones')));
    expect(snap.docs.length).toBe(0);
    // …and a direct read of the phantom stays exists-false.
    expect(exists(await getDoc(doc(db, 'zones/village')))).toBe(false);
  });

  it('a real doc wins over its phantom synthesis', async () => {
    const { handles, db } = await seedDeepOnly();
    await setDoc(doc(db, 'zones/village'), { name: 'Village' });
    expect(await handles.listDocuments('zones')).toEqual([{ path: 'zones/village' }]);
  });

  it('lists phantoms in nested collections too', async () => {
    const { handles, db } = await seedDeepOnly();
    await setDoc(doc(db, 'zones/village/players/p1/inventory/sword'), { dmg: 3 });
    expect(await handles.listDocuments('zones/village/players')).toEqual([
      { path: 'zones/village/players/anonymous-2' },
      { path: 'zones/village/players/p1', phantom: true },
    ]);
  });
});

describe('recursive delete through missing parents', () => {
  it('deleting the root collection removes leaves under phantoms', async () => {
    const { handles, db } = await seedDeepOnly();
    const api: FirestoreApi = {
      addDoc,
      collection,
      deleteDoc,
      doc,
      getDoc,
      getDocs,
      limit,
      query,
      setDoc,
      startAfter,
    };
    const impl = makeRecursiveDeleteImpl(api, handles);

    const progress = [];
    for await (const p of impl.start(collection(db, 'zones'))) progress.push(p);

    expect(exists(await getDoc(doc(db, 'zones/village/players/anonymous-2')))).toBe(false);
    expect(handles.listRootCollections()).toEqual([]);
    // Only the real leaf counts as a deletion; the phantom parent is a no-op.
    expect(progress.at(-1)).toEqual({ deletedCount: 1, done: true });
  });
});

describe('clear sandbox through missing parents (collectAllDocPaths)', () => {
  it('collects only stored docs, reaching leaves under phantoms', async () => {
    const { handles, db } = await seedDeepOnly();

    const { docPaths, errors } = await collectAllDocPaths(handles);
    expect(errors).toEqual([]);
    // The leaf is found through the missing parent; the phantom itself is
    // traversed but never collected (nothing stored to delete).
    expect(docPaths).toEqual(['zones/village/players/anonymous-2']);

    // The clear's delete loop over the collected paths empties the keyspace.
    for (const path of docPaths) await deleteDoc(doc(db, path));
    expect(exists(await getDoc(doc(db, 'zones/village/players/anonymous-2')))).toBe(false);
    expect(handles.listRootCollections()).toEqual([]);
  });
});
