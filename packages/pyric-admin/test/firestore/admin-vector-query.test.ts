import { describe, expect, it } from 'bun:test';
import { deleteApp } from '../../src/app/index.js';
import { FieldValue, getFirestore } from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

for (const armKind of ['local', 'remote'] as const) {
  describe(`pyric-admin/firestore findNearest k-NN (${armKind} arm)`, () => {
    it('orders nearest neighbors across EUCLIDEAN, COSINE, and DOT_PRODUCT', async () => {
      let pair: ReturnType<typeof inProcessFirestoreArm>;
      if (armKind === 'local') {
        pair = inProcessFirestoreArm();
      } else {
        pair = sharedWorkerFirestoreArm();
      }
      try {
        const db = getFirestore(pair.app);
        const col = db.collection('vec_items') as ReturnType<typeof db.collection> & {
          findNearest(
            field: string,
            qv: number[],
            opts: {
              limit: number;
              distanceMeasure: 'EUCLIDEAN' | 'COSINE' | 'DOT_PRODUCT';
            },
          ): {
            query: unknown;
            get(): Promise<{ docs: Array<{ id: string }> }>;
          };
        };

        await col.doc('near').set({ embedding: FieldValue.vector([1, 0]) });
        await col.doc('mid').set({ embedding: FieldValue.vector([1, 1]) });
        await col.doc('far').set({ embedding: FieldValue.vector([0, 5]) });
        await col.doc('no-vec').set({ title: 'plain' });

        const euclid = await col
          .findNearest('embedding', [1, 0], { limit: 2, distanceMeasure: 'EUCLIDEAN' })
          .get();
        expect(euclid.docs.map((d) => d.id)).toEqual(['near', 'mid']);

        const cosine = await col
          .findNearest('embedding', [0, 1], { limit: 2, distanceMeasure: 'COSINE' })
          .get();
        expect(cosine.docs.map((d) => d.id)).toEqual(['far', 'mid']);

        const dot = await col
          .findNearest('embedding', [0, 2], { limit: 2, distanceMeasure: 'DOT_PRODUCT' })
          .get();
        expect(dot.docs.map((d) => d.id)).toEqual(['far', 'mid']);
      } finally {
        await deleteApp(pair.app).catch(() => undefined);
        pair.host.dispose();
      }
    });
  });
}
