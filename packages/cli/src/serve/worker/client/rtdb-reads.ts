/** RTDB reads over the worker port. */
import { dataRpc, nextId } from './core.js';
import type { RtdbDataSnapshot } from './handles.js';
import { targetParts, type RtdbTarget } from './rtdb-references.js';
import { hydrateRtdbSnapshot } from './rtdb-snapshots.js';

export async function rtdbGet(target: RtdbTarget): Promise<RtdbDataSnapshot> {
  const { ref, query } = targetParts(target);
  return hydrateRtdbSnapshot(ref, await dataRpc(ref.port, {
    t: 'op', id: nextId(), method: 'rtdb.get', path: ref.path, ...(query ? { query } : {}),
  }));
}
