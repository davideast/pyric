/**
 * Shared mock-Firestore builder for `firestore/discover/*` tests.
 *
 * Implements the credential-neutral `CrawlerFirestore` seam so tests don't
 * need a real `firebase-admin` import. The
 * mock records call counts and peak in-flight RPCs into a `metrics`
 * object so concurrency caps and read-cost claims can be asserted
 * directly.
 *
 * Two doc shapes:
 *   - `{ id, fields, subs? }` — present doc; `_fieldsProto` populated
 *     from `fields` (wire-format proto values, matching `_fieldsProto`).
 *   - `{ id, subs? }` — ghost parent (no `fields`); `_fieldsProto`
 *     omitted from snapshot, mirroring real listDocuments behavior for
 *     parents that only exist as a path through to subcollections.
 */
'use strict';

import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
} from '../../../src/discover/firestore-source.js';

export type TreeSpec = Record<string, DocSpec[]>;
export type DocSpec = {
  id: string;
  subs?: TreeSpec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields?: Record<string, any>;
};

export interface MockMetrics {
  listCollectionsCalls: number;
  listDocumentsCalls: number;
  getCalls: number;
  /** Peak concurrent in-flight RPCs observed. */
  peakInFlight: number;
}

export interface MockFirestore extends CrawlerFirestore {
  metrics: MockMetrics;
}

export function buildMockFirestore(
  spec: TreeSpec,
  opts?: { rpcLatencyMs?: number },
): MockFirestore {
  const latency = opts?.rpcLatencyMs ?? 0;
  const metrics: MockMetrics = {
    listCollectionsCalls: 0,
    listDocumentsCalls: 0,
    getCalls: 0,
    peakInFlight: 0,
  };
  let inFlight = 0;

  const tick = async () => {
    inFlight++;
    metrics.peakInFlight = Math.max(metrics.peakInFlight, inFlight);
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    inFlight--;
  };

  function makeColl(parentPath: string, id: string, docs: DocSpec[]): CrawlerCollectionRef {
    const path = parentPath ? `${parentPath}/${id}` : id;
    return {
      id,
      path,
      async listDocuments() {
        metrics.listDocumentsCalls++;
        await tick();
        return docs.map((d) => makeDoc(path, d));
      },
    };
  }

  function makeDoc(parentCollPath: string, d: DocSpec): CrawlerDocumentRef {
    const path = `${parentCollPath}/${d.id}`;
    const subs = d.subs ?? {};
    const fields = d.fields;
    return {
      id: d.id,
      path,
      async listCollections() {
        metrics.listCollectionsCalls++;
        await tick();
        return Object.entries(subs).map(([subId, subDocs]) => makeColl(path, subId, subDocs));
      },
      async get() {
        metrics.getCalls++;
        await tick();
        if (fields === undefined) {
          return { ref: { path } };
        }
        return { _fieldsProto: fields, ref: { path } };
      },
    };
  }

  /**
   * Walk the spec tree from a path. Returns the matching DocSpec/TreeSpec
   * descriptor or undefined. Used by `collection(path)`/`doc(path)` to
   * support pause/resume hydration in `crawler.ts` (Item 4.2): the
   * crawler reconstructs refs from persisted paths on resume, so the
   * mock has to look them up by path the same way `db.collection(p)`
   * would on a real Firestore.
   */
  function walkColl(path: string): { id: string; docs: DocSpec[] } | undefined {
    const segs = path.split('/');
    if (segs.length % 2 === 0) return undefined; // collection paths are odd-length
    let tree: TreeSpec | undefined = spec;
    let docs: DocSpec[] | undefined;
    for (let i = 0; i < segs.length; i++) {
      if (i % 2 === 0) {
        // Collection segment.
        if (!tree) return undefined;
        docs = tree[segs[i]!];
        if (!docs) return undefined;
      } else {
        // Doc segment — descend into its subs.
        const docId = segs[i]!;
        const docSpec = docs!.find((d) => d.id === docId);
        if (!docSpec) return undefined;
        tree = docSpec.subs;
      }
    }
    return { id: segs[segs.length - 1]!, docs: docs! };
  }

  function walkDoc(path: string): { d: DocSpec; parentCollPath: string } | undefined {
    const segs = path.split('/');
    if (segs.length % 2 !== 0) return undefined; // doc paths are even-length
    const parentCollPath = segs.slice(0, -1).join('/');
    const collInfo = walkColl(parentCollPath);
    if (!collInfo) return undefined;
    const docId = segs[segs.length - 1]!;
    const d = collInfo.docs.find((x) => x.id === docId);
    if (!d) return undefined;
    return { d, parentCollPath };
  }

  return {
    metrics,
    async listCollections() {
      metrics.listCollectionsCalls++;
      await tick();
      return Object.entries(spec).map(([id, docs]) => makeColl('', id, docs));
    },
    collection(path: string): CrawlerCollectionRef {
      const info = walkColl(path);
      if (!info) throw new Error(`mock-firestore: unknown collection path "${path}"`);
      const lastSlash = path.lastIndexOf('/');
      const parentPath = lastSlash === -1 ? '' : path.slice(0, lastSlash);
      return makeColl(parentPath, info.id, info.docs);
    },
    doc(path: string): CrawlerDocumentRef {
      const info = walkDoc(path);
      if (!info) throw new Error(`mock-firestore: unknown doc path "${path}"`);
      return makeDoc(info.parentCollPath, info.d);
    },
  };
}
