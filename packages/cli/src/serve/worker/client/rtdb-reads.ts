import { finishSdkRead } from 'pyric/sandbox/internal';
import { beginWorkerDatabaseActivity } from './sdk-activity.js';
/** RTDB reads over the worker port. */
import { nextId } from './core.js';
import type { RtdbDataSnapshot } from './handles.js';
import { rtdbRpc, targetParts, type RtdbTarget } from './rtdb-references.js';
import { hydrateRtdbSnapshot } from './rtdb-snapshots.js';

export async function rtdbGet(target: RtdbTarget): Promise<RtdbDataSnapshot> {
  const { ref, query } = targetParts(target);
  const activity = beginWorkerDatabaseActivity(target, 'get', 'operation');
  try {
    return finishSdkRead(activity, hydrateRtdbSnapshot(ref, await rtdbRpc(ref, {
      t: 'op', id: nextId(), method: 'rtdb.get', path: ref.path, ...(query ? { query } : {}),
    })));
  } catch (error) { activity.fail(); throw error; }
}
