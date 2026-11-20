import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
});

describe('pyric-admin/firestore terminal query execution', () => {
  it('rejects negative offset at execution time and rejects limitToLast stream synchronously', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() }, 'qe-exec-app');
    const db = getFirestore(app);
    const col = db.collection('items') as ReturnType<typeof db.collection> & {
      orderBy(f: string): typeof col;
      offset(n: number): typeof col;
      limitToLast(n: number): typeof col;
      stream(): unknown;
    };
    let negOffsetThrew = false;
    try {
      await col.orderBy('rank').offset(-1).get();
    } catch {
      negOffsetThrew = true;
    }
    expect(negOffsetThrew).toBe(true);
    expect(() => col.orderBy('rank').limitToLast(1).stream()).toThrow();
  });
});
