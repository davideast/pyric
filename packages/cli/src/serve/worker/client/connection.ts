/**
 * Worker-client connection + lifecycle — open the SharedWorker port, query the
 * worker's version/instance, drive state export/import + named branches, forward
 * agent tool-calls, and relay raw worker-protocol frames from the bridge peer.
 */

import type { InboundMessage } from '../protocol.js';
import type { WorkerOpPayload, WorkerSubPayload } from '../../../bridge/protocol.js';
import {
  nextId,
  nextSubId,
  wirePort,
  rpc,
  rpcWithTimeout,
  rawRpc,
  openSnapshotSubscription,
  closeSubscription,
} from './core.js';
import type { ClientDb } from './handles.js';

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Connect to the SharedWorker and return a client Firestore handle.
 *
 * Pass the URL of the SharedWorker script as `workerUrl`. Under `pyric dev`
 * this is `/__pyric/sdk/worker.js`; for tests or standalone use, pass the path
 * explicitly.
 *
 * `getFirestore` mirrors `pyric/firestore`'s `getFirestore(sandbox)` shape
 * but returns a `ClientDb` backed by a `MessagePort` instead of a sandbox.
 */
export interface SharedWorkerConnectionOptions {
  onError?: (error: Error) => void;
}

export function getFirestore(
  workerUrl: string | URL,
  name?: string,
  options: SharedWorkerConnectionOptions = {},
): ClientDb {
  if (typeof SharedWorker === 'undefined') {
    throw new Error(
      'SharedWorker is not available. ' +
      'Open this page over http:// (not file://) and use a supported browser ' +
      '(Chrome 4+, Firefox 29+, Safari 16.4+).',
    );
  }
  const worker = new SharedWorker(workerUrl, {
    type: 'classic',
    name: name ?? 'pyric-shared-worker',
  });
  if (options.onError) {
    worker.addEventListener('error', (event) => {
      const detail = event.message || `failed to load ${String(workerUrl)}`;
      options.onError?.(new Error(`Pyric SharedWorker error: ${detail}`));
    });
  }
  const port = worker.port;
  port.start();
  wirePort(port);
  return { __kind: 'client-db', port };
}

/**
 * Ask the worker for its baked build version (staleness guard). The page
 * compares it to the served bundle version and warns when a still-running OLD
 * worker is older than what's served (a SharedWorker can't hot-update).
 */
export async function getWorkerVersion(
  db: ClientDb,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const id = nextId();
  const timeoutMs = options.timeoutMs ?? 2_000;
  const r = (await rpcWithTimeout(
    db.port,
    { t: 'op', id, method: 'getVersion' },
    timeoutMs,
    `Timed out waiting for the Pyric SharedWorker version handshake after ${timeoutMs}ms.`,
  )) as { version: string };
  return r.version;
}

/**
 * Ask the worker for its stable per-instance id (see host `INSTANCE_ID_KEY`).
 * Studio renders a human-friendly form so a user can tell which sandbox instance
 * they're looking at — the same `localhost:<port>` in a different browser profile
 * is a SEPARATE sandbox (a separate SharedWorker + IndexedDB), and this is how
 * the two are told apart.
 */
export async function getWorkerInstanceId(db: ClientDb): Promise<string> {
  const r = (await rpc(db.port, { t: 'op', id: nextId(), method: 'getVersion' })) as { instanceId?: string };
  return r.instanceId ?? '';
}

/**
 * Phase 2 (transfer): export the FULL sandbox state as a portable bundle string
 * (the chunk format the persist layer uses, so wrapper types round-trip). Save
 * it to a file and {@link importWorkerState} it into another instance.
 */
export async function exportWorkerState(db: ClientDb): Promise<string> {
  const r = (await rpc(db.port, { t: 'op', id: nextId(), method: 'exportState' })) as { bundle: string };
  return r.bundle;
}

/** Phase 2 (clobber): replace this sandbox's ENTIRE state with `bundle`. */
export async function importWorkerState(db: ClientDb, bundle: string): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'importState', bundle });
}

/** Phase 3: save the live sandbox as a named branch (a saved state bundle). */
export async function saveWorkerBranch(db: ClientDb, name: string): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'saveBranch', name });
}

