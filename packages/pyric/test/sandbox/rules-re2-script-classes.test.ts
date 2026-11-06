/**
 * `matches()` reads RE2 script classes and astral class ranges (#1889, #1901).
 *
 * Production compiles rules patterns as RE2, where `\p{Cyrillic}` is the
 * Cyrillic script and `[😀-😂]` is a range of three code points. Capture
 * `c10-script-classes-and-redos`: `sg0` (a deny-list guard on a Cyrillic
 * name) denies and `sg3` (`\p{Han}`) allows. Capture `c9-re2-more`: `pg1`
 * (`\p{Greek}`) allows. Capture `c9b-astral-range-matches`: `ar2` compiles
 * and allows. The other cases are production's controls from the same
 * captures, all allowed.
 *
 * Both engines compile patterns through `parseRe2Ast` and check literals with
 * `re2PatternProblem`, so each case runs through `setDoc` and `uploadBytes`.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getFirestore, setDoc } from '../../src/firestore/index.js';
import { getStorageSandbox, ref, uploadBytes } from '../../src/storage/index.js';

type Case = readonly [id: string, condition: string];

/** Production allows each of these. */
const allowed: readonly Case[] = [
  ['sg2', "!'p{Greek}'.matches('\\\\p{Greek}')"],
  ['sg3', "'中'.matches('\\\\p{Han}')"],
  ['sg4', "'a'.matches('[\\\\p{Latin}]')"],
  ['sg5', "!'α'.matches('\\\\P{Greek}')"],
  ['pg1', "'α'.matches('\\\\p{Greek}')"],
  ['ar2', "'😀'.matches('[😀-😂]')"],
];

/** Pyric's own checks of the same classes, read as RE2 reads them. */
const pyricControls: readonly Case[] = [
  ['latin is not greek', "!'a'.matches('\\\\p{Greek}')"],
  ['negated script', "'a'.matches('\\\\p{^Greek}')"],
  ['script in a negated class', "!'α'.matches('[^\\\\p{Greek}]')"],
  ['general category still reads', "'a'.matches('\\\\p{L}')"],
  ['outside the astral range', "!'😃'.matches('[😀-😂]')"],
  ['two-letter script Yi', "'ꀀ'.matches('\\\\p{Yi}')"],
  ['astral range then Yi compiles', "'😀ꀀ'.matches('[😀-😂]\\\\p{Yi}')"],
];

const cyrillicGuard = "!request.resource.data.name.matches('.*\\\\p{Cyrillic}.*')";

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

function outcome(err: unknown): string {
  return (err as { code?: string }).code ?? String(err);
}

async function createDoc(condition: string, data: Record<string, unknown> = { v: 1 }): Promise<string> {
  const sandbox = initializeSandbox({});
  try {
    setRules(sandbox, firestoreRules(condition));
    await setDoc(doc(getFirestore(sandbox.withAuth({ uid: 'u' })), 'n/1'), data);
    return 'ok';
  } catch (err) {
    return outcome(err);
  }
}

async function uploadFile(condition: string): Promise<string> {
  const sandbox = initializeSandbox({});
  try {
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'u' }), {
      dbName: `pyric-re2-script-classes-${Math.random().toString(36).slice(2, 10)}`,
      rules: storageRules(condition),
    });
    await uploadBytes(ref(storage, 'n/1.bin'), new Blob(['n']));
    return 'ok';
  } catch (err) {
    return outcome(err);
  }
}

describe('Firestore rules read RE2 script classes and astral ranges in matches()', () => {
  it('sg0: a Cyrillic name fails the guard that refuses Cyrillic', async () => {
    expect(await createDoc(cyrillicGuard, { name: 'Пётр' })).toBe('permission-denied');
  });

  it('sg1: a Latin name passes the guard that refuses Cyrillic', async () => {
    expect(await createDoc(cyrillicGuard, { name: 'Peter' })).toBe('ok');
  });

  for (const [id, condition] of [...allowed, ...pyricControls]) {
    it(`${id}: ${condition} allows setDoc`, async () => {
      expect(await createDoc(condition)).toBe('ok');
    });
  }
});

describe('Storage rules read RE2 script classes and astral ranges in matches()', () => {
  for (const [id, condition] of [...allowed, ...pyricControls]) {
    it(`${id}: ${condition} allows uploadBytes`, async () => {
      expect(await uploadFile(condition)).toBe('ok');
    });
  }
});
