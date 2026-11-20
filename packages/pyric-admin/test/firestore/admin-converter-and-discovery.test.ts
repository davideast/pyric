import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore withConverter, listDocuments, and doc.listCollections', () => {
  it('roundtrips FirestoreDataConverter and lists child collections and phantom docs', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'conv-disc-app');
    const db = getFirestore(app);
    const rawCol = db.collection('notes') as ReturnType<typeof db.collection> & {
      withConverter<T>(c: {
        toFirestore(m: T): Record<string, unknown>;
        fromFirestore(s: { id: string; data(): Record<string, unknown> }): T;
      }): {
        doc(id: string): {
          set(m: T): Promise<unknown>;
          get(): Promise<{ data(): T | undefined }>;
        };
        where(f: string, op: '>', v: number): {
          get(): Promise<{ docs: Array<{ data(): T }> }>;
        };
      };
      listDocuments(): Promise<Array<{ id: string; get(): Promise<{ exists: boolean }> }>>;
    };

    const typed = rawCol.withConverter<{ id: string; label: string; score: number }>({
      toFirestore: (m) => ({ label: m.label.toUpperCase(), score: m.score }),
      fromFirestore: (s) => ({
        id: s.id,
        label: String(s.data().label).toLowerCase(),
        score: Number(s.data().score) * 10,
      }),
    });

    await typed.doc('n1').set({ id: 'n1', label: 'Alpha', score: 2 });
    await typed.doc('n2').set({ id: 'n2', label: 'Beta', score: 8 });
    expect((await db.doc('notes/n1').get()).data()).toEqual({ label: 'ALPHA', score: 2 });
    expect((await typed.doc('n1').get()).data()).toEqual({ id: 'n1', label: 'alpha', score: 20 });
    expect((await typed.where('score', '>', 5).get()).docs.map((d) => d.data())).toEqual([
      { id: 'n2', label: 'beta', score: 80 },
    ]);

    await db.doc('disc/real').set({ ok: true });
    await db.doc('disc/real/sub-b/x').set({ v: 1 });
    await db.doc('disc/real/sub-a/x').set({ v: 2 });
    await db.doc('disc/phantom/sub-only/x').set({ v: 3 });

    const realDoc = db.doc('disc/real') as ReturnType<typeof db.doc> & {
      listCollections(): Promise<Array<{ id: string }>>;
    };
    expect((await realDoc.listCollections()).map((c) => c.id)).toEqual(['sub-a', 'sub-b']);

    const discCol = db.collection('disc') as typeof rawCol;
    const refs = await discCol.listDocuments();
    expect(refs.map((r) => r.id)).toEqual(['phantom', 'real']);
    expect((await refs[0].get()).exists).toBe(false);
    expect((await refs[1].get()).exists).toBe(true);
  });
});
