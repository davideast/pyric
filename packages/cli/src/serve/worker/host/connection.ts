/**
 * SharedWorker host — connection / instance / state-transfer ops.
 *
 * The worker-lifecycle surface the client's `connection` family talks to:
 *   - `getVersion` (build hash + per-worker instance id),
 *   - full-state transfer (`exportState`/`importState`, the portable bundle),
 *   - named branches (`saveBranch`/`listBranches`/`switchBranch`/`deleteBranch`,
 *     saved-state bundles in the RAW idb).
 *
 * Owns the stable per-worker instance id (persisted to the raw idb) and the
 * branch registry helpers. `getOrCreateInstanceId` is imported by serve-init;
 * the instance-id + branch constants/helpers are part of the host's public
 * surface (re-exported by the host barrel). Never imports the dispatcher.
 */

import type { PersistenceBackend } from 'pyric/sandbox';
import { serializeToBuckets, bundleRecords, parseBundle, deserializeFromBuckets } from 'pyric/sandbox';

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

// ── Phase 3: named branches ─────────────────────────────────────────────────
// A branch is a named saved state bundle in the RAW idb (local-only, like the
// instance id + session; it must NEVER reach the committable server file). They
// let one instance keep several named states it can switch between
// (switchBranch = loadSnapshot the bundle, a clobber). A registry record holds
// the ordered name list, since the backend lists records WITHIN a key, not keys.
export const BRANCH_PREFIX = 'pyric:worker:branch:';
export const BRANCH_REGISTRY_KEY = 'pyric:worker:branches';

export async function listBranchNames(idb?: PersistenceBackend): Promise<string[]> {
  if (!idb) return [];
  const rec = (await idb.getRecord(BRANCH_REGISTRY_KEY, 'names')) as { value?: string[] } | undefined;
  return Array.isArray(rec?.value) ? rec.value : [];
}

async function writeBranchRegistry(idb: PersistenceBackend, names: string[]): Promise<void> {
  await idb.putRecords(BRANCH_REGISTRY_KEY, new Map([['names', { value: names }]]));
}

/** The connection/state/branch op methods routed to {@link handleConnectionOp}. */
const CONNECTION_METHODS = new Set<string>([
  'getVersion',
  'exportState',
  'importState',
  'saveBranch',
  'listBranches',
  'switchBranch',
  'deleteBranch',
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

    case 'saveBranch': {
      // Phase 3: snapshot the live sandbox into a named branch bundle (raw idb).
      if (!ctx.sessionBackend) {
        ok(port, msg.id, { ok: false, error: 'no persistence backend' });
        break;
      }
      const snap = ctx.sandbox.snapshot();
      const bundle = bundleRecords(serializeToBuckets(snap.firestore, snap.services, 0));
      await ctx.sessionBackend.putRecords(BRANCH_PREFIX + msg.name, new Map([['bundle', { value: bundle }]]));
      const names = await listBranchNames(ctx.sessionBackend);
      if (!names.includes(msg.name)) await writeBranchRegistry(ctx.sessionBackend, [...names, msg.name]);
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'listBranches': {
      ok(port, msg.id, { branches: await listBranchNames(ctx.sessionBackend) });
      break;
    }

    case 'switchBranch': {
      // Phase 3: loadSnapshot the named branch bundle (a clobber).
      const rec = ctx.sessionBackend
        ? ((await ctx.sessionBackend.getRecord(BRANCH_PREFIX + msg.name, 'bundle')) as { value?: string } | undefined)
        : undefined;
      if (!rec?.value) {
        ok(port, msg.id, { ok: false, error: `no such branch: ${msg.name}` });
        break;
      }
      ctx.sandbox.loadSnapshot(deserializeFromBuckets(parseBundle(rec.value)));
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'deleteBranch': {
      if (ctx.sessionBackend) {
        await ctx.sessionBackend.clear(BRANCH_PREFIX + msg.name);
        await writeBranchRegistry(
          ctx.sessionBackend,
          (await listBranchNames(ctx.sessionBackend)).filter((n) => n !== msg.name),
        );
      }
      ok(port, msg.id, { ok: true });
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
