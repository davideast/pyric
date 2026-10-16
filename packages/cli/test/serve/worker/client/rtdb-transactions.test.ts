/** RTDB worker-client optimistic transactions. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getDatabase, sandbox as rtdbSandbox } from 'pyric/database';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient } from '../integration-support.js';

describe('RTDB worker transactions', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => {
      client.setLens(undefined);
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
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

  it('never leaks unreadable server data to transactionUpdate or aborted snapshots when .read is false', async () => {
    const { ctx, db } = await connectClient();
    const hostRtdb = getDatabase(ctx.sandbox);
    rtdbSandbox.setData(hostRtdb, {
      '/vault/secret': { token: 'classified', balance: 4200 },
      '/dropoff/count': 10,
    });
    rtdbSandbox.setRules(hostRtdb, {
      rules: {
        vault: {
          '.read': false,
          '.write': false,
        },
        dropoff: {
          '.read': false,
          '.write': true,
        },
      },
    });

    const rtdb = client.rtdbGetDatabase(db);
    client.setLens({ mode: 'as', uid: 'alice' });

    const secretRef = client.rtdbRef(rtdb, 'vault/secret');
    await expect(client.rtdbGet(secretRef)).rejects.toThrow('PERMISSION_DENIED');

    const seenOnAbort: unknown[] = [];
    const aborted = await client.rtdbRunTransaction(secretRef, (current) => {
      seenOnAbort.push(current);
      return undefined;
    });
    expect(seenOnAbort).toEqual([null]);
    expect(aborted.committed).toBe(false);
    expect(aborted.snapshot.val()).toBeNull();
    expect(aborted.snapshot.exists()).toBe(false);

    const seenOnDeny: unknown[] = [];
    await expect(
      client.rtdbRunTransaction(secretRef, (current) => {
        seenOnDeny.push(current);
        return { token: 'overwritten', balance: 0 };
      }),
    ).rejects.toThrow('permission_denied');
    expect(seenOnDeny).toEqual([null]);

    const seenOnWriteOnly: unknown[] = [];
    const committed = await client.rtdbRunTransaction<number>(
      client.rtdbRef(rtdb, 'dropoff/count'),
      (current) => {
        seenOnWriteOnly.push(current);
        return 99;
      },
    );
    expect(seenOnWriteOnly).toEqual([null]);
    expect(committed.committed).toBe(true);
    expect(committed.snapshot.val()).toBe(99);
  });

  it('clones the current value passed to transactionUpdate so in-place mutation cannot corrupt abort snapshots', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const userRef = client.rtdbRef(rtdb, 'worker-api/user');
    await client.rtdbSet(userRef, { count: 1 });

    const aborted = await client.rtdbRunTransaction<{ count: number }>(
      userRef,
      (current) => {
        if (current) {
          current.count = 999;
        }
        return undefined;
      },
    );
    expect(aborted.committed).toBe(false);
    expect(aborted.snapshot.val()).toEqual({ count: 1 });
  });
});
