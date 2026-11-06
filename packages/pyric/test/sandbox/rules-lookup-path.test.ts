/**
 * A lookup path keeps an interpolated string as one segment (#1888).
 *
 * Production builds the path of a rules document lookup from its segments,
 * so `$(value)` holding a `/` is one segment and names no document. Capture
 * `c7a-interp-lookups`: `ge0` (get with `owner: 'u1/keys/k1'`) and `ex1`
 * (exists with `k: 'x/sub/y'`) deny, while pyric read the deeper document.
 * Storage's `firestore.get()` and `firestore.exists()` build their paths the
 * same way (capture `rules-storage-h1-lookup-interpolated-slash`).
 *
 * Every case seeds `users/u/keys/k1` as an admin, so a lookup that split the
 * owner into three segments would find it and allow.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getFirestore, setDoc } from '../../src/firestore/index.js';
import { getStorageSandbox, ref, uploadBytes } from '../../src/storage/index.js';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';

const SLASHED_OWNER = 'u/keys/k1';

function firestoreRules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /keys/{id} {
      allow create: if ${condition};
    }
  }
}`;
}

function storageRules(condition: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /keys/{file} {
      allow create: if ${condition};
    }
  }
}`;
}

const ownerDoc = '/databases/$(database)/documents/users/$(request.resource.data.owner)';
const firestoreLookups: Record<string, string> = {
  get: `get(${ownerDoc}).data.admin == true`,
  exists: `exists(${ownerDoc})`,
  getAfter: `getAfter(${ownerDoc}).data.admin == true`,
  existsAfter: `existsAfter(${ownerDoc})`,
};

const metadataOwnerDoc = '/databases/(default)/documents/users/$(request.resource.metadata.owner)';
const storageLookups: Record<string, string> = {
  'firestore.get': `firestore.get(${metadataOwnerDoc}).data.admin == true`,
  'firestore.exists': `firestore.exists(${metadataOwnerDoc})`,
};

function seededSandbox() {
  const sandbox = initializeSandbox({});
  sandbox.admin.setDocument('users/u', { admin: true });
  sandbox.admin.setDocument('users/u/keys/k1', { admin: true });
  return sandbox;
}

async function createKey(condition: string, owner: string): Promise<string> {
  const sandbox = seededSandbox();
  setRules(sandbox, firestoreRules(condition));
  const db = getFirestore(sandbox.withAuth({ uid: 'u' }));
  try {
    await setDoc(doc(db, 'keys/k1'), { owner });
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

async function uploadKey(condition: string, owner: string): Promise<string> {
  const sandbox = seededSandbox();
  const storage = getStorageSandbox(sandbox.withAuth({ uid: 'u' }), {
    dbName: `pyric-lookup-path-${Math.random().toString(36).slice(2, 10)}`,
    rules: storageRules(condition),
  });
  try {
    await uploadBytes(ref(storage, 'keys/k1.bin'), new Blob(['k']), { customMetadata: { owner } });
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe('Firestore rules lookups keep an interpolated string as one segment', () => {
  for (const [name, condition] of Object.entries(firestoreLookups)) {
    it(`${name}() with owner '${SLASHED_OWNER}' denies setDoc`, async () => {
      expect(await createKey(condition, SLASHED_OWNER)).toBe('permission-denied');
    });

    it(`${name}() with owner 'u' reads users/u and allows setDoc`, async () => {
      expect(await createKey(condition, 'u')).toBe('ok');
    });
  }

  it(`!exists() with owner '${SLASHED_OWNER}' denies, as production does for capture case ex2`, async () => {
    expect(await createKey(`!${firestoreLookups.exists}`, SLASHED_OWNER)).toBe('permission-denied');
  });
});

/** Rules that look up `col/<the segments {rest=**} matched>` for a create under `trees/`. */
function recursiveRules(lookup: 'get' | 'exists'): string {
  const target = '/databases/$(database)/documents/col/$(rest)';
  const condition = lookup === 'get' ? `get(${target}).data.on == true` : `exists(${target})`;
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /trees/{rest=**} {
      allow create: if ${condition};
    }
  }
}`;
}

/** A `let` named `rest` shadows the match variable with the written `k`, a plain string. */
const SHADOWED_REST_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /trees/{rest=**} {
      function lookupK() {
        let rest = request.resource.data.k;
        return exists(/databases/$(database)/documents/col/$(rest));
      }
      allow create: if lookupK();
    }
  }
}`;

async function createTree(
  lookup: 'get' | 'exists',
  path: string,
  data: Record<string, unknown> = { on: true },
  rules = recursiveRules(lookup),
): Promise<string> {
  const sandbox = initializeSandbox({});
  sandbox.admin.setDocument('col/a', { on: true });
  sandbox.admin.setDocument('col/a/b/c', { on: true });
  setRules(sandbox, rules);
  const db = getFirestore(sandbox.withAuth({ uid: 'u' }));
  try {
    await setDoc(doc(db, path), data);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe('Firestore rules lookups splice a recursive wildcard as its segments', () => {
  for (const lookup of ['get', 'exists'] as const) {
    it(`${lookup}() of col/$(rest) for trees/a/b/c reads col/a/b/c and allows setDoc`, async () => {
      expect(await createTree(lookup, 'trees/a/b/c')).toBe('ok');
    });

    it(`${lookup}() of col/$(rest) for trees/a/b/d finds no document and denies setDoc`, async () => {
      expect(await createTree(lookup, 'trees/a/b/d')).toBe('permission-denied');
    });
  }

  it("a let named rest holding 'a/b/c' is one segment, so exists() of col/$(rest) denies setDoc", async () => {
    expect(await createTree('exists', 'trees/x', { k: 'a/b/c' }, SHADOWED_REST_RULES)).toBe('permission-denied');
  });

  it("the same let holding 'a' reads col/a and allows setDoc", async () => {
    expect(await createTree('exists', 'trees/x', { k: 'a' }, SHADOWED_REST_RULES)).toBe('ok');
  });
});

describe('Storage rules lookups keep an interpolated string as one segment', () => {
  for (const [name, condition] of Object.entries(storageLookups)) {
    it(`${name}() with owner '${SLASHED_OWNER}' denies uploadBytes`, async () => {
      expect(await uploadKey(condition, SLASHED_OWNER)).toBe('storage/unauthorized');
    });

    it(`${name}() with owner 'u' reads users/u and allows uploadBytes`, async () => {
      expect(await uploadKey(condition, 'u')).toBe('ok');
    });
  }
});

describe('simulate() reads the same lookup path as the sandbox', () => {
  const sim = new SimulateFirestoreRulesHandler();
  const adminMocks = ['users/u', 'users/u/keys/k1'].map((path) => ({
    function: 'get' as const,
    path: `/databases/(default)/documents/${path}`,
    result: { admin: true },
  }));

  function decision(condition: string, owner: string): string | undefined {
    const result = sim.simulate(firestoreRules(condition), [{
      description: `create with owner ${owner}`,
      expectation: 'ALLOW',
      method: 'create',
      path: 'keys/k1',
      auth: { uid: 'u' },
      data: { owner },
      functionMocks: adminMocks,
    }]);
    if (!result.success) return result.error;
    return result.data.results[0]?.decision;
  }

  for (const name of ['get', 'getAfter'] as const) {
    it(`${name}() with owner '${SLASHED_OWNER}' denies, and with owner 'u' allows`, () => {
      expect(decision(firestoreLookups[name]!, SLASHED_OWNER)).toBe('DENY');
      expect(decision(firestoreLookups[name]!, 'u')).toBe('ALLOW');
    });
  }
});
