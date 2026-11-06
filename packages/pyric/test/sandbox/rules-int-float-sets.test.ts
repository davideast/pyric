/**
 * Sets and `diff()` keep an int and a float past 2^53 apart (#1893).
 *
 * A Set and a map diff compare numbers by value, so `[1, 1.0].toSet()` has one
 * element. Past 2^53 a double no longer holds every int, and production
 * compares the int against the float's exact value rather than through a
 * double: `9007199254740993` and `9007199254740992.0` are different elements.
 * Capture `c2-numbers`: `eq7` (Set membership) and `eq8` (`diff()`) deny;
 * capture `c3-mixed-number-collections`: `b6` (Set equality) denies. The
 * small-value controls `eq4` to `eq6` and `s8` allow.
 *
 * Both engines compare Sets through `setElementsEqual`, so each case runs
 * through `setDoc` and `uploadBytes`.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getFirestore, setDoc } from '../../src/firestore/index.js';
import { getStorageSandbox, ref, uploadBytes } from '../../src/storage/index.js';

type Case = readonly [id: string, condition: string];

/** Production denies each of these; pyric allowed them. */
const pastTwoTo53: readonly Case[] = [
  ['eq7', '9007199254740993 in [9007199254740992.0].toSet()'],
  ['eq8', "{'a': 9007199254740993}.diff({'a': 9007199254740992.0}).affectedKeys().size() == 0"],
  ['b6', '[9007199254740993].toSet() == [9007199254740992.0].toSet()'],
];

/** Production allows each of these, before and after the fix. */
const smallValueControls: readonly Case[] = [
  ['eq4', '[1, 1.0].toSet().size() == 1'],
  ['eq5', '[1].toSet() == [1.0].toSet()'],
  ['eq6', "{'a': 1}.diff({'a': 1.0}).affectedKeys().size() == 0"],
  ['s8', '[1.0].toSet().hasOnly([1])'],
];

function firestoreRules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /n/{id} {
      allow create: if ${condition};
    }
  }
}`;
}

function storageRules(condition: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /n/{file} {
      allow create: if ${condition};
    }
  }
}`;
}

async function createDoc(condition: string, data: Record<string, unknown> = { v: 1 }): Promise<string> {
  const sandbox = initializeSandbox({});
  setRules(sandbox, firestoreRules(condition));
  const db = getFirestore(sandbox.withAuth({ uid: 'u' }));
  try {
    await setDoc(doc(db, 'n/1'), data);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

async function uploadFile(condition: string): Promise<string> {
  const sandbox = initializeSandbox({});
  const storage = getStorageSandbox(sandbox.withAuth({ uid: 'u' }), {
    dbName: `pyric-int-float-sets-${Math.random().toString(36).slice(2, 10)}`,
    rules: storageRules(condition),
  });
  try {
    await uploadBytes(ref(storage, 'n/1.bin'), new Blob(['n']));
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe('Firestore rules keep an int and a float past 2^53 apart in Sets and diff()', () => {
  for (const [id, condition] of pastTwoTo53) {
    it(`${id}: ${condition} denies setDoc`, async () => {
      expect(await createDoc(condition)).toBe('permission-denied');
    });
  }

  for (const [id, condition] of smallValueControls) {
    it(`${id}: ${condition} allows setDoc`, async () => {
      expect(await createDoc(condition)).toBe('ok');
    });
  }

  it('a document field past 2^53 changes under diff() against the int literal one above it', async () => {
    // The SDK sends 9007199254740992 as a double, as in eq8.
    const condition = "request.resource.data.diff({'n': 9007199254740993}).affectedKeys().size() == 0";
    expect(await createDoc(condition, { n: 9007199254740992 })).toBe('permission-denied');
  });
});

describe('Storage rules keep an int and a float past 2^53 apart in Sets and diff()', () => {
  for (const [id, condition] of pastTwoTo53) {
    it(`${id}: ${condition} denies uploadBytes`, async () => {
      expect(await uploadFile(condition)).toBe('storage/unauthorized');
    });
  }

  for (const [id, condition] of smallValueControls) {
    it(`${id}: ${condition} allows uploadBytes`, async () => {
      expect(await uploadFile(condition)).toBe('ok');
    });
  }
});
