/**
 * The served worker client refuses writes under `/.info` the way the
 * production SDK does (capture rtdb-modular-info-write-validation): each
 * write API throws synchronously before anything reaches the worker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient } from '../integration-support.js';

const behavior = JSON.parse(readFileSync(join(
  import.meta.dir, '..', '..', '..', '..', '..', 'conformance', 'observations', 'rtdb-modular',
  'rtdb-modular-info-write-validation.json',
), 'utf8')).behavior as Record<string, { timing: string; message?: string }>;

function thrown(task: () => unknown): { timing: string; message?: string } {
  try {
    const pending = task() as Promise<unknown> | undefined;
    void pending?.then?.(undefined, () => undefined);
    return { timing: 'returned' };
  } catch (error) {
    return { timing: 'synchronous-throw', message: (error as Error).message };
  }
}

describe('RTDB worker client writes under /.info', () => {
  let restoreSW: () => void;
  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('throws synchronously with the SDK message for every write the capture throws for', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const connected = client.rtdbRef(rtdb, '.info/connected');
    const info = client.rtdbRef(rtdb, '.info');
    const writes: Record<string, () => unknown> = {
      set: () => client.rtdbSet(connected, false),
      setNested: () => client.rtdbSet(client.rtdbRef(rtdb, '.info/custom/child'), 1),
      setWithPriority: () => client.rtdbSetWithPriority(connected, false, 1),
      setPriority: () => client.rtdbSetPriority(connected, 1),
      remove: () => client.rtdbRemove(connected),
      push: () => client.rtdbPush(info, 1),
      runTransaction: () => client.rtdbRunTransaction(connected, () => false),
      updateFromRoot: () => client.rtdbUpdate(client.rtdbRef(rtdb), { '.info/connected': false }),
      onDisconnectSet: () => client.rtdbOnDisconnect(connected).set(false),
      onDisconnectSetWithPriority: () => client.rtdbOnDisconnect(connected).setWithPriority(false, 1),
      onDisconnectUpdate: () => client.rtdbOnDisconnect(info).update({ connected: false }),
      onDisconnectRemove: () => client.rtdbOnDisconnect(connected).remove(),
    };
    for (const [name, write] of Object.entries(writes)) {
      expect(behavior[name]!.timing, name).toBe('synchronous-throw');
      expect(thrown(write), name).toEqual({ timing: 'synchronous-throw', message: behavior[name]!.message });
    }
  });

  it('rejects an update on a .info reference with the database error', async () => {
    const { db } = await connectClient();
    const info = client.rtdbRef(client.rtdbGetDatabase(db), '.info');
    const error = await client.rtdbUpdate(info, { connected: false }).then(() => null, (caught: Error) => caught);
    expect(error?.message).toBe(behavior.updateOnInfo!.message);
  });
});
