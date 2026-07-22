/** RTDB worker-client snapshot hydration and recursive priority export. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient } from '../integration-support.js';

describe('RTDB worker snapshots', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('hydrates recursive priority metadata for exportVal and toJSON', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const rows = client.rtdbRef(rtdb, 'snapshot-priorities');
    await client.rtdbSetWithPriority(client.rtdbChild(rows, 'second'), { rank: 2 }, 20);
    await client.rtdbSetWithPriority(client.rtdbChild(rows, 'first'), { rank: 1 }, 10);

    const snapshot = await client.rtdbGet(rows);
    const exported = {
      first: { rank: 1, '.priority': 10 },
      second: { rank: 2, '.priority': 20 },
    };
    expect(snapshot.exportVal()).toEqual(exported);
    expect(snapshot.toJSON()).toEqual(exported);
    expect(snapshot.child('first').priority).toBe(10);
    expect(snapshot.child('first').exportVal()).toEqual({ rank: 1, '.priority': 10 });
  });
});
