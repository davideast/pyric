import { expect, test } from 'bun:test';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getFirestore, doc, getDoc, setDoc, writeBatch } from '../../src/firestore/index.js';

const rules = (condition: string) => `rules_version = '2'; service cloud.firestore {
 match /databases/{db}/documents { match /messages/{id} { allow read, write: if ${condition}; } }
}`;

function setup(condition: string) {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.deployRules(rules(condition));
  const events: SandboxEvent[] = [];
  sandbox.onEvent(event => events.push(event));
  const requests = () => events.filter(event => event.kind === 'request');
  return { sandbox, env, requests, db: getFirestore(sandbox.withAuth(null)) };
}

test('denial evidence survives changed rules and contains short-circuit evidence', async () => {
  const { db, env, requests } = setup('request.auth != null && request.auth.uid == "owner"');
  await expect(getDoc(doc(db, 'messages/current'))).rejects.toMatchObject({ code: 'permission-denied' });
  const original = requests().at(-1)!.rulesEvidence!;
  expect(original.decision).toBe('DENY');
  expect(original.rules.flatMap(rule => rule.checks).some(check => check.state === 'skipped')).toBe(true);
  const snapshot = JSON.stringify(original);
  env.deployRules(rules('true'));
  await getDoc(doc(db, 'messages/current'));
  expect(requests().at(-1)!.rulesEvidence!.version).not.toBe(original.version);
  expect(JSON.stringify(original)).toBe(snapshot);
});

test('write and batch evidence reflect the original conditions', async () => {
  const { db, requests } = setup('request.resource.data.version >= 0');
  await expect(setDoc(doc(db, 'messages/current'), { version: -1, secret: 'not inspected' })).rejects.toBeDefined();
  const evidence = requests().at(-1)!.rulesEvidence!;
  expect(evidence.decision).toBe('DENY');
  expect(JSON.stringify(evidence)).not.toContain('not inspected');
  expect(evidence.rules.flatMap(rule => rule.checks).some(check => check.state === 'value' && check.value === -1)).toBe(true);
  const batch = writeBatch(db);
  batch.set(doc(db, 'messages/other'), { version: -2 });
  await expect(batch.commit()).rejects.toBeDefined();
  expect(requests().at(-1)!.rulesEvidence!.decision).toBe('DENY');
});

test('a granting alternative wins over a failed condition', async () => {
  const { db, env, requests } = setup('false');
  env.deployRules(`rules_version = '2'; service cloud.firestore { match /databases/{db}/documents {
    match /messages/{id} { allow read: if false; }
    match /{all=**} { allow read: if true; }
  } }`);
  await getDoc(doc(db, 'messages/current'));
  const evidence = requests().at(-1)!.rulesEvidence!;
  expect(evidence.decision).toBe('ALLOW');
  expect(evidence.rules.some(rule => rule.verdict === 'ALLOW')).toBe(true);
});

test('evaluation errors remain distinct from false', async () => {
  const { db, requests } = setup('request.auth.uid == "owner"');
  await expect(getDoc(doc(db, 'messages/current'))).rejects.toBeDefined();
  expect(requests().at(-1)!.rulesEvidence!.rules.some(rule => rule.verdict === 'ERROR')).toBe(true);
});

test('query-proof rejection captures its original version and location', async () => {
  const { db, env, requests } = setup('resource.data.owner == "alice"');
  const { collection, getDocs } = await import('../../src/firestore/index.js');
  await expect(getDocs(collection(db, 'messages'))).rejects.toBeDefined();
  const original = requests().at(-1)!.rulesEvidence!;
  expect(original.queryProof?.kind).toBe('constraints-not-satisfied');
  expect(original.queryProof!.failures[0]!.line).toBeDefined();
  const snapshot = JSON.stringify(original);
  env.deployRules(rules('true'));
  await getDoc(doc(db, 'messages/current'));
  expect(requests().at(-1)!.rulesEvidence!.version).not.toBe(original.version);
  expect(JSON.stringify(original)).toBe(snapshot);
});

test('history expires old evidence without changing an inspected snapshot', async () => {
  const { sandbox, db } = setup('false');
  await expect(getDoc(doc(db, 'messages/first'))).rejects.toBeDefined();
  const first = sandbox.history().find(event => event.kind === 'request')!;
  if (first.kind !== 'request') throw new Error('Expected request');
  const snapshot = JSON.stringify(first.rulesEvidence);
  for (let index = 0; index < 65; index++) {
    await expect(getDoc(doc(db, `messages/${index}`))).rejects.toBeDefined();
  }
  const retained = sandbox.history().filter(event => event.kind === 'request');
  expect(retained.filter(event => event.rulesEvidence !== undefined)).toHaveLength(64);
  expect(retained[0]!.rulesEvidenceExpired).toBe(true);
  expect(JSON.stringify(first.rulesEvidence)).toBe(snapshot);
});

test('reset and history priming preserve the evidence retention boundary', async () => {
  const { sandbox, db, requests } = setup('false');
  const { primeEventHistory } = await import('pyric/sandbox/internal');
  for (let index = 0; index < 66; index++) await expect(getDoc(doc(db, `messages/${index}`))).rejects.toBeDefined();
  const imported = requests();
  const saved = JSON.stringify(imported);
  sandbox.reset();
  expect(primeEventHistory(sandbox, imported)).toBe(imported.length);
  expect(sandbox.history().filter(event => event.kind === 'request' && event.rulesEvidence)).toHaveLength(64);
  getInternalEnv(sandbox).deployRules(rules('false'));
  await expect(getDoc(doc(getFirestore(sandbox.withAuth(null)), 'messages/new'))).rejects.toBeDefined();
  expect(sandbox.history().filter(event => event.kind === 'request' && event.rulesEvidence)).toHaveLength(64);
  expect(JSON.stringify(imported)).toBe(saved);
});
