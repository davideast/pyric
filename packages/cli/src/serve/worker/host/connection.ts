/**
 * SharedWorker host — connection / instance / state-transfer ops.
 *
 * The worker-lifecycle surface the client's `connection` family talks to:
 *   - `getVersion` (build hash + per-worker instance id),
 *   - full-state transfer (`exportState`/`importState`, the portable bundle),
 *   - named saved states (`checkpoint`/`listCheckpoints`/`restore`/
 *     `deleteCheckpoint`, whole sandbox states in the RAW idb).
 *
 * Owns the stable per-worker instance id (persisted to the raw idb).
 * `getOrCreateInstanceId` is imported by serve-init; the instance-id helpers
 * are part of the host's public surface (re-exported by the host barrel).
 * Never imports the dispatcher.
 */

import type { PersistenceBackend } from 'pyric/sandbox';
import { serializeToBuckets, bundleRecords, parseBundle, deserializeFromBuckets } from 'pyric/sandbox';
import {
  listCheckpoints,
  recordCheckpointBackend,
  removeCheckpoint,
  restoreNamedCheckpoint,
  saveCheckpoint,
  type CheckpointBackend,
} from 'pyric/sandbox/checkpoints';

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail } from '../host-context.js';

/** Build hash injected by the bundler's esbuild `define`. Undefined when the
 *  compiled host is imported directly (tests) — guarded with `typeof`. */
declare const __PYRIC_WORKER_VERSION__: string;

/**
 * Per-SharedWorker instance id — generated once and persisted to the RAW idb
 * (local-only, like the session record above; it must NEVER reach the
 * committable server file). Because IndexedDB is per (origin + browser profile),
 * two profiles on the same `localhost:<port>` get two distinct ids — which is
 * exactly how the UI tells same-port-different-profile sandboxes apart.
 */
export const INSTANCE_ID_KEY = 'pyric:worker:instance';

/**
 * `crypto.randomUUID()` is secure-context-only (https or localhost), so it is
 * `undefined` over plain http on a non-localhost host (a Tailscale or LAN
 * hostname). `crypto.getRandomValues` is NOT gated, so build a v4 UUID from it as
 * the fallback. Without this the worker throws on init over Tailscale and the
 * whole sandbox (auth, firestore, bridge) silently fails to come up.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

export async function getOrCreateInstanceId(idb: PersistenceBackend): Promise<string> {
  const rec = (await idb.getRecord(INSTANCE_ID_KEY, 'id')) as { value?: string } | undefined;
  if (rec && typeof rec.value === 'string') return rec.value;
  const id = randomUuid();
  await idb.putRecords(INSTANCE_ID_KEY, new Map([['id', { value: id }]]));
  return id;
}

// ── Named saved states ──────────────────────────────────────────────────────
// A checkpoint is a named full sandbox state kept in the RAW idb (local-only,
// like the instance id and the session record; it must NEVER reach the
// committable server file). They let one instance keep several named states it
// can go back to (`restore` is a clobber). What a checkpoint holds, how it is
// named, and how a store keeps one is decided in `pyric/sandbox/checkpoints`,
// so a state a page saves and a state the CLI saves are the same value.

/** Where this worker keeps its checkpoints, or nothing when it has no store. */
function checkpointsOf(ctx: HostCtx): CheckpointBackend | null {
  if (!ctx.sessionBackend) return null;
  return recordCheckpointBackend(ctx.sessionBackend);
}

/** The connection, state-transfer, and checkpoint methods routed here. */
const CONNECTION_METHODS = new Set<string>([
  'getVersion',
  'exportState',
  'importState',
  'checkpoint',
  'listCheckpoints',
  'restore',
  'deleteCheckpoint',
]);

export function isConnectionOp(method: OpMessage['method']): boolean {
  return CONNECTION_METHODS.has(method);
}

export async function handleConnectionOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  switch (msg.method) {
    case 'getVersion': {
      // The build hash is injected by the bundler (esbuild `define`). `typeof`
      // guards the non-bundled path (tests import the compiled host directly,
      // where the global is undefined) → reports 'dev'.
      ok(port, msg.id, {
        version: typeof __PYRIC_WORKER_VERSION__ !== 'undefined' ? __PYRIC_WORKER_VERSION__ : 'dev',
        instanceId: ctx.instanceId,
      });
      break;
    }

    case 'exportState': {
      // Phase 2 (transfer): serialize the FULL sandbox state to a portable bundle
      // string using the SAME chunk format the persist layer uses, so wrapper
      // types (Timestamp / Bytes / GeoPoint / VectorValue) round-trip. The string
      // crosses the MessagePort cleanly (unlike the raw snapshot object).
      const snap = ctx.sandbox.snapshot();
      ok(port, msg.id, { bundle: bundleRecords(serializeToBuckets(snap.firestore, snap.services, 0)) });
      break;
    }

    case 'importState': {
      // Phase 2 (clobber): replace this sandbox's ENTIRE state with the imported
      // bundle via the public loadSnapshot() (reset + rebuild firestore + restore
      // services; listeners re-evaluate, persist re-flushes).
      ctx.sandbox.loadSnapshot(deserializeFromBuckets(parseBundle(msg.bundle)));
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'checkpoint': {
      // Capture the whole sandbox under a name, replacing whatever it held.
      const backend = checkpointsOf(ctx);
      if (backend === null) {
        ok(port, msg.id, { ok: false, error: 'no persistence backend' });
        break;
      }
      const saved = await saveCheckpoint(backend, msg.name, ctx.sandbox);
      ok(port, msg.id, { ok: true, at: saved.checkpoint.at, counts: saved.checkpoint.counts });
      break;
    }

    case 'listCheckpoints': {
      const backend = checkpointsOf(ctx);
      if (backend === null) {
        ok(port, msg.id, { checkpoints: [] });
        break;
      }
      ok(port, msg.id, { checkpoints: await listCheckpoints(backend) });
      break;
    }

    case 'restore': {
      // Replace the whole sandbox with the named checkpoint (a clobber).
      const backend = checkpointsOf(ctx);
      if (backend === null) {
        ok(port, msg.id, { ok: false, error: 'no persistence backend' });
        break;
      }
      const restored = await restoreNamedCheckpoint(backend, msg.name, ctx.sandbox);
      if (restored === null) {
        ok(port, msg.id, { ok: false, error: `no such checkpoint: ${msg.name}` });
        break;
      }
      ok(port, msg.id, { ok: true, at: restored.at, counts: restored.counts });
      break;
    }

    case 'deleteCheckpoint': {
      const backend = checkpointsOf(ctx);
      if (backend === null) {
        ok(port, msg.id, { ok: false, error: 'no persistence backend' });
        break;
      }
      const removed = await removeCheckpoint(backend, msg.name);
      ok(port, msg.id, { ok: removed });
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