/** Phase 3: list this instance's saved branch names. */
export async function listWorkerBranches(db: ClientDb): Promise<string[]> {
  const r = (await rpc(db.port, { t: 'op', id: nextId(), method: 'listBranches' })) as { branches?: string[] };
  return r.branches ?? [];
}

/** Phase 3 (clobber): switch the live sandbox to a named branch's state. */
export async function switchWorkerBranch(db: ClientDb, name: string): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'switchBranch', name });
}

/** Phase 3: delete a named branch. */
export async function deleteWorkerBranch(db: ClientDb, name: string): Promise<void> {
  await rpc(db.port, { t: 'op', id: nextId(), method: 'deleteBranch', name });
}

/**
 * Forward an agent tool-call to the worker so it executes against the SAME
 * sandbox the app + Studio use. The worker runs the canonical tool dispatcher
 * (`buildSandboxDispatcher`) and replies with the `{ ok, summary, data }`
 * result. Used by the bridge peer on the worker path (`connectBridgePeer` in
 * `entries/runtime.ts`) so the agent shares the one authoritative sandbox.
 */
export async function callTool(
  db: ClientDb,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; summary: string; data?: unknown }> {
  return (await rpc(db.port, { t: 'tool', id: nextId(), name, args })) as {
    ok: boolean;
    summary: string;
    data?: unknown;
  };
}

// ─── Generic worker relay (remote sandbox, slice 1) ────────────────────────
//
// The bridge peer forwards `worker-op` / `worker-sub` frames from the Node
// side (`connectRemoteSandbox`) into the SharedWorker through these two
// functions (see `workerRelay` in `bridge/client/bridge.ts` + the wiring in
// `entries/runtime.ts`). Ids are re-minted LOCALLY (`nextId`/`nextSubId`) so
// relayed traffic shares this page's pending/sub maps without any chance of
// colliding with the page's own ids — the bridge correlates by ITS frame id.

/**
 * Relay one raw worker-protocol op into the SharedWorker. `op` is the op
 * message minus `t`/`id` (the `WorkerOpPayload` wire shape); resolves with
 * the worker's `res.value`, rejects with an Error carrying `.code`.
 */
export function relayWorkerOp(db: ClientDb, op: WorkerOpPayload): Promise<unknown> {
  // rawRpc, NOT rpc: the relay owns provenance and must not inherit this
  // browser page's Studio issuer. Override any untrusted incoming marker so
  // Node/agent/system traffic can never be attributed to page app activity.
  return rawRpc(db.port, {
    ...op,
    issuer: undefined,
    relaySource: 'remote',
    t: 'op',
    id: nextId(),
  } as InboundMessage);
}

/**
 * Relay a raw worker-protocol subscription into the SharedWorker. `sub` is
 * the sub message minus `t`/`subId` (the `WorkerSubPayload` wire shape).
 * `onValue` receives every snap value VERBATIM — including the worker host's
 * `{ __error: { code, message } }` establishment-failure convention (listener
 * errors are re-wrapped into the same shape so the far side sees one form).
 * Returns the unsubscribe function.
 *
 * The unified event stream (`target: 'events'`) is NOT relayable yet — its
 * history batches aren't coalescible, so it needs bounded backpressure first
 * (slice 2).
 */
export function relayWorkerSub(
  db: ClientDb,
  sub: WorkerSubPayload,
  onValue: (value: unknown) => void,
): () => void {
  if (sub.target === 'events') {
    throw new Error(
      'event-stream subscriptions cannot be relayed over the bridge yet (needs bounded backpressure — slice 2)',
    );
  }
  const subId = nextSubId();
  const opened = openSnapshotSubscription(db.port, subId, {
    port: db.port,
    next: onValue,
    error: (err) =>
      onValue({
        __error: {
          code: (err as { code?: string }).code ?? 'unknown',
          message: err instanceof Error ? err.message : String(err),
        },
      }),
  }, {
    ...sub,
    issuer: undefined,
    relaySource: 'remote',
    t: 'sub',
    subId,
  } as InboundMessage);
  if (!opened) {
    queueMicrotask(() => onValue({
      __error: { code: 'app/app-deleted', message: 'Firebase App was deleted' },
    }));
  }
  return () => {
    closeSubscription(db.port, subId);
  };
}
