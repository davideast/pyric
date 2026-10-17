import { finishSdkRead } from 'pyric/sandbox/internal';
import { beginWorkerDatabaseActivity } from './sdk-activity.js';
/** RTDB reads over the worker port. */
import { nextId } from './core.js';
import type { RtdbDataSnapshot } from './handles.js';
import { rtdbRpc, targetParts, type RtdbTarget } from './rtdb-references.js';
import { hydrateRtdbSnapshot } from './rtdb-snapshots.js';
import { readInfo, servesInfoLocally } from './rtdb-info.js';

export async function rtdbGet(target: RtdbTarget): Promise<RtdbDataSnapshot> {
  const { ref, query } = targetParts(target);
  const activity = beginWorkerDatabaseActivity(target, 'get', 'operation');
  // The client answers `.info` itself; the read never reaches the host.
  const readsInfo = servesInfoLocally(ref);
  if (readsInfo) return finishSdkRead(activity, await readInfo(target));
  try {
    return finishSdkRead(activity, hydrateRtdbSnapshot(ref, await rtdbRpc(ref, {
      t: 'op', id: nextId(), method: 'rtdb.get', path: ref.path, ...(query ? { query } : {}),
    })));
  } catch (error) { activity.fail(); throw error; }
}
