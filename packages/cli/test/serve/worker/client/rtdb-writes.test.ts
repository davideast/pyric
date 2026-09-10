/** RTDB worker-client writes and push operations. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getClock } from 'pyric/sandbox';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient, sleep } from '../integration-support.js';

/** The alphabet a push key's timestamp prefix is written in. */
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/** The instant a push key's first eight characters encode. */
function instantOf(key: string): number {
  let instant = 0;
  for (const character of key.slice(0, 8)) {
    instant = instant * 64 + PUSH_CHARS.indexOf(character);
  }
  return instant;
}

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

  it('mints a push key at the pinned instant, not the wall clock', async () => {
    const pinned = Date.UTC(2031, 0, 1);
    const { ctx, db } = await connectClient();
    // The mirror is streamed to the port, so let the subscription land before
    // pinning, and let the pin land before minting.
    await sleep();
    getClock(ctx.sandbox).set(pinned);
    await sleep();

    const rtdb = client.rtdbGetDatabase(db);
    const pushed = client.rtdbPush(client.rtdbRef(rtdb, 'scores'), { value: 7 });
    await pushed;

    expect(instantOf(pushed.key!)).toBe(pinned);
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
