/**
 * A live page answers the reads its host routes to it (`tab-reads.ts`) on
 * the app's own Firestore instance, through the live row, so each read is a
 * live record like the app's own. The real `firebase/firestore` runs with
 * its network disabled: a write the app made is in its local cache, and
 * `getDoc` answers from it.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/tab-reads.test.ts'`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realFirestore from 'firebase/firestore';
import { liveModuleFor, type LiveCallRecord, type LiveModuleSite } from '../src/index.js';

interface ReadHub {
  reader?: {
    tools(): string[];
    call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }> | undefined;
  };
}

const hub = (): ReadHub | undefined => (globalThis as Record<symbol, ReadHub | undefined>)[Symbol.for('pyric.live.reads')];

const records: LiveCallRecord[] = [];
const site: LiveModuleSite = { observer: (record) => { records.push(record); }, sdkVersion: realApp.SDK_VERSION, client: 'page' };
const firestore = liveModuleFor('firebase/firestore', realFirestore, site);
const app = realApp.initializeApp({ apiKey: 'demo-api-key', projectId: 'demo-tab-reads', appId: '1:1:web:tab-reads' }, 'tab-reads');

afterAll(async () => {
  await realApp.deleteApp(app);
});

describe('a live page answers its host reads', () => {
  test('a routed firestore_get_document runs getDoc on the app instance and returns the document', async () => {
    const db = firestore.getFirestore(app);
    await realFirestore.disableNetwork(db);
    void firestore.setDoc(firestore.doc(db, 'rooms/a'), { name: 'Lobby', seats: 4 }).catch(() => undefined);
    expect(hub()?.reader?.tools()).toEqual(expect.arrayContaining(['firestore_get_document', 'firestore.getDoc', 'firestore_list_documents']));
    records.length = 0;
    const answer = await hub()?.reader?.call('firestore_get_document', { path: 'rooms/a' });
    expect(answer).toEqual({ ok: true, summary: 'Got rooms/a', data: { exists: true, data: { name: 'Lobby', seats: 4 } } });
    const read = records.find((record) => record.name === 'getDoc' && record.outcome === 'resolved');
    expect(read).toMatchObject({ module: 'firebase/firestore', path: 'rooms/a', projectId: 'demo-tab-reads' });
  });

  test('a routed collection read lists the documents in the sandbox shape', async () => {
    const answer = await hub()?.reader?.call('firestore.getDocs', { path: 'rooms' });
    expect(answer?.ok).toBe(true);
    expect(answer?.data).toEqual({ docs: [{ id: 'a', data: { name: 'Lobby', seats: 4 } }] });
  });
});
