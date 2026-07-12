/**
 * SharedWorker host — public barrel over the per-family modules under `host/`.
 *
 * The host is the SharedWorker's data plane: one `HostCtx` shared across ALL
 * connected ports, driven per message by `handleMessage(ctx, port, msg)`. It is
 * deliberately decoupled from `SharedWorkerGlobalScope` so unit tests can drive
 * it with a REAL pyric sandbox + fake MessagePort objects — no browser or
 * SharedWorker runtime required. The entry point (`entry.ts`) creates the real
 * sandbox + db and wires the connecting ports to this module.
 *
 * This file re-exports only the host's PUBLIC surface; the implementation lives
 * in the per-family modules (mirroring the client split under `client/`):
 *   - `host/core`            shared lens/handle resolution, descriptor → ref
 *                            resolution, snapshot serialization, op provenance
 *   - `host/dispatch`        `handleMessage` seam + family routing + `cleanupPort`
 *   - `host/firestore-reads` getDoc/getDocs/count/aggregate/keyspace ops
 *   - `host/firestore-writes` set/update/delete/add/batch/txn ops (+ sentinels)
 *   - `host/rules`           firestore/rtdb rules deploy + status
 *   - `host/admin-firestore` admin-lens document ops (rules bypass)
 *   - `host/rtdb`            RTDB modular ops + snapshot→wire shaping
 *   - `host/storage`         worker-backed Cloud Storage ops + lens resolver
 *   - `host/connection`      version / state transfer / branches + instance id
 *   - `host/studio`          runtime confirm-policy + sandbox snapshot
 *   - `host/subscriptions`   Firestore/RTDB value-subscription registry (#754)
 *
 * The already-extracted auth / AI / events / messaging families keep their
 * sibling `host-*.ts` modules; `host/dispatch` routes to them.
 *
 * `HostCtx` + the shared reply/port primitives live in `host-context.ts` (the
 * engine-free dependency root).
 */

// Auth surface used by serve-init (ensureAuth) + the per-port session accessor.
export { ensureAuth, portSession } from './host-auth.js';
export type { HostCtx, PortLike } from './host-context.js';
// Instance-id + named-branch surface (part of the host's public shape:
// serve-init imports getOrCreateInstanceId; tests import the rest).
export {
  INSTANCE_ID_KEY,
  randomUuid,
  getOrCreateInstanceId,
  BRANCH_PREFIX,
  BRANCH_REGISTRY_KEY,
  listBranchNames,
} from './host/connection.js';
// The message dispatcher seam (entry.ts + tests) and per-port teardown.
export { handleMessage, cleanupPort } from './host/dispatch.js';
