import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import { DocumentSnapshot, QuerySnapshot } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import {
  clearIndexedDbPersistence,
  documentSnapshotFromJSON,
  loadBundle,
  markWorkerPortStarted,
  markWorkerPortTerminated,
  namedQuery,
  onSnapshotResume,
  querySnapshotFromJSON,
} from '../../../../src/serve/worker/client/firestore-bundles-ssr.js';
import { readDocumentAs, readQueryAs } from '../../../../src/serve/worker/client/firestore-reads.js';
import { collection, doc, query, where } from '../../../../src/serve/worker/client/firestore-refs.js';
import { setDoc } from '../../../../src/serve/worker/client/firestore-writes.js';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import { restoreSharedWorker } from '../oracle-captures/support.ts';

restoreSharedWorker();

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

describe('worker client firestore-bundles-ssr', () => {
  it('hydrates bundles, SSR snapshots, onSnapshotResume, and clearIndexedDbPersistence preconditions over SharedWorker ports', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const producer = connectClientToHost(host, 'worker://unit-producer').db;
      await expect(clearIndexedDbPersistence(producer)).resolves.toBeUndefined();

      await setDoc(doc(producer, 'articles/alpha'), { title: 'Worker Post', published: true });
      expect(() => clearIndexedDbPersistence(producer)).toThrow(FirebaseError);

      const alphaSnap = await readDocumentAs(doc(producer, 'articles/alpha'), 'getDocFromCache');
      expect(alphaSnap.metadata.fromCache).toBe(true);
      const qSnap = await readQueryAs(
        query(collection(producer, 'articles'), where('published', '==', true)),
        'getDocsFromCache',
      );
      expect(qSnap.metadata.fromCache).toBe(true);

      const alphaJson = alphaSnap.toJSON() as { bundle: string };
      const queryJson = qSnap.toJSON() as { bundle: string; bundleName: string };

      const consumer = connectClientToHost(host, 'worker://unit-consumer').db;
      const hydratedDoc = documentSnapshotFromJSON(consumer, alphaJson);
      expect(hydratedDoc).toBeInstanceOf(DocumentSnapshot);
      expect(hydratedDoc.metadata.fromCache).toBe(false);
      expect(hydratedDoc.data()).toEqual({ title: 'Worker Post', published: true });

      const hydratedQuery = querySnapshotFromJSON(consumer, queryJson);
      expect(hydratedQuery).toBeInstanceOf(QuerySnapshot);
      expect(hydratedQuery.metadata.fromCache).toBe(false);
      expect(hydratedQuery.size).toBe(1);

      const progress = await loadBundle(consumer, queryJson.bundle);
      expect(progress.taskState).toBe('Success');
      const resolvedNamed = await namedQuery(consumer, queryJson.bundleName);
      expect(resolvedNamed).not.toBeNull();

      const resumed = await new Promise<{ fromCache: boolean; ids: string[] }>((resolve, reject) => {
        const unsub = onSnapshotResume(consumer, queryJson, (snap: { metadata: { fromCache: boolean }; docs: Array<{ id: string }> }) => {
          unsub();
          resolve({ fromCache: snap.metadata.fromCache, ids: snap.docs.map((d) => d.id) });
        }, reject);
      });
      expect(resumed).toEqual({ fromCache: true, ids: ['alpha'] });

      markWorkerPortStarted(consumer.port);
      markWorkerPortTerminated(consumer.port);
      await expect(clearIndexedDbPersistence(consumer)).resolves.toBeUndefined();
    } finally {
      host.sandbox.dispose();
    }
  });
});
