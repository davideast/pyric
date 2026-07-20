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
 * Project-scoped: `'pyric-shared-worker:<projectKey>'`, derived inside
 * `buildWorkerCtx` from the init payload's `projectKey` (issue #359 family —
 * IndexedDB is origin-scoped, so the old fixed key shared one sandbox
 * snapshot database across every project on a localhost port). The legacy
 * `'pyric-shared-worker'` key applies only when no project identity exists
 * (older servers, standalone workers); see `workerPersistenceKey` in
 * serve-init.ts for the orphan-don't-delete migration decision.
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

import { createIndexedDBBackend } from 'pyric/sandbox';

import {
  handleMessage,
  cleanupPort,
  type HostCtx,
  type PortLike,
} from './host.js';
import { buildWorkerCtx, type EventSourceLike } from './serve-init.js';
import type { InboundMessage } from './protocol.js';
import {
  SERVICE_WORKER_CHANNEL,
  type ServiceWorkerChannelMessage,
} from './service-worker-channel.js';
import { createServiceWorkerRelay } from './service-worker-relay.js';

declare const __PYRIC_WORKER_VERSION__: string;

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

/**
 * Return the shared context, memoizing the in-flight init promise so
 * concurrent first messages await ONE build (see `_ctxPromise` above).
 */
function getCtx(): Promise<HostCtx> {
  return (_ctxPromise ??= buildCtx());
}

/**
 * Build the ONE shared sandbox + Firestore handle. Invoked exactly once per
 * worker lifetime via the `getCtx` memo — never concurrently. The real boot
 * logic lives in `buildWorkerCtx` (serve-init.ts) so it is testable without
 * a SharedWorker runtime; this shell only supplies the real ambients.
 *
 * NOTE (#754): no worker-side session restore. Sessions are per-port; each
 * PAGE re-establishes its own session from web storage via
 * `auth.restorePortSession` (runtime.ts). The user DB itself is restored
 * from the persisted snapshot inside buildWorkerCtx (#629).
 */
async function buildCtx(): Promise<HostCtx> {
  // ONE IDB backend for the whole worker. createIndexedDBBackend's guard
  // checks `typeof indexedDB === 'undefined'` — SharedWorkers have full
  // IndexedDB access, so this succeeds. The persistence controller's
  // window.addEventListener('beforeunload', ...) is guarded by
  // `typeof window !== 'undefined'`, so enablePersistence is worker-safe.
  const ctx = await buildWorkerCtx({
    fetch,
    idb: createIndexedDBBackend(),
    // EventSource is available in workers; guard anyway for exotic hosts.
    makeEventSource:
      typeof EventSource !== 'undefined'
        ? (url) => new EventSource(url) as unknown as EventSourceLike
        : null,
  });
  _ctx = ctx; // publish the resolved ctx for the synchronous close handler
  return ctx;
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

  let messageQueue = Promise.resolve();
  port.onmessage = (ev: MessageEvent<InboundMessage>) => {
    if (ev.data.t === 'op' && ev.data.method === 'getRuntimeEpoch') {
      port.postMessage({
        t: 'res',
        id: ev.data.id,
        ok: true,
        value: {
          version: typeof __PYRIC_WORKER_VERSION__ !== 'undefined'
            ? __PYRIC_WORKER_VERSION__
            : 'dev',
        },
      });
      return;
    }
    // Serialize each port's frames. A disconnect acknowledgement therefore
    // cannot overtake an already-posted mutation, and later frames see the
    // disconnected-port tombstone instead of touching the shared backend.
    messageQueue = messageQueue.then(async () => {
      try {
        const ctx = await getCtx();
        await handleMessage(ctx, port as unknown as PortLike, ev.data);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[pyric worker] message handler error:', (e as Error)?.stack ?? e, 'msg:', ev.data);
      }
    });
  };

  // Best-effort port cleanup on tab close/navigation.
  // Chrome doesn't reliably fire 'close' on MessagePort — handled as
  // best-effort; subscriptions also GC when the worker itself dies.
  port.addEventListener('close', () => {
    if (_ctx) cleanupPort(_ctx, port as unknown as PortLike);
  });
};

// ServiceWorkerGlobalScope cannot construct a SharedWorker, but both worker
// kinds share BroadcastChannel. Adapt each SW app connection to the host's
// existing PortLike seam so it reaches this exact context/broker instead of
// constructing a second in-Service-Worker sandbox.
if (typeof BroadcastChannel !== 'undefined') {
  const channel = new BroadcastChannel(SERVICE_WORKER_CHANNEL);
  const relay = createServiceWorkerRelay({
    getCtx,
    send(message) { channel.postMessage(message); },
    onError(error, envelope) {
      console.error(
        '[pyric worker] service-worker relay error:',
        (error as Error)?.stack ?? error,
        'msg:',
        envelope,
      );
    },
  });
  channel.onmessage = (event: MessageEvent<ServiceWorkerChannelMessage>) => {
    const envelope = event.data;
    if (envelope.direction !== 'host') return;
    void relay.handle(envelope);
  };
}
