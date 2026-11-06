/**
 * The values a page sends with each observed call, so the host's local rules
 * can read `request.auth.token`, `request.resource.data` and `resource.data`:
 * the token's claim values with its emails left out, the data a
 * `setDoc`, `updateDoc` or `addDoc` wrote, and the document a `getDoc`
 * returned. They ride the observed call to the host only.
 *
 * The real `firebase/firestore` runs with no backend reachable: its network
 * is disabled before any call, so a read answers from the memory cache.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/observed-values.test.ts'`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realFirestore from 'firebase/firestore';
import { firestoreContext } from '../src/firestore.js';
import { observedCallOf } from '../src/page-observer.js';
import { accountOf, liveModuleFor, noteAuth, type LiveCallRecord, type LiveModuleSite } from '../src/index.js';

function idToken(claims: Record<string, unknown>): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment(claims)}.c2ln`;
}

const CLAIMS = {
  admin: true,
  role: 'editor',
  sub: 'alice',
  email: 'alice@example.com',
  email_verified: true,
  firebase: { identities: { email: ['alice@example.com'], 'google.com': ['1234'] }, sign_in_provider: 'password' },
};

describe('claim values', () => {
  const app = { name: 'values', options: { projectId: 'values-project' } };
  noteAuth({ app, currentUser: { uid: 'alice', accessToken: idToken(CLAIMS) } });

  test('an account carries its claim values without the email or the identity emails', () => {
    const account = accountOf({ firestore: { app } });
    expect(account?.claims).toEqual({
      admin: true,
      role: 'editor',
      sub: 'alice',
      email_verified: true,
      firebase: { identities: { 'google.com': ['1234'] }, sign_in_provider: 'password' },
    });
    expect(JSON.stringify(account)).not.toContain('alice@example.com');
  });

  test('the observed call the host gets carries the claim values', () => {
    const account = accountOf({ firestore: { app } })!;
    const record: LiveCallRecord = { module: 'firebase/firestore', name: 'getDoc', outcome: 'resolved', account };
    expect(observedCallOf(record, 1)?.account?.claims).toMatchObject({ admin: true, role: 'editor' });
  });
});

describe('write data', () => {
  const app = realApp.initializeApp({ apiKey: 'demo', projectId: 'demo-values', appId: '1:1:web:values' }, 'live-values');
  const db = realFirestore.getFirestore(app);
  const ref = realFirestore.doc(db, 'rooms/a');

  afterAll(async () => {
    await realFirestore.terminate(db);
    await realApp.deleteApp(app);
  });

  test('setDoc, updateDoc and addDoc carry the fields they wrote', () => {
    const data = { title: 'Lobby', size: 3, tags: ['a'], owner: { uid: 'alice' } };
    expect(firestoreContext('setDoc', [ref, data]).writeData).toEqual(data);
    expect(firestoreContext('updateDoc', [ref, { size: 4 }]).writeData).toEqual({ size: 4 });
    expect(firestoreContext('addDoc', [realFirestore.collection(db, 'rooms'), data]).writeData).toEqual(data);
  });

  test('a merge write carries no write data', () => {
    expect(firestoreContext('setDoc', [ref, { size: 4 }, { merge: true }]).writeData).toBeUndefined();
  });

  test('a write with a value that is not JSON carries no write data', () => {
    expect(firestoreContext('setDoc', [ref, { at: realFirestore.serverTimestamp() }]).writeData).toBeUndefined();
  });

  test('a read carries no write data', () => {
    expect(firestoreContext('getDoc', [ref, { size: 4 }]).writeData).toBeUndefined();
  });

  test('the observed call the host gets carries the write data', () => {
    const record: LiveCallRecord = { module: 'firebase/firestore', name: 'setDoc', outcome: 'rejected', code: 'permission-denied', writeData: { size: 4 } };
    expect(observedCallOf(record, 1)?.writeData).toEqual({ size: 4 });
  });
});

describe("a getDoc's returned document", async () => {
  const records: LiveCallRecord[] = [];
  const site: LiveModuleSite = { observer: (record) => records.push(record), sdkVersion: realApp.SDK_VERSION, client: 'node' };
  const firestore = liveModuleFor('firebase/firestore', realFirestore, site);
  const app = realApp.initializeApp({ apiKey: 'demo', projectId: 'demo-values-read', appId: '1:1:web:values-read' }, 'live-values-read');
  const db = firestore.getFirestore(app);
  await realFirestore.disableNetwork(db);

  afterAll(async () => {
    await realFirestore.terminate(db);
    await realApp.deleteApp(app);
  });

  test('a resolved getDoc carries the fields of the document it returned, and the host gets them', async () => {
    const ref = firestore.doc(db, 'rooms/b');
    void realFirestore.setDoc(ref, { title: 'Hall', size: 2 });
    records.length = 0;
    await firestore.getDoc(ref);
    const resolved = records.filter((record) => record.name === 'getDoc' && record.outcome === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.document).toEqual({ title: 'Hall', size: 2 });
    expect(observedCallOf(resolved[0]!, 1)?.document).toEqual({ title: 'Hall', size: 2 });
  });
});
