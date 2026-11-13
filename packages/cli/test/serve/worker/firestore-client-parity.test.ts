import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore as getBaseAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { FieldPath, getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import * as workerClient from '../../../src/serve/worker/client.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

let seq = 0;

function makeWorkerStack() {
  const sandbox = initializeSandbox();
  getBaseAdminFirestore(sandbox).setRules(OPEN_RULES);
  const db = getFirestore(sandbox);
  const ctx: HostCtx = {
    sandbox,
    db,
    instanceId: `fs-client-parity-${++seq}`,
    subs: new Map(),
    flushPersistence: async () => {},
  };

  const hostPort: PortLike = {
    postMessage(message: OutboundMessage) {
      queueMicrotask(() => {
        clientPort.onmessage?.(new MessageEvent('message', { data: message }));
      });
    },
  };
  const clientPort: ClientPort = {
    onmessage: null,
    postMessage(message: InboundMessage) {
      queueMicrotask(async () => {
        await handleMessage(ctx, hostPort, message);
      });
    },
    start() {},
    close() {
      clientPort.onmessage = null;
    },
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };

  const wdb = workerClient.getFirestore(`worker://fs-client-parity-${seq}`);
  return {
    sandbox,
    db,
    wdb,
    dispose() {
      clientPort.close();
      sandbox.dispose();
    },
  };
}

describe('worker Firestore client dual-plane parity', () => {
  it('preserves FieldPath literal-dot segment boundaries across where, orderBy, and snapshot cursors', async () => {
    const h = makeWorkerStack();
    try {
      const items = workerClient.collection(h.wdb, 'items');
      await workerClient.setDoc(workerClient.doc(h.wdb, 'items/doc-1'), {
        'meta.tag': 'alpha-literal',
        meta: { tag: 'zzz-nested' },
      });
      await workerClient.setDoc(workerClient.doc(h.wdb, 'items/doc-2'), {
        'meta.tag': 'omega-literal',
        meta: { tag: 'aaa-nested' },
      });

      const matched = await workerClient.getDocs(
        workerClient.query(items, workerClient.where(new FieldPath('meta.tag'), '==', 'alpha-literal')),
      );
      expect(matched.docs.map((d) => d.id)).toEqual(['doc-1']);

      const ordered = await workerClient.getDocs(
        workerClient.query(items, workerClient.orderBy(new FieldPath('meta.tag'), 'asc')),
      );
      expect(ordered.docs.map((d) => d.id)).toEqual(['doc-1', 'doc-2']);

      const snap1 = await workerClient.getDoc(workerClient.doc(h.wdb, 'items/doc-1'));
      const paged = await workerClient.getDocs(
        workerClient.query(
          items,
          workerClient.orderBy(new FieldPath('meta.tag'), 'asc'),
          workerClient.startAfter(snap1),
        ),
      );
      expect(paged.docs.map((d) => d.id)).toEqual(['doc-2']);
    } finally {
      h.dispose();
    }
  });

  it('forwards SetOptions to FirestoreDataConverter.toFirestore across setDoc, writeBatch.set, and runTransaction tx.set', async () => {
    const h = makeWorkerStack();
    try {
      const seenOptions: unknown[] = [];
      const converter = {
        toFirestore(model: { title?: string; count?: number }, options?: { merge?: boolean; mergeFields?: readonly unknown[] }) {
          seenOptions.push(options);
          if (options) {
            const partial: Record<string, unknown> = {};
            if ('title' in model) partial.title = model.title;
            if ('count' in model) partial.count = model.count;
            return partial;
          }
          return { title: model.title ?? 'untitled', count: model.count ?? 0 };
        },
        fromFirestore(snap: { data(): Record<string, unknown> }) {
          return snap.data() as { title?: string; count?: number };
        },
      };

      const docA = workerClient.doc(h.wdb, 'items/doc-a').withConverter(converter);
      await workerClient.setDoc(docA, { title: 'a1', count: 7 });
      await workerClient.setDoc(docA, { title: 'a2' }, { merge: true });
      expect((await workerClient.getDoc(docA)).data()).toEqual({ title: 'a2', count: 7 });

      const docB = workerClient.doc(h.wdb, 'items/doc-b').withConverter(converter);
      await workerClient.setDoc(docB, { title: 'b1', count: 9 });
      const batch = workerClient.writeBatch(h.wdb);
      batch.set(docB, { title: 'b2' }, { merge: true });
      await batch.commit();
      expect((await workerClient.getDoc(docB)).data()).toEqual({ title: 'b2', count: 9 });

      const docC = workerClient.doc(h.wdb, 'items/doc-c').withConverter(converter);
      await workerClient.setDoc(docC, { title: 'c1', count: 11 });
      await workerClient.runTransaction(h.wdb, async (tx) => {
        tx.set(docC, { title: 'c2' }, { mergeFields: ['title'] });
      });
      expect((await workerClient.getDoc(docC)).data()).toEqual({ title: 'c2', count: 11 });
      expect(seenOptions).toEqual([
        undefined,
        { merge: true },
        undefined,
        { merge: true },
        undefined,
        { mergeFields: ['title'] },
      ]);
    } finally {
      h.dispose();
    }
  });
});
