/**
 * Production compiles a Firestore ruleset whose sole service block is
 * `firebase.storage` or an unknown service name and denies every Firestore
 * request at runtime (`#1434`, `rules-firestore-service-name-storage-in-firestore`,
 * `rules-firestore-service-name-unknown-in-firestore`). Duplicate declarations
 * of one service, syntax errors, and compile-limit violations remain compile
 * rejections on `checkRulesSource`.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { inspect, seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';
import {
  checkRulesSource,
  rulesGrammarRejection,
  SimulateFirestoreRulesHandler,
} from '@pyric/rules/internal';
import type { TestCase } from 'pyric/rules/internal';
import { firestoreRules } from '../../../src/rules/index.js';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
} from '../../../src/firestore/index.js';

const STORAGE_ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const STORAGE_WITH_FIRESTORE_ROOT = `rules_version = '2';
service firebase.storage {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const UNKNOWN_SERVICE = `rules_version = '2';
service foo.bar {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const FIRESTORE_ALLOW_ALL = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const UNPARSEABLE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} { allow read: if true }
  }
}`;

const lets = Array.from({ length: 12 }, (_, i) => `      let v${i} = ${i};`).join('\n');
const PAST_COMPILE_LIMIT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function g() {
${lets}
      return v0 == 0;
    }
    match /notes/{id} { allow read: if g(); }
  }
}`;

const STORAGE_MODULES = `rules_version = '2+modules';
import { isSignedIn } from './helpers.rules';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if isSignedIn();
    }
  }
}`;

const FIRESTORE_MODULES = `rules_version = '2+modules';
import { isSignedIn } from './helpers.rules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read: if isSignedIn();
    }
  }
}`;

const DUPLICATE_FIRESTORE_MODULES = `rules_version = '2+modules';
import { isSignedIn } from './helpers.rules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} { allow read: if isSignedIn(); }
  }
}
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} { allow read: if false; }
  }
}`;

describe('checkRulesSource accepts non-Firestore services and still rejects duplicates and compile limits', () => {
  test('service firebase.storage and unknown service foo.bar compile cleanly', () => {
    expect(checkRulesSource(STORAGE_ALLOW_ALL).ok).toBe(true);
    expect(rulesSourceRejection(STORAGE_ALLOW_ALL)).toBeNull();
    expect(checkRulesSource(STORAGE_WITH_FIRESTORE_ROOT).ok).toBe(true);
    expect(checkRulesSource(UNKNOWN_SERVICE).ok).toBe(true);
    expect(rulesSourceRejection(UNKNOWN_SERVICE)).toBeNull();
  });

  test('checks duplicate declarations before module compile limits and rejects unresolved 2+modules', () => {
    for (const modular of [STORAGE_MODULES, FIRESTORE_MODULES]) {
      expect(checkRulesSource(modular)).toMatchObject({
        ok: false,
        rejection: {
          kind: 'compile',
          violations: [expect.objectContaining({ code: 'UNRESOLVED_MODULES' })],
        },
      });
    }
    expect(rulesGrammarRejection(STORAGE_MODULES)).toMatchObject({
      kind: 'compile',
      violations: [expect.objectContaining({ code: 'UNRESOLVED_MODULES' })],
    });
    expect(checkRulesSource(DUPLICATE_FIRESTORE_MODULES)).toEqual({
      ok: false,
      rejection: {
        kind: 'parse',
        line: 8,
        column: 1,
        message: 'rules did not compile: Duplicate service name declaration.',
      },
    });
  });

  test('a cloud.firestore source loads, and parse and compile rejections read as before', () => {
    expect(checkRulesSource(FIRESTORE_ALLOW_ALL).ok).toBe(true);
    expect(rulesSourceRejection(UNPARSEABLE)!.message).toMatch(/^rules did not parse at line 4, column \d+: .+\.$/);
    expect(rulesSourceRejection(PAST_COMPILE_LIMIT)).toMatchObject({
      kind: 'compile',
      message: 'rules did not compile: Line 17: Maximum allowed variable count of 10 for a given function has been reached.',
    });
  });
});

describe('every Firestore plane compiles non-Firestore services and denies all Firestore requests', () => {
  test.each([
    ['service firebase.storage (/b/{bucket}/o)', STORAGE_ALLOW_ALL],
    ['service firebase.storage (/databases/{database}/documents)', STORAGE_WITH_FIRESTORE_ROOT],
    ['unknown service foo.bar', UNKNOWN_SERVICE],
  ])('in-page setRules denies get, list, collectionGroup, and write under %s with permission-denied', async (_label, source) => {
    const sandbox = initializeSandbox();
    seedDocuments(sandbox, { 'c/1': { v: 1 }, 'p/1/c/2': { v: 2 } });
    setRules(sandbox, source);
    const db = getFirestore(sandbox);

    await expect(getDoc(doc(db, 'c/1'))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(getDocs(collection(db, 'c'))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(getDocs(collectionGroup(db, 'c'))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(setDoc(doc(db, 'c/1'), { v: 3 })).rejects.toMatchObject({ code: 'permission-denied' });

    const lintStatus = inspect(sandbox).rules.lint;
    expect(lintStatus.errors).toBe(0);
    expect(lintStatus.findings).toContainEqual(
      expect.objectContaining({ rule: 'MISSING_FIRESTORE_SERVICE', severity: 'warning' }),
    );
  });

  test("the admin handle's setRules denies client reads with permission-denied and restores when Firestore rules follow", async () => {
    const sandbox = initializeSandbox();
    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    getAdminFirestore(sandbox.withAuth(null)).setRules(STORAGE_WITH_FIRESTORE_ROOT);
    const db = getFirestore(sandbox);
    await expect(getDoc(doc(db, 'c/1'))).rejects.toMatchObject({ code: 'permission-denied' });

    setRules(sandbox, FIRESTORE_ALLOW_ALL);
    await setDoc(doc(db, 'c/1'), { v: 1 });
    expect((await getDoc(doc(db, 'c/1'))).data()).toEqual({ v: 1 });
  });

  test('SimulateFirestoreRulesHandler and firestoreRules() compile non-Firestore services and return DENY', () => {
    for (const source of [STORAGE_ALLOW_ALL, STORAGE_WITH_FIRESTORE_ROOT, UNKNOWN_SERVICE]) {
      const sim = new SimulateFirestoreRulesHandler().simulate(source, [
        { description: 'get c/1', expectation: 'DENY', method: 'get', path: 'c/1' } as TestCase,
      ]);
      expect(sim.success).toBe(true);
      if (sim.success) expect(sim.data.results[0]?.decision).toBe('DENY');

      const summary = firestoreRules(source).simulate([
        { description: 'get c/1', expectation: 'DENY', method: 'get', path: 'c/1' },
      ]);
      expect(summary.passed).toBe(1);
      expect(summary.cases[0]?.decision).toBe('DENY');
    }
  });
});
