import { assertGettablePath } from 'pyric/database/internal';
import { finishSdkRead } from 'pyric/sandbox/internal';
import { beginWorkerDatabaseActivity } from './sdk-activity.js';
/** RTDB reads over the worker port. */
import { nextId } from './core.js';
import type { RtdbDataSnapshot } from './handles.js';
import { markWorkerPathsWarm } from './rtdb-client-cache.js';
import { maybeWorkerOfflineGet, recordWorkerOnlineGetWire } from './rtdb-offline-state.js';
import { rtdbRpc, targetParts, type RtdbTarget } from './rtdb-references.js';
import { hydrateRtdbSnapshot } from './rtdb-snapshots.js';

export async function rtdbGet(target: RtdbTarget): Promise<RtdbDataSnapshot> {
  const { ref, query } = targetParts(target);
  const activity = beginWorkerDatabaseActivity(target, 'get', 'operation');
  try {
    // Production refuses a one-shot read under `.info`; the read never reaches the host.
    assertGettablePath(ref.path);
    const fetchOnline = async (): Promise<RtdbDataSnapshot> => {
      const op: Parameters<typeof rtdbRpc>[1] = {
        t: 'op',
        id: nextId(),
        method: 'rtdb.get',
        path: ref.path,
      };
      if (query !== undefined) {
        op.query = query;
      }
      const wire = await rtdbRpc(ref, op);
      recordWorkerOnlineGetWire(ref, query, wire);
      markWorkerPathsWarm(ref, [ref.path]);
      return hydrateRtdbSnapshot(ref, wire);
    };
    const offlineSnap = maybeWorkerOfflineGet(ref, query, fetchOnline);
    if (offlineSnap !== undefined) {
      return finishSdkRead(activity, await offlineSnap);
    }
    return finishSdkRead(activity, await fetchOnline());
  } catch (error) {
    activity.fail();
    throw error;
  }
}
