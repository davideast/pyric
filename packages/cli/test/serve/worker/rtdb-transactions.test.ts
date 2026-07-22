/** RTDB worker-client optimistic transactions. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as client from '../../../src/serve/worker/index.js';
import { connectClient } from './integration-support.js';

describe('RTDB worker transactions', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('commits and hydrates a transaction result through the worker', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const counter = client.rtdbRef(rtdb, 'worker-api/counter');
    await client.rtdbSet(counter, 4);

    const transaction = await client.rtdbRunTransaction<number>(
      counter,
      (current) => (current ?? 0) + 1,
    );
    expect(transaction.committed).toBe(true);
    expect(transaction.snapshot.val()).toBe(5);
    expect(transaction.toJSON()).toEqual({ committed: true, snapshot: 5 });
  });
});
