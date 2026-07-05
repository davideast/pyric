/**
 * SharedWorker entry point — the actual SharedWorker script.
 *
 * WHY A SEPARATE ENTRY
 * --------------------
 * `host.ts` is pure-ish: it accepts an injected `{ db, sandbox }` and
 * fake ports, so tests can drive it without a real SharedWorker runtime.
 * This file is the integration shell: it creates the ONE real sandbox,
 * attaches IDB persistence, deploys permissive starter rules, and wires
 * every connecting port to `handleMessage`.
 *
 * Do NOT import this file in tests — import `host.ts` directly.
 *
 * LIFECYCLE
 * ---------
 * The SharedWorker lives while at least one tab holds a port. When all
 * tabs close or navigate away, the worker is GC'd. IDB persistence means
 * data survives full close → reopen cycles: on the next connect the sandbox
 * restores from IDB, and the tab reconnects to a warm state.
 *
 * PERSISTENCE KEY
 * ---------------
 * Using `'pyric-shared-worker'` as the IDB persistence key. This is a
 * package-level default; serve integration (Phase 3) may want to scope
 * it per-project or per-port. Phase 1 keeps it simple.
 *
 * RULES
 * -----
 * We deploy a permissive starter ruleset on first init. Callers change
 * rules at runtime via `{ t:'op', method:'setRules', source }` messages.
 *
 * SINGLE SANDBOX GUARANTEE
 * ------------------------
 * `_ctx` is module-level. The first `connect` event lazily creates it;
 * all subsequent ports reuse the same ctx — one sandbox, one Firestore
 * backend for all tabs. This is the architectural invariant the whole
 * SharedWorker approach depends on.
 */

// SharedWorkerGlobalScope is not in the default TypeScript lib (it's in
// lib.webworker.d.ts which conflicts with lib.dom.d.ts). This entry file is
// browser-only and only bundled with esbuild (never compiled by tsc for
// production). We declare the minimal interface we need so tsc can type-check
// without enabling the full webworker lib.
interface SharedWorkerGlobalScope {
  onconnect: ((e: MessageEvent) => void) | null;
}

import {
  initializeSandbox,
  attachPersistence,
  createIndexedDBBackend,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth } from 'pyric/auth';

import {
  handleMessage,
  cleanupPort,
  getOrCreateInstanceId,
  type HostCtx,
  type PortLike,
} from './host.js';
import {
  applyServeInit,
  createWorkerDurableBackend,
  setupServerAuthFlush,
  setupWorkerHotReload,
  type EventSourceLike,
} from './serve-init.js';
import type { InboundMessage } from './protocol.js';
import type { InitPayload } from '../namespace.js';

// ─── Singleton context ────────────────────────────────────────────────────

