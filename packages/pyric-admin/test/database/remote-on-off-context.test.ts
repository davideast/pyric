import { afterEach, describe, expect, test } from 'bun:test';
import { createRemoteSandboxHandle } from '../../../cli/src/remote/index.js';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getDatabase, type DataSnapshot } from '../../src/database/index.js';
import { inProcessApp, sharedWorkerArm } from './arms.js';

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe("pyric-admin/database on('value') and off('value') context binding", () => {
  test('binds `this` to context, keeps distinct (callback, context) pairs active, and detaches only the matching context on both arms', async () => {
    for (const makeApp of [inProcessApp, () => sharedWorkerArm().app]) {
      const app = makeApp();
      const db = getDatabase(app);
      const itemRef = db.ref('items/i1');
      await itemRef.set({ count: 1 });

      const ctxA = { subscriber: 'A' };
      const ctxB = { subscriber: 'B' };

      const deliveries: Array<{ subscriber: string | null; val: unknown }> = [];
      function sharedHandler(this: { subscriber?: string } | undefined, snap: DataSnapshot): void {
        deliveries.push({
          subscriber: this?.subscriber ?? null,
          val: snap.val(),
        });
      }

      const retA = itemRef.on('value', sharedHandler, ctxA);
      const retB = itemRef.on('value', sharedHandler, ctxB);
      expect(retA).toBe(sharedHandler);
      expect(retB).toBe(sharedHandler);
      await tick();

      expect(deliveries).toEqual([
        { subscriber: 'A', val: { count: 1 } },
        { subscriber: 'B', val: { count: 1 } },
      ]);

      const beforeSecondSet = deliveries.length;
      await itemRef.set({ count: 2 });
      await tick();
      expect(deliveries.slice(beforeSecondSet)).toEqual([
        { subscriber: 'A', val: { count: 2 } },
        { subscriber: 'B', val: { count: 2 } },
      ]);

      // Detach only ctxA; ctxB must remain subscribed.
      itemRef.off('value', sharedHandler, ctxA);
      const beforeThirdSet = deliveries.length;
      await itemRef.set({ count: 3 });
      await tick();
      expect(deliveries.slice(beforeThirdSet)).toEqual([
        { subscriber: 'B', val: { count: 3 } },
      ]);

      // Register ctxA again, a context-less registration of sharedHandler, and an unrelated handler.
      const otherDeliveries: unknown[] = [];
      const otherHandler = (snap: DataSnapshot): void => {
        otherDeliveries.push(snap.val());
      };
      itemRef.on('value', sharedHandler, ctxA);
      itemRef.on('value', sharedHandler);
      itemRef.on('value', otherHandler, ctxB);
      await tick();

      // Detaching sharedHandler without context detaches only the context-less registration,
      // leaving context-bound (ctxA, ctxB) registrations active per CallbackContext.matches.
      itemRef.off('value', sharedHandler);
      const beforeFourthSet = deliveries.length;
      const otherBeforeFourthSet = otherDeliveries.length;
      await itemRef.set({ count: 4 });
      await tick();
      expect(deliveries.slice(beforeFourthSet)).toEqual([
        { subscriber: 'B', val: { count: 4 } },
        { subscriber: 'A', val: { count: 4 } },
      ]);
      expect(otherDeliveries.slice(otherBeforeFourthSet)).toEqual([{ count: 4 }]);

      // Detach all remaining listeners at path.
      itemRef.off('value');
      const otherBeforeFifthSet = otherDeliveries.length;
      await itemRef.set({ count: 5 });
      await tick();
      expect(otherDeliveries.slice(otherBeforeFifthSet)).toEqual([]);
    }
  });

  test('4-arg on("value", cb, cancelCb, context) binds `this` on both value and cancel callbacks', async () => {
    let triggerError: ((err: Error & { code: string }) => void) | undefined;
    let triggerSnap: ((val: unknown) => void) | undefined;
    const remote = createRemoteSandboxHandle({
      serveUrl: 'http://localhost:5000',
      close: () => {},
      channel: {
        op: async () => null,
        subscribe: (_req, onSnap, onError) => {
          triggerSnap = onSnap;
          triggerError = onError;
          return () => {};
        },
      },
    });
    const app = initializeApp({ sandbox: remote }, 'cancel-ctx-app');
    const db = getDatabase(app);

    const ctx = { tag: 'watcher-1' };
    const seenValues: Array<{ tag: string | null; val: unknown }> = [];
    const seenErrors: Array<{ tag: string | null; message: string }> = [];

    db.ref('items/i2').on(
      'value',
      function onVal(this: { tag?: string } | undefined, snap: DataSnapshot) {
        seenValues.push({ tag: this?.tag ?? null, val: snap.val() });
      },
      function onCancel(this: { tag?: string } | undefined, err: Error) {
        seenErrors.push({ tag: this?.tag ?? null, message: err.message });
      },
      ctx,
    );

    triggerSnap!({ key: 'i2', exists: true, value: { ok: true }, size: 1 });
    expect(seenValues).toEqual([{ tag: 'watcher-1', val: { ok: true } }]);

    const denied = Object.assign(new Error('permission_denied'), { code: 'PERMISSION_DENIED' });
    triggerError!(denied);
    expect(seenErrors).toEqual([{ tag: 'watcher-1', message: 'permission_denied' }]);
  });
});
