/** RTDB worker-client writes and push operations. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient } from '../integration-support.js';

describe('RTDB worker writes', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('mints a synchronous push key and writes through the shared worker', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const root = client.rtdbRef(rtdb, 'scores');

    const pushed = client.rtdbPush(root, { value: 7 });

    expect(pushed.key).toMatch(/^[-0-9A-Z_a-z]{20}$/);
    expect(pushed.path).toBe(`/scores/${pushed.key}`);
    await pushed;

    const snap = await client.rtdbGet(pushed);
    expect(snap.exists()).toBe(true);
    expect(snap.val()).toEqual({ value: 7 });
  });

  it('removes data through the worker', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const target = client.rtdbRef(rtdb, 'worker-api/remove');
    await client.rtdbSet(target, { before: true });

    await client.rtdbRemove(target);

    expect((await client.rtdbGet(target)).exists()).toBe(false);
  });
});