// `_ctx` is the RESOLVED context, kept for the synchronous `close` handler.
// The build is memoized as a PROMISE (`_ctxPromise`) — NOT as the resolved
// value — because init is async (it awaits `/__pyric/init.json` + persistence
// restore). The first messages arrive in a BURST (the authState sub, the first
// firestore sub, an op — possibly across two tabs at once); if each re-checked
// only the resolved `_ctx` they would every one start a fresh init and build a
// SEPARATE sandbox, so a listener and a write could bind to different
// instances and never see each other. The promise memo guarantees ONE init.
let _ctx: HostCtx | null = null;
let _ctxPromise: Promise<HostCtx> | null = null;

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
`;

/**
 * Return the shared context, memoizing the in-flight init promise so
 * concurrent first messages await ONE build (see `_ctxPromise` above).
 */
function getCtx(): Promise<HostCtx> {
  return (_ctxPromise ??= buildCtx());
}

/**
 * Build the ONE shared sandbox + Firestore handle. Invoked exactly once per
 * worker lifetime via the `getCtx` memo — never concurrently.
 */
async function buildCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();

  // Deploy permissive starter rules via admin-firestore.
  // Callers override at runtime via the setRules op.
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(PERMISSIVE_RULES);

  // ONE IDB backend for the whole worker. createIndexedDBBackend's guard
  // checks `typeof indexedDB === 'undefined'` — SharedWorkers have full
  // IndexedDB access, so this succeeds. The persistence controller's
  // window.addEventListener('beforeunload', ...) is guarded by
  // `typeof window !== 'undefined'`, so attachPersistence is worker-safe.
  const idb = createIndexedDBBackend();

  // Fetch serve's init payload FIRST — it decides the DURABLE strategy before
  // we attach: `--persist` mirrors the controller blob to the committable
  // server file (and primes from it on a fresh worker); a `seedState` fixture
  // primes IDB once. Null when standalone (no `pyric serve` behind us).
  const payload = await fetchInitPayload();

  // The persistence-controller backend. `--persist`/`seedState` wrap IDB (see
  // createWorkerDurableBackend); plain IDB otherwise. The session record stays
  // on the RAW idb (local-only — it must NEVER reach the committable server
  // file), so that is what we hand the host as `sessionBackend`.
  const durable = payload ? createWorkerDurableBackend(idb, payload, { fetch }) : idb;
  await attachPersistence(sandbox, {
    key: 'pyric-shared-worker',
    injectedBackend: durable,
  });

  // Register the auth service with the persistence registry BEFORE we read
  // back any session: `getAuth(sandbox)` makes the user DB ride the snapshot
  // (the #629 mechanism). One auth per worker — one shared session across all
  // tabs (the v1 decision; see host.ts for the SESSION/LOCAL collapse note).
  getAuth(sandbox);

  // Sandbox-live Firestore: `getFirestore(sandbox)` reads
  // `sandbox.currentUser` per operation, so auth changes propagate
  // to subsequent Firestore ops without rebuilding the handle.
  const db = getFirestore(sandbox);

  const ctx: HostCtx = {
    db,
    sandbox,
    // Stable per-SharedWorker identity (raw idb, local-only). Two browser
    // profiles on the same port get two ids — how the UI tells them apart.
    instanceId: await getOrCreateInstanceId(idb),
    subs: new Map(),
    sessionBackend: idb,
    sessionMode: 'LOCAL',
  };
  _ctx = ctx; // publish the resolved ctx for the synchronous close handler

  // Apply rules / seed / authUsers / capture BEFORE session restore (so seeded
  // users exist for the restore and project rules govern the first write),
  // then mirror auth to the committable server file (`--persist` only).
  if (payload) {
    applyServeInit(ctx, payload, { fetch });
    setupServerAuthFlush(ctx, payload, { fetch });
  }

  // The worker owns the SINGLE hot-reload stream for the origin (tabs open
  // none) — so a rules change deploys once and multi-tab pages never exhaust
  // the per-origin connection cap. EventSource is available in workers.
  if (typeof EventSource !== 'undefined') {
    setupWorkerHotReload(ctx, (url) => new EventSource(url) as unknown as EventSourceLike);
  }

  // NOTE (#754): no worker-side session restore anymore. Sessions are
  // per-port; each PAGE re-establishes its own session from web storage via
  // `auth.restorePortSession` (runtime.ts). The user DB itself was already
  // restored from the snapshot above (#629).

  return ctx;
}

/**
 * Fetch + parse `/__pyric/init.json`. The URL is relative to the worker
 * script's origin (same origin as the page). Returns null on any failure: a
 * worker opened outside `pyric serve` has no init endpoint and simply keeps
 * the permissive starter rules + a plain-IDB durable store.
 */
async function fetchInitPayload(): Promise<InitPayload | null> {
  try {
    const res = await fetch('/__pyric/init.json');
    if (!res.ok) return null;
    return (await res.json()) as InitPayload;
  } catch {
    return null;
  }
}

// ─── SharedWorker connect handler ─────────────────────────────────────────

/**
 * `self` in a SharedWorker is `SharedWorkerGlobalScope`, not `Window`.
 * Each tab that opens the SharedWorker fires one `connect` event.
 * Each tab gets its own `MessagePort`; we start() it (required for
 * classic-mode workers to un-pause the message queue) and wire onmessage.
 */
(self as unknown as SharedWorkerGlobalScope).onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  port.start();

  port.onmessage = async (ev: MessageEvent<InboundMessage>) => {
    // Lazily initialize on first message from any tab. All subsequent
    // calls return the cached singleton.
    try {
      const ctx = await getCtx();
      await handleMessage(ctx, port as unknown as PortLike, ev.data);
    } catch (e) {
      // A throw here would otherwise be an invisible unhandled rejection in the
      // worker — surface it in the SharedWorker console (chrome://inspect →
      // Shared workers). Op handlers already reply with fail(); this catches
      // anything outside that (init, sub registration).
      // eslint-disable-next-line no-console
      console.error('[pyric worker] message handler error:', (e as Error)?.stack ?? e, 'msg:', ev.data);
    }
  };

  // Best-effort port cleanup on tab close/navigation.
  // Chrome doesn't reliably fire 'close' on MessagePort — handled as
  // best-effort; subscriptions also GC when the worker itself dies.
  port.addEventListener('close', () => {
    if (_ctx) cleanupPort(_ctx, port as unknown as PortLike);
  });
};
