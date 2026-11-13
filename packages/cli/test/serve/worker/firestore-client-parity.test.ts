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
  const globalScope = globalThis as { SharedWorker?: unknown };
  const hadSharedWorker = 'SharedWorker' in globalScope;
  const previousSharedWorker = globalScope.SharedWorker;
  globalScope.SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };

  const wdb = workerClient.getFirestore(`worker://fs-client-parity-${seq}`);
  return {
    sandbox,
    db,
    wdb,
    dispose() {
      if (hadSharedWorker) {
        globalScope.SharedWorker = previousSharedWorker;
      } else {
        delete globalScope.SharedWorker;
      }
      clientPort.close();
      sandbox.dispose();
    },
  };
}

describe('worker Firestore client dual-plane parity', () => {
  it('preserves FieldPath literal-dot and slash segment boundaries across where, orderBy, and snapshot cursors without spoofing raw backtick strings', async () => {
    const h = makeWorkerStack();
    try {
      const items = workerClient.collection(h.wdb, 'items');
      await workerClient.setDoc(workerClient.doc(h.wdb, 'items/doc-1'), {
        'meta.tag': 'alpha-literal',
        'a/b': 10,
        'a.b': { 'c/d': 'first' },
        '`meta': { 'tag`': 'backtick-nested' },
        meta: { tag: 'zzz-nested' },
      });
      await workerClient.setDoc(workerClient.doc(h.wdb, 'items/doc-2'), {
        'meta.tag': 'omega-literal',
        'a/b': 20,
        'a.b': { 'c/d': 'second' },
        meta: { tag: 'aaa-nested' },
      });

      const matched = await workerClient.getDocs(
        workerClient.query(items, workerClient.where(new FieldPath('meta.tag'), '==', 'alpha-literal')),
      );
      expect(matched.docs.map((d) => d.id)).toEqual(['doc-1']);

      const slashMatched = await workerClient.getDocs(
        workerClient.query(items, workerClient.where(new FieldPath('a.b', 'c/d'), '==', 'second')),
      );
      expect(slashMatched.docs.map((d) => d.id)).toEqual(['doc-2']);

      const rawBacktickFalse = await workerClient.getDocs(
        workerClient.query(items, workerClient.where('`meta.tag`', '==', 'alpha-literal')),
      );
      expect(rawBacktickFalse.docs.map((d) => d.id)).toEqual([]);
      const rawBacktickNested = await workerClient.getDocs(
        workerClient.query(items, workerClient.where('`meta.tag`', '==', 'backtick-nested')),
      );
      expect(rawBacktickNested.docs.map((d) => d.id)).toEqual(['doc-1']);

      const ordered = await workerClient.getDocs(
        workerClient.query(items, workerClient.orderBy(new FieldPath('meta.tag'), 'asc')),
      );
      expect(ordered.docs.map((d) => d.id)).toEqual(['doc-1', 'doc-2']);

      const slashOrdered = await workerClient.getDocs(
        workerClient.query(items, workerClient.orderBy(new FieldPath('a/b'), 'desc')),
      );
      expect(slashOrdered.docs.map((d) => d.id)).toEqual(['doc-2', 'doc-1']);

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

  it('forwards SetOptions to FirestoreDataConverter.toFirestore only on merge/mergeFields writes across setDoc, writeBatch.set, and runTransaction tx.set', async () => {
    const h = makeWorkerStack();
    try {
      interface ItemModel {
        title: string;
        count: number;
      }
      const seenCalls: Array<{ argCount: number; options: unknown }> = [];
      const converter: import('pyric/firestore').FirestoreDataConverter<ItemModel> = {
        toFirestore(
          model: import('pyric/firestore').PartialWithFieldValue<ItemModel>,
          options?: import('pyric/firestore').SetOptions,
        ) {
          seenCalls.push({ argCount: arguments.length, options });
          if (options && (options.merge || options.mergeFields !== undefined)) {
            const partial: Record<string, unknown> = {};
            if ('title' in model && model.title !== undefined) partial.title = model.title;
            if ('count' in model && model.count !== undefined) partial.count = model.count;
            return partial;
          }
          const full = model as ItemModel;
          return { title: full.title, count: full.count };
        },
        fromFirestore(snap) {
          const raw = snap.data();
          return { title: String(raw.title), count: Number(raw.count) };
        },
      };

      const docA = workerClient.doc(h.wdb, 'items/doc-a').withConverter(converter);
      await workerClient.setDoc(docA, { title: 'a1', count: 7 });
      await workerClient.setDoc(docA, { title: 'a2' }, { merge: true });
      await workerClient.setDoc(docA, { title: 'a3', count: 8 }, { merge: false });
      await workerClient.setDoc(docA, { title: 'a4', count: 9 }, {});
      expect((await workerClient.getDoc(docA)).data()).toEqual({ title: 'a4', count: 9 });

      const docB = workerClient.doc(h.wdb, 'items/doc-b').withConverter(converter);
      await workerClient.setDoc(docB, { title: 'b1', count: 9 });
      const batch = workerClient.writeBatch(h.wdb);
      batch.set(docB, { title: 'b2' }, { merge: true });
      batch.set(docB, { title: 'b3', count: 10 }, { merge: false });
      await batch.commit();
      expect((await workerClient.getDoc(docB)).data()).toEqual({ title: 'b3', count: 10 });

      const docC = workerClient.doc(h.wdb, 'items/doc-c').withConverter(converter);
      await workerClient.setDoc(docC, { title: 'c1', count: 11 });
      await workerClient.runTransaction(h.wdb, async (tx) => {
        tx.set(docC, { title: 'c2' }, { mergeFields: ['title'] });
      });
      await workerClient.runTransaction(h.wdb, async (tx) => {
        tx.set(docC, { title: 'c3', count: 12 }, { merge: false });
      });
      expect((await workerClient.getDoc(docC)).data()).toEqual({ title: 'c3', count: 12 });
      expect(seenCalls).toEqual([
        { argCount: 1, options: undefined },
        { argCount: 2, options: { merge: true } },
        { argCount: 1, options: undefined },
        { argCount: 1, options: undefined },
        { argCount: 1, options: undefined },
        { argCount: 2, options: { merge: true } },
        { argCount: 1, options: undefined },
        { argCount: 1, options: undefined },
        { argCount: 2, options: { mergeFields: ['title'] } },
        { argCount: 1, options: undefined },
      ]);
    } finally {
      h.dispose();
    }
  });
});
