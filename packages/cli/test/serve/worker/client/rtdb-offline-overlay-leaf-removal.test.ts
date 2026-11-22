/**
 * Worker-client RTDB offline overlay and snapshot own-property parity tests
 * covering #1935 (leaf preservation on sub-path removal) and #1925 (own keys).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import { treeWrite } from '../../../../src/serve/worker/client/rtdb-offline-overlay.js';
import { connectClient } from '../integration-support.js';

describe('RTDB worker offline overlay leaf removal and snapshot own-property checks', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('preserves nested and root primitives in treeWrite on sub-path null writes (#1935)', () => {
    expect(treeWrite({ r: { n: 'keep', m: 1 } }, '/r/n/x', null)).toEqual({ r: { n: 'keep', m: 1 } });
    expect(treeWrite({ r: { n: 'keep' } }, '/r/n/x/y', null)).toEqual({ r: { n: 'keep' } });
    expect(treeWrite('root-leaf', '/a/b', null)).toBe('root-leaf');
    expect(treeWrite({ r: { n: 'keep' } }, '/r/n/x', 'promoted')).toEqual({ r: { n: { x: 'promoted' } } });
    expect(treeWrite({ r: { n: 'keep' } }, '/r/n', null)).toBeNull();
  });

  it('preserves primitive leaves across worker offline remove and reconnect (#1935)', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const root = client.rtdbRef(rtdb, 'worker-leaf');
    await client.rtdbSet(root, { n: 'keep', m: 1 });
    let resolveInitial: (() => void) | undefined;
    const initialReady = new Promise<void>((resolve) => {
      resolveInitial = resolve;
    });
    const stop = client.rtdbOnValue(root, () => {
      resolveInitial?.();
    });
    await initialReady;

    client.rtdbGoOffline(rtdb);
    const pendingRemove = client.rtdbRemove(client.rtdbChild(root, 'n/x'));
    expect((await client.rtdbGet(root)).val()).toEqual({ n: 'keep', m: 1 });

    client.rtdbGoOnline(rtdb);
    await pendingRemove;
    expect((await client.rtdbGet(root)).val()).toEqual({ n: 'keep', m: 1 });
    stop();
  });

  it('never reports inherited Object.prototype keys as snapshot children on worker snapshots (#1925)', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const target = client.rtdbRef(rtdb, 'worker-own-props');
    await client.rtdbSet(target, { a: 1, nested: { b: 2 } });

    const snap = await client.rtdbGet(target);
    for (const key of ['valueOf', 'toString', 'hasOwnProperty']) {
      expect(snap.hasChild(key)).toBe(false);
      expect(snap.child(key).exists()).toBe(false);
      expect(snap.child(key).val()).toBeNull();
      expect(snap.hasChild(`nested/${key}`)).toBe(false);
      expect(snap.child(`nested/${key}`).val()).toBeNull();
    }
  });

  it('returns scalar primitives for unbounded ordered worker queries and null when bounded or limited (#1934)', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const status = client.rtdbRef(rtdb, 'worker-primitive-query');
    await client.rtdbSet(status, 'hello');

    const unbounded = [
      { ref: status, _spec: { orderBy: { kind: 'key' as const }, bounds: [], limit: null } },
      { ref: status, _spec: { orderBy: { kind: 'child' as const, path: 'x' }, bounds: [], limit: null } },
      { ref: status, _spec: { orderBy: { kind: 'value' as const }, bounds: [], limit: null } },
      { ref: status, _spec: { orderBy: { kind: 'priority' as const }, bounds: [], limit: null } },
    ];
    for (const q of unbounded) {
      const snap = await client.rtdbGet(q);
      expect(snap.exists()).toBe(true);
      expect(snap.val()).toBe('hello');
    }

    const bounded = [
      { ref: status, _spec: { orderBy: { kind: 'key' as const }, bounds: [], limit: { kind: 'limitToFirst' as const, n: 1 } } },
      { ref: status, _spec: { orderBy: { kind: 'key' as const }, bounds: [{ kind: 'startAt' as const, value: 'a' }], limit: null } },
    ];
    for (const q of bounded) {
      const snap = await client.rtdbGet(q);
      expect(snap.exists()).toBe(false);
      expect(snap.val()).toBeNull();
    }
  });
});
