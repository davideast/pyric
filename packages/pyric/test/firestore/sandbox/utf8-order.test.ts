import { describe, expect, it } from 'bun:test';
import * as upstreamApp from 'firebase/app';
import * as upstreamFs from 'firebase/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  disableNetwork,
  doc,
  documentId,
  getDocs,
  getFirestore,
  loadBundle,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  type QuerySnapshot,
} from 'pyric/firestore';
import { compareValues } from '../../../src/firestore/sandbox/query-value-order.js';
import { compareUtf8Strings } from '../../../src/firestore/sandbox/utf8-order.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function encodeBundleElements(elements: readonly unknown[]): string {
  const encoder = new TextEncoder();
  let out = '';
  for (const element of elements) {
    const json = JSON.stringify(element);
    out += `${encoder.encode(json).byteLength}${json}`;
  }
  return out;
}

describe('compareUtf8Strings and UTF-8 query/id ordering (#1970)', () => {
  const EMOJI = String.fromCodePoint(0x1f600);
  const PUA_START = '\uE000';
  const REPLACEMENT = '\uFFFD';
  const MAX_BMP = '\uFFFF';

  it('orders supplementary surrogate pairs after U+E000..U+FFFF matching UTF-8 byte order', () => {
    expect(compareUtf8Strings('a', 'b')).toBe(-1);
    expect(compareUtf8Strings('abc', 'abcd')).toBe(-1);
    expect(compareUtf8Strings(PUA_START, EMOJI)).toBe(-1);
    expect(compareUtf8Strings(REPLACEMENT, EMOJI)).toBe(-1);
    expect(compareUtf8Strings(MAX_BMP, EMOJI)).toBe(-1);
    expect(compareUtf8Strings(EMOJI, PUA_START)).toBe(1);
    expect(compareUtf8Strings(EMOJI, EMOJI)).toBe(0);

    // Map keys also compare in UTF-8 order rather than UTF-16 Object.keys().sort().
    expect(compareValues({ [REPLACEMENT]: 1 }, { [EMOJI]: 1 })).toBe(-1);
  });

  it('matches real firebase/firestore@12.19.0 offline bundle query ordering for string fields and document IDs', async () => {
    const parent = 'projects/utf8-order/databases/(default)/documents';
    const ts = '2026-01-15T12:00:00.000000000Z';
    const body = encodeBundleElements([
      {
        namedQuery: {
          name: 'ordered-strings',
          readTime: ts,
          bundledQuery: {
            parent,
            structuredQuery: {
              from: [{ collectionId: 'items' }],
              orderBy: [{ field: { fieldPath: 's' }, direction: 'ASCENDING' }],
            },
            limitType: 'FIRST',
          },
        },
      },
      {
        documentMetadata: { name: `${parent}/items/${EMOJI}`, readTime: ts, exists: true, queries: ['ordered-strings'] },
      },
      {
        document: { name: `${parent}/items/${EMOJI}`, fields: { s: { stringValue: EMOJI } }, updateTime: ts, createTime: ts },
      },
      {
        documentMetadata: { name: `${parent}/items/${PUA_START}`, readTime: ts, exists: true, queries: ['ordered-strings'] },
      },
      {
        document: { name: `${parent}/items/${PUA_START}`, fields: { s: { stringValue: PUA_START } }, updateTime: ts, createTime: ts },
      },
      {
        documentMetadata: { name: `${parent}/items/${REPLACEMENT}`, readTime: ts, exists: true, queries: ['ordered-strings'] },
      },
      {
        document: { name: `${parent}/items/${REPLACEMENT}`, fields: { s: { stringValue: REPLACEMENT } }, updateTime: ts, createTime: ts },
      },
    ]);
    const totalBytes = new TextEncoder().encode(body).byteLength;
    const header = encodeBundleElements([
      { metadata: { id: 'utf8-bundle', createTime: ts, version: 1, totalDocuments: 3, totalBytes } },
    ]);
    const bundle = header + body;

    const upApp = upstreamApp.initializeApp({ projectId: 'utf8-order', apiKey: 'fake' }, 'up-utf8-1970');
    const upDb = upstreamFs.initializeFirestore(upApp, {
      localCache: upstreamFs.memoryLocalCache(),
    });
    try {
      await upstreamFs.disableNetwork(upDb);
      await upstreamFs.loadBundle(upDb, bundle);
      const upByField = await upstreamFs.getDocsFromCache(
        upstreamFs.query(upstreamFs.collection(upDb, 'items'), upstreamFs.orderBy('s')),
      );
      const upAfterReplacement = await upstreamFs.getDocsFromCache(
        upstreamFs.query(upstreamFs.collection(upDb, 'items'), upstreamFs.where('s', '>', REPLACEMENT)),
      );
      const upByDocId = await upstreamFs.getDocsFromCache(upstreamFs.collection(upDb, 'items'));

      const sandbox = initializeSandbox();
      setRules(sandbox, OPEN_RULES);
      const db = getFirestore(sandbox);
      await loadBundle(db, bundle);

      const pyByField = await getDocs(query(collection(db, 'items'), orderBy('s')));
      const pyAfterReplacement = await getDocs(query(collection(db, 'items'), where('s', '>', REPLACEMENT)));
      const pyByDocId = await getDocs(collection(db, 'items'));
      const pyIdRange = await getDocs(query(collection(db, 'items'), where(documentId(), '>', REPLACEMENT)));

      expect(pyByField.docs.map((d) => d.id)).toEqual(upByField.docs.map((d) => d.id));
      expect(pyByField.docs.map((d) => d.id)).toEqual([PUA_START, REPLACEMENT, EMOJI]);
      expect(pyAfterReplacement.docs.map((d) => d.id)).toEqual(upAfterReplacement.docs.map((d) => d.id));
      expect(pyAfterReplacement.docs.map((d) => d.id)).toEqual([EMOJI]);
      expect(pyByDocId.docs.map((d) => d.id)).toEqual(upByDocId.docs.map((d) => d.id));
      expect(pyByDocId.docs.map((d) => d.id)).toEqual([PUA_START, REPLACEMENT, EMOJI]);
      expect(pyIdRange.docs.map((d) => d.id)).toEqual([EMOJI]);

      // Offline bare collection listener also preserves UTF-8 document ID order.
      await disableNetwork(db);
      const pendingEmoji = setDoc(doc(db, `offlineIds/${EMOJI}`), { v: 1 });
      const pendingPua = setDoc(doc(db, `offlineIds/${PUA_START}`), { v: 2 });
      void pendingEmoji.catch(() => {});
      void pendingPua.catch(() => {});
      const offlineIds = await new Promise<string[]>((resolve, reject) => {
        const unsub = onSnapshot(
          collection(db, 'offlineIds'),
          (snap) => {
            unsub();
            resolve((snap as QuerySnapshot).docs.map((d) => d.id));
          },
          reject,
        );
      });
      expect(offlineIds).toEqual([PUA_START, EMOJI]);
    } finally {
      await upstreamFs.terminate(upDb).catch(() => {});
      await upstreamApp.deleteApp(upApp).catch(() => {});
    }
  });
});
