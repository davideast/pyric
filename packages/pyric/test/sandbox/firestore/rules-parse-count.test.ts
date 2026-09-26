/**
 * A deployed ruleset is parsed once, not once per rules-checked request.
 *
 * Counts calls to the rules parser that the simulator and RulesState use,
 * across writes, batched writes, reads and list reads made through the
 * sandbox, and across repeated simulate() calls on a compiled ruleset.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const parserPath = new URL(
  '../grammar/FirestoreParser.js',
  import.meta.resolve('pyric/rules/internal'),
).pathname;
const parser = await import(parserPath);
const parseToAST = parser.parseToAST as (source: string) => unknown;
let parses = 0;
mock.module(parserPath, () => ({
  ...parser,
  parseToAST: (source: string) => {
    parses++;
    return parseToAST(source);
  },
}));

const { initializeSandbox } = await import('pyric/sandbox');
const { setRules } = await import('pyric/sandbox/firestore');
const { firestoreRules } = await import('pyric/rules');
const { collection, doc, getDoc, getDocs, getFirestore, setDoc, writeBatch } = await import(
  '../../../src/firestore/index.js'
);

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read: if true;
      allow write: if request.resource.data.owner == 'p0';
    }
  }
}`;

beforeEach(() => {
  parses = 0;
});

describe('rules parsing', () => {
  test('50 writes after setRules parse the ruleset once', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    setRules(sandbox, RULES);
    for (let i = 0; i < 50; i++) {
      await setDoc(doc(db, `notes/n${i}`), { owner: 'p0' });
    }
    expect(parses).toBe(1);
  });

  test('a batch, document reads and list reads reuse the same parse', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    setRules(sandbox, RULES);
    const batch = writeBatch(db);
    for (let i = 0; i < 20; i++) batch.set(doc(db, `notes/b${i}`), { owner: 'p0' });
    await batch.commit();
    for (let i = 0; i < 5; i++) {
      await getDoc(doc(db, `notes/b${i}`));
      await getDocs(collection(db, 'notes'));
    }
    expect(parses).toBe(1);
  });

  test('a later setRules call replaces the parse for the next request', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    setRules(sandbox, RULES);
    await setDoc(doc(db, 'notes/r1'), { owner: 'p0' });
    setRules(sandbox, RULES.replace("allow write: if request.resource.data.owner == 'p0';", 'allow write: if false;'));
    await expect(setDoc(doc(db, 'notes/r2'), { owner: 'p0' })).rejects.toThrow();
    await expect(setDoc(doc(db, 'notes/r3'), { owner: 'p0' })).rejects.toThrow();
    expect(parses).toBe(2);
  });

  test('a compiled ruleset does not parse again when it simulates', () => {
    const ruleset = firestoreRules(RULES);
    parses = 0;
    for (let i = 0; i < 3; i++) {
      const summary = ruleset.simulate([
        { description: 'owner write', method: 'create', path: 'notes/a', auth: null, expectation: 'ALLOW', data: { owner: 'p0' } },
      ]);
      expect(summary.passed).toBe(1);
    }
    expect(parses).toBe(0);
  });
});
