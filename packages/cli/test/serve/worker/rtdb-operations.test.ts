/** RTDB worker-client reads, writes, priorities, queries, and push operations. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  endBefore as rtdbEndBefore,
  limitToFirst as rtdbLimitToFirst,
  orderByChild as rtdbOrderByChild,
  orderByPriority as rtdbOrderByPriority,
  query as buildRtdbQuery,
  startAt as rtdbStartAt,
} from 'pyric/database';
import * as client from '../../../src/serve/worker/index.js';
import { connectClient } from './integration-support.js';

describe('RTDB worker operations', () => {
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

  it('executes priority and child-order queries through the worker', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const scores = client.rtdbRef(rtdb, 'worker-api/scores');
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'ada'), { score: 7 }, 20);
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'grace'), { score: 9 }, 10);
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'lin'), { score: 11 }, 30);

    const priorityWindow = buildRtdbQuery(scores as never, rtdbOrderByPriority(), rtdbLimitToFirst(2));
    const initialKeys: string[] = [];
    (await client.rtdbGet(priorityWindow as never)).forEach((snap) => { initialKeys.push(snap.key!); });
    expect(initialKeys).toEqual(['grace', 'ada']);

    const scoreWindow = buildRtdbQuery(
      scores as never,
      rtdbOrderByChild('score'),
      rtdbStartAt(8),
      rtdbEndBefore(11),
    );
    const scoreKeys: string[] = [];
    (await client.rtdbGet(scoreWindow as never)).forEach((snap) => { scoreKeys.push(snap.key!); });
    expect(scoreKeys).toEqual(['grace']);

    await client.rtdbRemove(client.rtdbChild(scores, 'grace'));
    expect((await client.rtdbGet(client.rtdbChild(scores, 'grace'))).exists()).toBe(false);
  });
});
