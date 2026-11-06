/**
 * A rules file may hold more than one `service` block (#1900).
 *
 * Production compiles a file with a `service firebase.storage` block before
 * its `service cloud.firestore` block and evaluates the Firestore one:
 * capture `c5a-two-services-storage-first` denies get `c/1`, which only the
 * Firestore block's `allow get: if false` decides. Two `cloud.firestore`
 * blocks do not compile: capture `c5b-two-firestore-services` refuses the
 * file with "Duplicate service name declaration.".
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { inspect, setRules } from 'pyric/sandbox/firestore';
import { doc, getDoc, getFirestore } from '../../src/firestore/index.js';
import { firestoreRules } from '../../src/rules/index.js';
import { resolveModulesBrowser, rulesSourceRejection } from 'pyric/rules/internal';

/** Capture c5a's rules, as sent to production. */
const STORAGE_FIRST = "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{a=**} { allow read: if true; }\n  }\n}\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /c/{id} { allow get: if false; }\n  }\n}\n";

/** Capture c5b's rules, as sent to production. */
const TWO_FIRESTORE = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /c/{id} { allow get: if false; }\n  }\n}\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /c/{id} { allow get: if true; }\n  }\n}\n";

/** c5a with the Firestore block allowing get, so a load failure cannot pass as the denial. */
const STORAGE_FIRST_ALLOWING = STORAGE_FIRST.replace('allow get: if false;', 'allow get: if true;');

const DUPLICATE = 'Duplicate service name declaration.';

/** c5b under `2+modules`, with the allowing block first, so dropping the second block would fail open. */
const TWO_FIRESTORE_MODULES = "\n\nrules_version = '2+modules';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /c/{id} { allow get: if true; }\n  }\n}\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /c/{id} { allow get: if false; }\n  }\n}\n";

function outcome(err: unknown): string {
  return (err as { code?: string }).code ?? String(err);
}

async function getC1(rules: string): Promise<string> {
  const sandbox = initializeSandbox({});
  setRules(sandbox, rules);
  try {
    await getDoc(doc(getFirestore(sandbox), 'c/1'));
    return 'ok';
  } catch (err) {
    return outcome(err);
  }
}

describe('a Storage service before the Firestore service', () => {
  it('c5a: the Firestore block decides, so get c/1 is denied', async () => {
    expect(await getC1(STORAGE_FIRST)).toBe('permission-denied');
  });

  it('the file loads: the Firestore block allowing get lets it through', async () => {
    expect(await getC1(STORAGE_FIRST_ALLOWING)).toBe('ok');
    const sandbox = initializeSandbox({});
    setRules(sandbox, STORAGE_FIRST_ALLOWING);
    expect(inspect(sandbox).rules.lint.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('firestoreRules() compiles it', () => {
    expect(() => firestoreRules(STORAGE_FIRST)).not.toThrow();
  });
});

describe('two Firestore services', () => {
  it("c5b: setRules refuses the file with production's reason", async () => {
    const sandbox = initializeSandbox({});
    setRules(sandbox, TWO_FIRESTORE);
    await expect(getDoc(doc(getFirestore(sandbox), 'c/1'))).rejects.toThrow(DUPLICATE);
    expect(inspect(sandbox).rules.lint.findings).toContainEqual(
      expect.objectContaining({ rule: 'PARSE_ERROR', severity: 'error', message: expect.stringContaining(DUPLICATE) }),
    );
  });

  it('firestoreRules() refuses it', () => {
    expect(() => firestoreRules(TWO_FIRESTORE)).toThrow();
  });

  it('the module resolver refuses it before any load path checks the resolved source', () => {
    const resolved = resolveModulesBrowser(TWO_FIRESTORE_MODULES);
    expect(resolved).toMatchObject({ success: false, error: { message: expect.stringContaining(DUPLICATE) } });
  });

  it('the rejection names the second block, past leading blank lines', () => {
    expect(rulesSourceRejection(`\n\n${TWO_FIRESTORE}`)).toMatchObject({ kind: 'parse', line: 9, column: 1 });
  });
});
