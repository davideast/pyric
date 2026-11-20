import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore Query.{select, offset, count, stream, explain, explainStream}', () => {
  it('supports projection, offset+limit composition, count, stream, and explain shapes', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'qe-app');
    const db = getFirestore(app);
    const col = db.collection('items') as ReturnType<typeof db.collection> & {
      orderBy(field: string, dir?: 'asc' | 'desc'): typeof col;
      offset(n: number): typeof col;
      limit(n: number): typeof col;
      limitToLast(n: number): typeof col;
      select(...fields: string[]): typeof col;
      count(): { get(): Promise<{ data(): { count: number } }> };
      stream(): AsyncIterable<{ id: string }>;
      explain(opts?: { analyze?: boolean }): Promise<{
        metrics: {
          planSummary: { indexesUsed: unknown[] };
          executionStats: { resultsReturned: number } | null;
        };
        snapshot: { docs: Array<{ id: string }> } | null;
      }>;
      explainStream(opts?: { analyze?: boolean }): AsyncIterable<{
        document?: { id: string };
        metrics?: unknown;
      }>;
    };

    await col.doc('a').set({ title: 'Alpha', rank: 1, meta: { tag: 'x', secret: 's1' } });
    await col.doc('b').set({ title: 'Beta', rank: 2, meta: { tag: 'y', secret: 's2' } });
    await col.doc('c').set({ title: 'Gamma', rank: 3, meta: { tag: 'z', secret: 's3' } });

    const projSnap = await col.orderBy('rank', 'asc').offset(1).limit(1).select('title', 'meta.tag').get();
    expect(projSnap.docs.map((d) => d.id)).toEqual(['b']);
    expect(projSnap.docs[0]?.data()).toEqual({ title: 'Beta', meta: { tag: 'y' } });

    expect((await col.count().get()).data().count).toBe(3);

    const streamed: string[] = [];
    for await (const doc of col.orderBy('rank', 'asc').stream()) {
      streamed.push(doc.id);
    }
    expect(streamed).toEqual(['a', 'b', 'c']);

    const planOnly = await col.orderBy('rank', 'asc').explain();
    expect(planOnly.metrics.executionStats).toBeNull();
    expect(planOnly.snapshot).toBeNull();

    const analyzed = await col.orderBy('rank', 'asc').explain({ analyze: true });
    expect(analyzed.metrics.executionStats?.resultsReturned).toBe(3);
    expect(analyzed.snapshot?.docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);

    const streamDocs: string[] = [];
    let sawMetrics = false;
    for await (const chunk of col.orderBy('rank', 'asc').explainStream({ analyze: true })) {
      if (chunk.document !== undefined) streamDocs.push(chunk.document.id);
      if (chunk.metrics !== undefined) sawMetrics = true;
    }
    expect(streamDocs).toEqual(['a', 'b', 'c']);
    expect(sawMetrics).toBe(true);
  });
});
