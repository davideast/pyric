import { afterEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps } from '../../src/app/index.js';
import { getDatabase, ServerValue } from '../../src/database/index.js';
import { inProcessApp, sharedWorkerApp } from './arms.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin/database: ServerValue sentinels, transaction, and callbacks', () => {
  it('resolves ServerValue.TIMESTAMP in local set, update, and push instead of storing raw sentinel objects', async () => {
    const app = inProcessApp();
    const db = getDatabase(app);

    const before = Date.now();
    await db.ref('items/alpha').set({
      title: 'first',
      createdAt: ServerValue.TIMESTAMP,
      nested: { touchedAt: ServerValue.TIMESTAMP },
    });
    const afterSet = Date.now();

    const setVal = (await db.ref('items/alpha').get()).val() as {
      title: string;
      createdAt: unknown;
      nested: { touchedAt: unknown };
    };
    expect(setVal.title).toBe('first');
    expect(typeof setVal.createdAt).toBe('number');
    expect(setVal.createdAt as number).toBeGreaterThanOrEqual(before);
    expect(setVal.createdAt as number).toBeLessThanOrEqual(afterSet);
    expect(typeof setVal.nested.touchedAt).toBe('number');

    await db.ref('items/alpha').update({
      updatedAt: ServerValue.TIMESTAMP,
      'nested/secondTouch': ServerValue.TIMESTAMP,
    });
    const updatedVal = (await db.ref('items/alpha').get()).val() as {
      updatedAt: unknown;
      nested: { touchedAt: unknown; secondTouch: unknown };
    };
    expect(typeof updatedVal.updatedAt).toBe('number');
    expect(typeof updatedVal.nested.secondTouch).toBe('number');
    expect(updatedVal.nested.touchedAt).toBe(setVal.nested.touchedAt);

    const pushedRef = await db.ref('logs').push({ at: ServerValue.TIMESTAMP });
    const pushedVal = (await pushedRef.get()).val() as { at: unknown };
    expect(typeof pushedVal.at).toBe('number');
  });

  it('resolves ServerValue.increment(delta) from missing, non-numeric, and existing numeric nodes in local set, update, and push', async () => {
    const app = inProcessApp();
    const db = getDatabase(app);

    // Missing node -> 0 + delta
    await db.ref('counters/views').set(ServerValue.increment(5));
    expect((await db.ref('counters/views').get()).val()).toBe(5);

    // Existing numeric node -> current + delta
    await db.ref('counters/views').set(ServerValue.increment(3));
    expect((await db.ref('counters/views').get()).val()).toBe(8);

    // Non-numeric existing node -> 0 + delta
    await db.ref('counters/label').set('not-a-number');
    await db.ref('counters/label').set(ServerValue.increment(4));
    expect((await db.ref('counters/label').get()).val()).toBe(4);

    // Nested & slash-path update against existing and missing targets
    await db.ref('stats').set({ likes: 10, nested: { count: 2 } });
    await db.ref('stats').update({
      likes: ServerValue.increment(-3),
      shares: ServerValue.increment(1),
      'nested/count': ServerValue.increment(5),
    });
    expect((await db.ref('stats').get()).val()).toEqual({
      likes: 7,
      shares: 1,
      nested: { count: 7 },
    });

    const pushed = await db.ref('events').push({ deltaApplied: ServerValue.increment(9) });
    expect((await pushed.get()).val()).toEqual({ deltaApplied: 9 });
  });

  it('matches remote ServerValue behavior across local and remote arms for set, update, and push', async () => {
    for (const makeApp of [inProcessApp, sharedWorkerApp]) {
      const app = makeApp();
      const db = getDatabase(app);

      await db.ref('parity/score').set(10);
      await db.ref('parity/score').set(ServerValue.increment(7));
      expect((await db.ref('parity/score').get()).val()).toBe(17);

      await db.ref('parity').update({
        score: ServerValue.increment(-2),
        stampedAt: ServerValue.TIMESTAMP,
      });
      const parityVal = (await db.ref('parity').get()).val() as { score: number; stampedAt: unknown };
      expect(parityVal.score).toBe(15);
      expect(typeof parityVal.stampedAt).toBe('number');
    }
  });

  it('invokes optional onComplete on set, update, remove, and push and once("value", successCb, failureCb, context)', async () => {
    for (const makeApp of [inProcessApp, sharedWorkerApp]) {
      const app = makeApp();
      const db = getDatabase(app);
      const events: Array<string> = [];

      await db.ref('items/cb').set({ count: 1 }, (err) => {
        events.push(`set:${String(err)}`);
      });
      await db.ref('items/cb').update({ extra: 'ok' }, (err) => {
        events.push(`update:${String(err)}`);
      });

      const ctxObj = { tag: 'bound-ctx' };
      let observedVal: unknown;
      let observedTag: unknown;
      const snap = await db.ref('items/cb').once(
        'value',
        function onOnce(s) {
          observedTag = this.tag;
          observedVal = s.val();
          events.push('once:success');
        },
        () => {
          events.push('once:failure');
        },
        ctxObj,
      );

      expect(snap.val()).toEqual({ count: 1, extra: 'ok' });
      expect(observedVal).toEqual({ count: 1, extra: 'ok' });
      expect(observedTag).toBe('bound-ctx');

      await db.ref('items/cb').remove((err) => {
        events.push(`remove:${String(err)}`);
      });
      expect((await db.ref('items/cb').get()).exists()).toBe(false);

      await db.ref('items/pushed').push({ ok: true }, (err) => {
        events.push(`push:${String(err)}`);
      });

      expect(events).toEqual([
        'set:null',
        'update:null',
        'once:success',
        'remove:null',
        'push:null',
      ]);
    }
  });

  it('isolates consumer callback throws in once("value") so failureCb is not called and snapshot still resolves on both arms', async () => {
    for (const makeApp of [inProcessApp, sharedWorkerApp]) {
      const app = makeApp();
      const db = getDatabase(app);
      await db.ref('items/onceThrow').set({ ready: true });

      let failureCalls = 0;
      const snap = await db.ref('items/onceThrow').once(
        'value',
        () => {
          throw new Error('consumer successCb boom');
        },
        () => {
          failureCalls += 1;
        },
      );

      expect(failureCalls).toBe(0);
      expect(snap.val()).toEqual({ ready: true });
    }
  });

  it('invokes failureCb with bound context when once("value") fails synchronously on a closed remote sandbox', async () => {
    const app = sharedWorkerApp();
    const db = getDatabase(app);
    await app.sandbox.dispose();

    const ctxObj = { label: 'closed-ctx' };
    let successCalls = 0;
    const failureObserved: Array<{ label: string; code: unknown }> = [];

    await expect(
      db.ref('items/closed').once(
        'value',
        () => {
          successCalls += 1;
        },
        function onFail(err) {
          failureObserved.push({
            label: this.label,
            code: (err as { code?: unknown }).code,
          });
          throw new Error('secondary failureCb throw');
        },
        ctxObj,
      ),
    ).rejects.toThrow(/closed/i);

    expect(successCalls).toBe(0);
    expect(failureObserved).toEqual([{ label: 'closed-ctx', code: 'unavailable' }]);
  });

  it('calls onComplete(null) only once and rejects the returned promise when onComplete throws on set, update, remove, and push', async () => {
    for (const makeApp of [inProcessApp, sharedWorkerApp]) {
      const app = makeApp();
      const db = getDatabase(app);

      const setCalls: Array<Error | null> = [];
      await expect(
        db.ref('items/throwCb').set({ a: 1 }, (err) => {
          setCalls.push(err);
          throw new Error('set callback boom');
        }),
      ).rejects.toThrow('set callback boom');
      expect(setCalls).toEqual([null]);

      const updateCalls: Array<Error | null> = [];
      await expect(
        db.ref('items/throwCb').update({ b: 2 }, (err) => {
          updateCalls.push(err);
          throw new Error('update callback boom');
        }),
      ).rejects.toThrow('update callback boom');
      expect(updateCalls).toEqual([null]);

      const removeCalls: Array<Error | null> = [];
      await expect(
        db.ref('items/throwCb').remove((err) => {
          removeCalls.push(err);
          throw new Error('remove callback boom');
        }),
      ).rejects.toThrow('remove callback boom');
      expect(removeCalls).toEqual([null]);

      const pushCalls: Array<Error | null> = [];
      let pushErr: unknown;
      try {
        await db.ref('items/throwPush').push({ c: 3 }, (err) => {
          pushCalls.push(err);
          throw new Error('push callback boom');
        });
      } catch (err) {
        pushErr = err;
      }
      expect((pushErr as Error | undefined)?.message).toBe('push callback boom');
      expect(pushCalls).toEqual([null]);
    }
  });
});
