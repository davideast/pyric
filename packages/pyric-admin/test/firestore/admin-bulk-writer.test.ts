import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';
import type { AdminBulkWriter } from '../../src/firestore/admin-bulk-writer.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore bulkWriter', () => {
  it('executes create, set, update, delete, onWriteResult, flush, and synchronous post-close throw', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'bw-app');
    const db = getFirestore(app) as ReturnType<typeof getFirestore> & {
      bulkWriter(): AdminBulkWriter;
    };
    await db.doc('bw/remove').set({ stale: true });

    const bw = db.bulkWriter();
    const seenPaths: string[] = [];
    bw.onWriteResult((ref) => {
      seenPaths.push(ref.path);
    });

    const p1 = bw.create(db.doc('bw/created'), { step: 1 });
    const p2 = bw.set(db.doc('bw/upserted'), { step: 2 });
    await bw.flush();
    await Promise.all([p1, p2]);
    const p3 = bw.update(db.doc('bw/created'), { step: 3 });
    const p4 = bw.delete(db.doc('bw/remove'));
    await bw.flush();
    await Promise.all([p3, p4]);
    await bw.close();

    expect(seenPaths.length).toBe(4);
    expect((await db.doc('bw/created').get()).data()).toEqual({ step: 3 });
    expect((await db.doc('bw/upserted').get()).data()).toEqual({ step: 2 });
    expect((await db.doc('bw/remove').get()).exists).toBe(false);

    expect(() => bw.set(db.doc('bw/closed'), { x: 1 })).toThrow(/already been closed/);
  });
});
