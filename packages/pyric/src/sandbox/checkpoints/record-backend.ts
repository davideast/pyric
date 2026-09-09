/**
 * Checkpoints kept in a page's own record store, which in a browser is
 * IndexedDB.
 *
 * One record per checkpoint under its own key, plus a registry record holding
 * the ordered names. The registry exists because a
 * {@link PersistenceBackend} lists the records within a key rather than the
 * keys themselves, so without it there would be no way to answer "what
 * checkpoints are there" at all.
 *
 * The keyspace is prefixed, so a checkpoint never collides with the instance
 * id, the session record, or a service's own persisted state in the same
 * store. Nothing here touches the filesystem, so this backend is the one a
 * worker or a page uses.
 */

import type { PersistenceBackend } from '../persistence/types.js';
import {
  assertCheckpointName,
  type Checkpoint,
  type CheckpointBackend,
  type CheckpointListing,
} from './types.js';

/** The key one checkpoint's record occupies, keyed by its name. */
const CHECKPOINT_PREFIX = 'pyric:checkpoint:';

/** The key holding the ordered checkpoint names, since a store lists records, not keys. */
const CHECKPOINT_REGISTRY_KEY = 'pyric:checkpoints';

/** The one record id under each key, so a key holds exactly one value. */
const RECORD_ID = 'value';

/** The names the registry record holds, empty when it holds none. */
async function registeredNames(store: PersistenceBackend): Promise<string[]> {
  const record = (await store.getRecord(CHECKPOINT_REGISTRY_KEY, RECORD_ID)) as
    | { value?: unknown }
    | null
    | undefined;
  if (!Array.isArray(record?.value)) return [];
  return (record.value as unknown[]).filter((name): name is string => typeof name === 'string');
}

/** Replace the registry with `names`, sorted, so every listing reads one order. */
async function writeRegistry(store: PersistenceBackend, names: string[]): Promise<void> {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  await store.putRecords(CHECKPOINT_REGISTRY_KEY, new Map([[RECORD_ID, { value: sorted }]]));
}

/** One checkpoint read back, or null when the key holds nothing this backend wrote. */
async function readCheckpointRecord(
  store: PersistenceBackend,
  name: string,
): Promise<Checkpoint | null> {
  const record = (await store.getRecord(CHECKPOINT_PREFIX + name, RECORD_ID)) as
    | { value?: Checkpoint }
    | null
    | undefined;
  const checkpoint = record?.value;
  if (checkpoint === undefined || checkpoint === null) return null;
  if (typeof checkpoint.at !== 'number') return null;
  return checkpoint;
}

/**
 * Keep checkpoints as records in `store`.
 *
 * @param store The record store the host already persists into, which in the
 *              served worker is the page's own IndexedDB.
 */
export function recordCheckpointBackend(store: PersistenceBackend): CheckpointBackend {
  return {
    async write(name, checkpoint) {
      assertCheckpointName(name);
      await store.putRecords(
        CHECKPOINT_PREFIX + name,
        new Map([[RECORD_ID, { value: checkpoint }]]),
      );
      await writeRegistry(store, [...(await registeredNames(store)), name]);
    },

    async read(name) {
      assertCheckpointName(name);
      return readCheckpointRecord(store, name);
    },

    async list() {
      const listed: CheckpointListing[] = [];
      for (const name of await registeredNames(store)) {
        const checkpoint = await readCheckpointRecord(store, name);
        if (checkpoint === null) continue;
        listed.push({ name, at: checkpoint.at, counts: checkpoint.counts });
      }
      return listed;
    },

    async remove(name) {
      assertCheckpointName(name);
      const names = await registeredNames(store);
      if (!names.includes(name)) return false;
      await store.clear(CHECKPOINT_PREFIX + name);
      await writeRegistry(
        store,
        names.filter((held) => held !== name),
      );
      return true;
    },
  };
}
