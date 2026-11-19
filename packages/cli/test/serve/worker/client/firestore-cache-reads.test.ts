import { describe, expect, it } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import { sdkActivity, type SdkActivityEvent } from 'pyric/sandbox/internal';
import { readDocumentAs, readQueryAs } from '../../../../src/serve/worker/client/firestore-reads.js';
import { collection, doc, orderBy, query, where } from '../../../../src/serve/worker/client/firestore-refs.js';
import { deleteDoc, setDoc } from '../../../../src/serve/worker/client/firestore-writes.js';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import { restoreSharedWorker } from '../oracle-captures/support.ts';

restoreSharedWorker();

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

describe('worker client firestore-cache-reads', () => {
  it('rejects cold getDocFromCache with unavailable and records failed sdkActivity', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    const events: SdkActivityEvent[] = [];
    const stop = sdkActivity.subscribe((ev) => events.push(ev));
    try {
      const seeder = connectClientToHost(host, 'worker://cache-seeder').db;
      const reader = connectClientToHost(host, 'worker://cache-reader').db;
      await setDoc(doc(seeder, 'items/server-only'), { label: 'remote' });

      await expect(
        readDocumentAs(doc(reader, 'items/server-only'), 'getDocFromCache'),
      ).rejects.toMatchObject({ code: 'unavailable' });

      const cacheEnds = events.filter(
        (ev) => ev.phase === 'end' && ev.record.method === 'getDocFromCache',
      );
      expect(cacheEnds.at(-1)?.record.status).toBe('failed');

      const coldQuery = await readQueryAs(collection(reader, 'items'), 'getDocsFromCache');
      expect(coldQuery.size).toBe(0);
      expect(coldQuery.empty).toBe(true);
      expect(coldQuery.metadata.fromCache).toBe(true);

      const serverQuery = await readQueryAs(collection(reader, 'items'), 'getDocsFromServer');
      expect(serverQuery.size).toBe(1);
      expect(serverQuery.metadata.fromCache).toBe(false);

      const warmDoc = await readDocumentAs(doc(reader, 'items/server-only'), 'getDocFromCache');
      expect(warmDoc.exists()).toBe(true);
      expect(warmDoc.data()).toEqual({ label: 'remote' });
      expect(warmDoc.metadata.fromCache).toBe(true);

      const warmQuery = await readQueryAs(collection(reader, 'items'), 'getDocsFromCache');
      expect(warmQuery.size).toBe(1);
      expect(warmQuery.metadata.fromCache).toBe(true);
    } finally {
      stop();
      host.sandbox.dispose();
    }
  });

  it('evaluates filtered/ordered queries over per-client cached paths and evicts deleted paths', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const writer = connectClientToHost(host, 'worker://cache-writer').db;
      const other = connectClientToHost(host, 'worker://cache-other').db;

      await setDoc(doc(writer, 'items/a'), { active: true, rank: 10 });
      await setDoc(doc(writer, 'items/b'), { active: true, rank: 20 });
      await setDoc(doc(other, 'items/c'), { active: true, rank: 30 });

      const filtered = query(
        collection(writer, 'items'),
        where('active', '==', true),
        orderBy('rank', 'desc'),
      );
      const warmFiltered = await readQueryAs(filtered, 'getDocsFromCache');
      expect(warmFiltered.docs.map((d) => d.id)).toEqual(['b', 'a']);
      expect(warmFiltered.metadata.fromCache).toBe(true);

      await deleteDoc(doc(writer, 'items/a'));
      await expect(
        readDocumentAs(doc(writer, 'items/a'), 'getDocFromCache'),
      ).rejects.toMatchObject({ code: 'unavailable' });

      const afterDelete = await readQueryAs(filtered, 'getDocsFromCache');
      expect(afterDelete.docs.map((d) => d.id)).toEqual(['b']);
    } finally {
      host.sandbox.dispose();
    }
  });
});
