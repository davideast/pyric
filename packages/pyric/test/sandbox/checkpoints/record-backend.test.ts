/**
 * The record-store backend: the form a checkpoint takes in a page's own
 * IndexedDB, exercised over an in-memory record store that answers the same
 * `PersistenceBackend` contract.
 */
import { describe, it, expect, beforeEach } from 'bun:test';

import {
  captureCheckpoint,
  recordCheckpointBackend,
  CheckpointNameError,
} from '../../../src/sandbox/checkpoints/index.js';
import type { PersistenceBackend } from '../../../src/sandbox/persistence/types.js';
import { populatedSandbox } from '../branches/fixtures.js';

/** A record store held in memory, answering the contract IndexedDB answers. */
function memoryStore(): PersistenceBackend & { keys(): string[] } {
  const keyed = new Map<string, Map<string, unknown>>();
  return {
    keys: () => [...keyed.keys()],
    async getRecord(key, recordId) {
      return keyed.get(key)?.get(recordId) ?? null;
    },
    async listRecords(key) {
      return [...(keyed.get(key)?.keys() ?? [])];
    },
    async putRecords(key, records) {
      const held = keyed.get(key) ?? new Map<string, unknown>();
      for (const [recordId, value] of records) held.set(recordId, value);
      keyed.set(key, held);
    },
    async deleteRecords(key, recordIds) {
      const held = keyed.get(key);
      if (held === undefined) return;
      for (const recordId of recordIds) held.delete(recordId);
    },
    async clear(key) {
      keyed.delete(key);
    },
  };
}

let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  store = memoryStore();
});

/** A checkpoint of a sandbox holding state in every service. */
async function populatedCheckpoint() {
  return captureCheckpoint(await populatedSandbox());
}

describe('the record checkpoint backend', () => {
  it('reads a checkpoint back to the value it wrote', async () => {
    const backend = recordCheckpointBackend(store);
    const checkpoint = await populatedCheckpoint();
    await backend.write('nightly', checkpoint);
    expect(await backend.read('nightly')).toEqual(checkpoint);
  });

  it('reports nothing for a name the store does not hold', async () => {
    expect(await recordCheckpointBackend(store).read('absent')).toBeNull();
  });

  it('keeps each checkpoint under its own prefixed key', async () => {
    const backend = recordCheckpointBackend(store);
    await backend.write('nightly', await populatedCheckpoint());
    expect(store.keys()).toContain('pyric:checkpoint:nightly');
    expect(store.keys()).toContain('pyric:checkpoints');
  });

  it('lists every checkpoint, ordered by name, with its counts', async () => {
    const backend = recordCheckpointBackend(store);
    await backend.write('nightly', await populatedCheckpoint());
    await backend.write('before', await populatedCheckpoint());

    const listed = await backend.list();
    expect(listed.map((entry) => entry.name)).toEqual(['before', 'nightly']);
    expect(listed[0]!.counts).toEqual({ firestore: 2, database: 1, storage: 1, auth: 1 });
  });

  it('registers a name once when the same name is written twice', async () => {
    const backend = recordCheckpointBackend(store);
    await backend.write('nightly', await populatedCheckpoint());
    const second = await populatedCheckpoint();
    await backend.write('nightly', second);

    expect((await backend.list()).map((entry) => entry.name)).toEqual(['nightly']);
    expect(await backend.read('nightly')).toEqual(second);
  });

  it('lists nothing when the store holds no checkpoints', async () => {
    expect(await recordCheckpointBackend(store).list()).toEqual([]);
  });

  it('removes one checkpoint and reports whether there was one to remove', async () => {
    const backend = recordCheckpointBackend(store);
    await backend.write('nightly', await populatedCheckpoint());
    expect(await backend.remove('nightly')).toBe(true);
    expect(await backend.list()).toEqual([]);
    expect(await backend.read('nightly')).toBeNull();
    expect(await backend.remove('nightly')).toBe(false);
  });

  it('skips a record that carries no format tag rather than reading it as state', async () => {
    const backend = recordCheckpointBackend(store);
    await backend.write('nightly', await populatedCheckpoint());
    await store.putRecords(
      'pyric:checkpoint:nightly',
      new Map([['value', { value: { at: Date.now(), counts: {}, state: {} } }]]),
    );

    expect(await backend.read('nightly')).toBeNull();
    expect(await backend.list()).toEqual([]);
  });

  it('skips a record whose format tag is another writer\'s', async () => {
    const backend = recordCheckpointBackend(store);
    await backend.write('nightly', await populatedCheckpoint());
    await store.putRecords(
      'pyric:checkpoint:nightly',
      new Map([['value', { value: { format: 'someone-elses-v9', at: 1, counts: {}, state: {} } }]]),
    );

    expect(await backend.read('nightly')).toBeNull();
  });

  it('refuses a name that is not one record key', async () => {
    const backend = recordCheckpointBackend(store);
    expect(backend.read('a/b')).rejects.toThrow(CheckpointNameError);
    expect(backend.remove('')).rejects.toThrow(CheckpointNameError);
  });
});
