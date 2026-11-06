/**
 * A path wildcard named `request` or `resource` shadows the global of the
 * same name inside its block (#1886).
 *
 * Capture `st3-wildcard-shadows-global` (corpus scenario of the same name):
 * under `match /pr/{request}`, `request == 'q'` allows a get of `pr/q`; under
 * `match /ps/{resource}`, `resource == 'q'` allows a get of `ps/q`; under
 * `match /pt/{request}`, `request.method == 'get'` denies, because `request`
 * is the string `'q'`. Each Storage case runs through `getMetadata` in the
 * in-process sandbox and expects production's verdict. The Firestore twin
 * runs the same rules through `getDoc`; the Firestore simulator already
 * reads the wildcard first.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { createAppForSandbox } from '../../../src/app/internal.js';
import { doc, getDoc, getFirestore } from '../../../src/firestore/index.js';
import { getMetadata, getStorage, ref, uploadBytes } from '../../../src/storage/index.js';
import { getStorageSandbox } from '../../../src/storage/service.js';

type Case = readonly [id: string, match: string, condition: string, verdict: 'ok' | 'denied'];

/** The three captured shapes, with production's verdict for a get of `<prefix>/q`. */
const cases: readonly Case[] = [
  ['pr', '{request}', "request == 'q'", 'ok'],
  ['ps', '{resource}', "resource == 'q'", 'ok'],
  ['pt', '{request}', "request.method == 'get'", 'denied'],
];

function storageRules(prefix: string, wildcard: string, condition: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /${prefix}/${wildcard} {
      allow create: if true;
      allow get: if ${condition};
    }
  }
}`;
}

function firestoreRules(prefix: string, wildcard: string, condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /${prefix}/${wildcard} {
      allow get: if ${condition};
    }
  }
}`;
}

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorCode(err: unknown): string {
  return (err as { code?: string }).code ?? String(err);
}

async function storageGet(prefix: string, wildcard: string, condition: string): Promise<string> {
  const sandbox = initializeSandbox({});
  getStorageSandbox(sandbox, { dbName: uniqueName('wildcard'), rules: storageRules(prefix, wildcard, condition) });
  const app = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' }, uniqueName('app'));
  const object = ref(getStorage(app), `${prefix}/q`);
  await uploadBytes(object, new TextEncoder().encode('x'));
  try {
    await getMetadata(object);
    return 'ok';
  } catch (err) {
    return errorCode(err);
  }
}

async function firestoreGet(prefix: string, wildcard: string, condition: string): Promise<string> {
  const sandbox = initializeSandbox({});
  setRules(sandbox, firestoreRules(prefix, wildcard, condition));
  const db = getFirestore(sandbox.withAuth({ uid: 'u' }));
  try {
    await getDoc(doc(db, `${prefix}/q`));
    return 'ok';
  } catch (err) {
    return errorCode(err);
  }
}

describe('Storage rules: a wildcard named like a global reads as the wildcard', () => {
  for (const [prefix, wildcard, condition, verdict] of cases) {
    const expected = verdict === 'ok' ? 'ok' : 'storage/unauthorized';
    it(`match /${prefix}/${wildcard}: ${condition} ${verdict === 'ok' ? 'allows' : 'denies'} getMetadata`, async () => {
      expect(await storageGet(prefix, wildcard, condition)).toBe(expected);
    });
  }
});

describe('Firestore rules twin: a wildcard named like a global reads as the wildcard', () => {
  for (const [prefix, wildcard, condition, verdict] of cases) {
    const expected = verdict === 'ok' ? 'ok' : 'permission-denied';
    it(`match /${prefix}/${wildcard}: ${condition} ${verdict === 'ok' ? 'allows' : 'denies'} getDoc`, async () => {
      expect(await firestoreGet(prefix, wildcard, condition)).toBe(expected);
    });
  }
});
