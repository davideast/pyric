/**
 * Production's Firestore load check refuses a ruleset for another service
 * (FS2-ENF-2, and the simulate half of FS2-CON-9). Production won't deploy a
 * `service firebase.storage` ruleset as Firestore rules, so no pyric plane
 * installs or evaluates one: the one check, `checkRulesSource`, refuses it,
 * and every load path that runs the check refuses it with the same reason.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { inspect, setRules } from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';
import {
  checkRulesSource,
  rulesGrammarRejection,
} from '../../../src/rules/grammar/source-compile-limits.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from 'pyric/rules/internal';
import { firestoreRules, RulesCompileError } from '../../../src/rules/index.js';
import { getFirestore, doc, getDoc, setDoc } from '../../../src/firestore/index.js';

const STORAGE_ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
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

const SERVICE_REASON = "rules did not compile: Expected 'service cloud.firestore', got 'service firebase.storage'.";

describe('checkRulesSource refuses a ruleset for another service', () => {
  test('a service firebase.storage source is a parse rejection at the service keyword', () => {
    const checked = checkRulesSource(STORAGE_ALLOW_ALL);
    expect(checked).toEqual({
      ok: false,
      rejection: { kind: 'parse', line: 2, column: 1, message: SERVICE_REASON, otherService: 'firebase.storage' },
    });
    expect(rulesSourceRejection(STORAGE_ALLOW_ALL)).toEqual({ kind: 'parse', line: 2, column: 1, message: SERVICE_REASON, otherService: 'firebase.storage' });
  });

  test('a cloud.firestore source loads, and parse and compile rejections read as before', () => {
    expect(checkRulesSource(FIRESTORE_ALLOW_ALL).ok).toBe(true);
    expect(rulesSourceRejection(UNPARSEABLE)!.message).toMatch(/^rules did not parse at line 4, column \d+: .+\.$/);
    expect(rulesSourceRejection(PAST_COMPILE_LIMIT)).toMatchObject({
      kind: 'compile',
      message: 'rules did not compile: Line 17: Maximum allowed variable count of 10 for a given function has been reached.',
    });
  });

  test('the service-free check, for Storage callers, still accepts a Storage source', () => {
    expect(rulesGrammarRejection(STORAGE_ALLOW_ALL)).toBeNull();
    expect(rulesGrammarRejection(UNPARSEABLE)?.kind).toBe('parse');
    expect(rulesGrammarRejection(PAST_COMPILE_LIMIT)?.kind).toBe('compile');
  });
});

describe('every Firestore plane refuses a Storage ruleset', () => {
  test('in-page setRules: reads and writes are denied and inspect() names the service', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, STORAGE_ALLOW_ALL);
    const db = getFirestore(sandbox);
    const reason = `Firestore ${SERVICE_REASON}`;

    await expect(getDoc(doc(db, 'c/1'))).rejects.toThrow(reason);
    await expect(setDoc(doc(db, 'c/1'), { v: 1 })).rejects.toThrow(reason);
    const denial = sandbox.history().at(-1) as unknown as { result: string; reasons: string[] };
    expect(denial.result).toBe('deny');
    expect(denial.reasons.join(' ')).toContain(reason);

    expect(inspect(sandbox).rules.lint.findings).toContainEqual({ rule: 'PARSE_ERROR', severity: 'error', message: reason });
  });

  test("the admin handle's setRules: client reads are denied with the same reason", async () => {
    const sandbox = initializeSandbox();
    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    getAdminFirestore(sandbox.withAuth(null)).setRules(STORAGE_ALLOW_ALL);
    await expect(getDoc(doc(getFirestore(sandbox), 'c/1'))).rejects.toThrow(`Firestore ${SERVICE_REASON}`);
  });

  test('a Firestore source set after it is enforced again', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, STORAGE_ALLOW_ALL);
    setRules(sandbox, FIRESTORE_ALLOW_ALL);
    const db = getFirestore(sandbox);
    await setDoc(doc(db, 'c/1'), { v: 1 });
    expect((await getDoc(doc(db, 'c/1'))).data()).toEqual({ v: 1 });
  });

  test('the MCP simulate handler refuses it with the shared reason', () => {
    const result = new SimulateFirestoreRulesHandler().simulate(STORAGE_ALLOW_ALL, [
      { description: 'get c/1', expectation: 'ALLOW', method: 'get', path: 'c/1' } as TestCase,
    ]);
    expect(result).toMatchObject({ success: false, error: { code: 'PARSE_FAILED', message: `Firestore ${SERVICE_REASON}` } });
  });

  test('firestoreRules() refuses it with the shared reason', () => {
    let thrown: unknown;
    try {
      firestoreRules(STORAGE_ALLOW_ALL);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RulesCompileError);
    const error = thrown as RulesCompileError;
    expect(error.message).toBe("Firestore rules source failed to compile: Expected 'service cloud.firestore', got 'service firebase.storage'.");
    expect(error.issues).toEqual([{
      code: 'PARSE_ERROR',
      severity: 'error',
      message: "Expected 'service cloud.firestore', got 'service firebase.storage'.",
      line: 2,
      origin: 'parse',
    }]);
  });
});
