/**
 * `pyric serve` in-page runtime — the shared chunk every served SDK bundle
 * closes over. One sandbox per page; init payload (rules, future bridge URL)
 * fetched from `/__pyric/init.json` at module init.
 *
 * TOP-LEVEL AWAIT IS LOAD-BEARING: every importer (the auth/firestore bundles,
 * and therefore the user's app module) is deferred until this module resolves,
 * so by the time app code runs the rules are deployed — no
 * "first write raced the ruleset" class of bugs.
 *
 * This file is BUNDLED FOR THE BROWSER by `../bundler.ts` (esbuild) — it is
 * never imported by node-side pyric-tools code. Bundle splitting must keep it
 * a single shared chunk: two copies would mean two sandboxes (P0 validation
 * constraint, design rationale section 9).
 */
import {
  initializeSandbox,
  recordBackendOverBlob,
  serializeToBuckets,
  bundleRecords,
} from 'pyric/sandbox';
import { getFirestore, sandbox as sandboxOps } from 'pyric/firestore';
import { getDatabase, sandbox as rtdbSandbox } from 'pyric/database/modular';
import { getAuth, onAuthStateChanged, signOut, sandbox as authOps, type SeedUser } from 'pyric/auth';
import {
  getFirestore as workerGetFirestore,
  getWorkerVersion,
  callTool as workerCallTool,
  getAuth as workerGetAuth,
  onAuthStateChanged as workerOnAuthStateChanged,
  restorePortSession as workerRestorePortSession,
  type ClientDb,
} from '../worker/client.js';
import { SessionStore } from './session-store.js';
import { keepaliveSafe } from './keepalive.js';
import { toPageOriginWsUrl } from './bridge-url.js';
import { buildVerifyFixture } from '../../verify/fixture.js';

/**
 * The DEFAULT-ON worker path (Phase 3c): when SharedWorker is available the
 * `firebase/*` entry adapters route to the worker-hosted sandbox instead of
 * the in-page one. The worker owns rules/seed/persist/capture/session (it
 * fetches the SAME `/__pyric/init.json`), so on this path the page MUST NOT
 * re-run that backend init below — doing so would double-POST captures and
 * fight the worker over `/__pyric/state`. Unsupported browsers fall back to
 * the in-page sandbox + the shipped BroadcastChannel sync (strict enhancement).
 *
 * `globalThis.__PYRIC_FORCE_INPAGE__` is an explicit opt-out: a host that does
 * NOT serve the worker bundle (`/__pyric/sdk/worker.js`) sets it before this
 * module evaluates so the page takes the in-page path instead of trying to load
 * a worker that 404s. `pyric serve` always serves the worker and never sets it;
 * the `pyric-tools/vite` plugin sets it until it serves the worker (M2).
 */
export const useWorker =
  typeof SharedWorker !== 'undefined' &&
  !(globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__;

/** Served URL of the bundled SharedWorker host (bundler `worker.js`). */
export const WORKER_URL = '/__pyric/sdk/worker.js';

/**
 * STABLE SharedWorker name — every tab of the origin shares ONE worker (the
 * whole point: one backend, live multi-tab sync). We deliberately do NOT
 * version the name: a versioned name would make tabs opened across a pyric
 * rebuild connect to DIFFERENT workers, silently splitting the backend so a
 * write in one tab wouldn't reach another.
 *
 * The cost: a SharedWorker can't hot-update its code — it runs whatever version
 * started it until ALL tabs of the origin close. So if pyric itself is rebuilt
 * while tabs are open, they keep the OLD worker. We DETECT that (see the
 * staleness check below) and warn, rather than trading away multi-tab sharing.
 * (End users of `pyric serve` edit their OWN app, not pyric's worker bundle, so
 * this only affects pyric development.)
 */
const WORKER_NAME = 'pyric-shared-worker';

/**
 * The in-page sandbox. On the worker path it is NOT the data backend — it
 * stays mounted as the FALLBACK primitive and as the provider-sign-in
 * resolution surface (the in-page `AuthFlowResolver` + `ServeAuthHelper`
 * resolve popup/redirect identities, which the entry then bridges to the
 * worker via `auth.acceptIdentity`).
 */
export const sandbox = initializeSandbox();

/**
 * The shared worker-backed Firestore handle (one SharedWorker connection for
 * the whole page — the auth entry reuses its port too). Null when SharedWorker
 * is unavailable. Opening it here connects the SharedWorker eagerly so the
 * worker's first-connect init (rules/seed/persist) is underway before app code
 * issues its first op.
 */
export const workerDb: ClientDb | null = useWorker ? workerGetFirestore(WORKER_URL, WORKER_NAME) : null;

// Staleness guard: warn (don't split) if the running worker is older than what
// serve is now serving. serve stamps the served bundle hash into
// `<meta name="pyric-worker-v">`; the worker reports its OWN baked hash. A
// mismatch means a still-running worker from before a pyric rebuild — close all
// tabs of the origin to load the new worker.
if (useWorker && typeof document !== 'undefined') {
  const servedV = document
    .querySelector('meta[name="pyric-worker-v"]')
    ?.getAttribute('content');
  void getWorkerVersion(workerDb!)
    .then((runningV) => {
      if (servedV && runningV && runningV !== 'dev' && servedV !== runningV) {
        console.warn(
          `[pyric serve] the SharedWorker is running OLDER code (build ${runningV}) than what is now ` +
            `served (build ${servedV}). A SharedWorker can't hot-update — CLOSE ALL TABS of this origin ` +
            'and reopen to load the new worker. (All tabs share one worker, so a partial reload leaves ' +
            'the old code running for everyone.)',
        );
      }
    })
    .catch(() => {});
}

/** Page-wide auth session store — `entries/auth.ts`'s `setPersistence` wrap
 *  switches its mode. Memory-backed fallback keeps non-browser imports inert. */
const memoryStorage = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};
export const sessionStore = new SessionStore(
  typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined'
    ? { local: localStorage, session: sessionStorage }
    : { local: memoryStorage(), session: memoryStorage() },
);

/** Shape served by `/__pyric/init.json`. */
interface InitPayload {
  /** Plain-v2 rules source (server resolves `2+modules` before embedding),
   *  or null when the project has no rules file. */
  rules: string | null;
  /** sha256 prefix of the rules source — diagnostics + hot-reload diffing. */
  rulesHash: string | null;
  /** Firebase RTDB rules JSON, when firebase.json has database.rules. */
  databaseRules?: { rules: Record<string, unknown> } | null;
  databaseRulesHash?: string | null;
  databaseUrl?: string | null;
  /** Bridge WS URL when `--bridge` is on (P2); null otherwise. */
  bridgeUrl: string | null;
  /** `--seed` documents (path → fields), applied admin-style before app code runs.
   *  Null in persist mode once a state file exists — the lived state wins. */
  seed: Record<string, Record<string, unknown>> | null;
  /** `--persist`: enable sandbox persistence over /__pyric/state. */
  persist?: boolean;
  /** Ephemeral fixture restore: a state-file's controller blob, restored
   *  via a read-only backend (wrapper re-hydration without durability). */
  seedState?: unknown | null;
  /** Persisted/fixture auth users, seeded before app code runs. */
  authUsers?: SeedUser[] | null;
  /** `--capture`: push the session fixture to /__pyric/capture so
   *  `pyric verify` can replay the session without extra args. Default-on;
   *  suppressed by --no-capture. */
  capture?: boolean;
}

interface ServeDiagnostics {
  sandboxReady: boolean;
  rulesDeployed: boolean;
  databaseRulesDeployed: boolean;
  rulesHash: string | null;
  databaseRulesHash: string | null;
  initError: string | null;
  bridgeConnected: boolean;
  seededDocs: number;
  persistEnabled: boolean;
  /** Epoch ms of the last successful state flush to the server. */
  lastFlushAt: number | null;
  /** True when another tab holds the writer lock — this tab won't persist. */
  persistReadOnly: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __pyricServe: ServeDiagnostics;
}

const diagnostics: ServeDiagnostics = {
  sandboxReady: true,
  rulesDeployed: false,
  databaseRulesDeployed: false,
  rulesHash: null,
  databaseRulesHash: null,
  initError: null,
  bridgeConnected: false,
  seededDocs: 0,
  persistEnabled: false,
  lastFlushAt: null,
  persistReadOnly: false,
};
globalThis.__pyricServe = diagnostics;

let bridgeUrlFromPayload: string | null = null;

// ── init payload: fetch + apply (top-level await — see header) ────────
// WORKER PATH: skipped — the worker fetches the same init.json and owns
// rules/seed/persist/capture/session. Running it here too would double-POST
// captures and fight the worker over the /__pyric/state writer lock.
if (!useWorker) try {
  const res = await fetch('/__pyric/init.json');
  if (!res.ok) throw new Error(`/__pyric/init.json → ${res.status}`);
  const payload = (await res.json()) as InitPayload;
  bridgeUrlFromPayload = payload.bridgeUrl;
  if (payload.rules) {
    const db = getFirestore(sandbox);
    const lint = sandboxOps.setRules(db, payload.rules);
    if (lint.parseError) {
      // The server lints before serving, so this is a defensive surface —
      // loud, but don't brick the page: the sandbox keeps its default rules.
      throw new Error(
        `firestore.rules failed to parse in the sandbox: ${JSON.stringify(lint.parseError)}`,
      );
    }
    diagnostics.rulesDeployed = true;
    diagnostics.rulesHash = payload.rulesHash;
  }
  if (payload.databaseRules) {
    rtdbSandbox.setRules(getDatabase(sandbox), payload.databaseRules);
    diagnostics.databaseRulesDeployed = true;
    diagnostics.databaseRulesHash = payload.databaseRulesHash ?? null;
  }
  // Auth users land first in either mode (persist restore or state-file
  // fixture) so restored docs' owner uids resolve in rules and the session
  // restore below has a DB to restore into.
  if (payload.authUsers && payload.authUsers.length > 0) {
    authOps.seedUsers(getAuth(sandbox), payload.authUsers);
  }
  if (!payload.persist && payload.seedState) {
    // ── ephemeral fixture (`--seed <state-file>`): restore the blob through
    // the persistence controller's OWN deserializer (wrapper re-hydration —
    // seedDocuments on raw marker JSON would break instanceof in rules) via
    // a read-only backend. Writes go nowhere: ephemeral stays ephemeral.
    const seedSnap = payload.seedState as {
      firestore?: Record<string, Record<string, unknown>>;
      services?: Record<string, unknown>;
    };
    const fixtureBundle = bundleRecords(
      serializeToBuckets(seedSnap.firestore ?? {}, seedSnap.services ?? {}, 0),
    );
    // NOTE (pre-mortem #6b): this attaches a PERMANENT controller whose
    // write() is a no-op — so every later mutation in this page pays the
    // whole-state serialize cost to feed a sink. pyric exposes no
    // `disablePersistence`/dispose, so a one-shot restore isn't possible from
    // here without a pyric change (tracked as a pyric follow-up). Accepted:
    // fixture pages are demo-sized; the cost is bounded and invisible to
    // correctness.
    await sandbox.enablePersistence({
      key: 'pyric-serve-fixture',
      injectedBackend: recordBackendOverBlob({
        read: async () => fixtureBundle,
        write: async () => {},
        clear: async () => {},
      }),
    });
    const docs = (payload.seedState as { firestore?: Record<string, unknown> }).firestore;
    diagnostics.seededDocs = docs ? Object.keys(docs).length : 0;
  }
  if (payload.persist) {
    // ── persist mode (flow doc section 3c): the substrate is durable. The
    // sandbox's OWN persistence controller with an HTTP backend over
    // /__pyric/state — it owns restore-on-attach (wrapper re-hydration),
    // debounced auto-flush, and the beforeunload safety flush.
    const section = (name: string): string => `/__pyric/state?section=${name}`;
    // Single-writer lock (pre-mortem #3): a per-page id claims the writer
    // role on first flush; a second tab gets 423 and drops to read-only so
    // it can't erase this tab's world. The server frees a stale lock, so a
    // reload after the writer closed can reclaim it.
    const writerId =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `w-${Date.now()}`;
    const writerHeaders = { 'content-type': 'application/json', 'x-pyric-writer': writerId };
    let readOnly = false;
    const lostWriterLock = (): void => {
      if (readOnly) return;
      readOnly = true;
      diagnostics.persistReadOnly = true;
      console.warn(
        '[pyric serve] another tab is the persist writer — THIS tab is read-only ' +
          '(your changes here will NOT be saved). Close the other tab and reload to take over.',
      );
    };
    await sandbox.enablePersistence({
      key: 'pyric-serve',
      injectedBackend: recordBackendOverBlob({
        async read() {
          const res = await fetch(section('firestore'));
          return res.status === 200 ? await res.text() : null;
        },
        async write(value) {
          if (readOnly) return; // a non-writer tab silently no-ops its flushes
          const res = await fetch(section('firestore'), {
            method: 'POST',
            headers: writerHeaders,
            body: value,
            // The controller's beforeunload flush fires THIS write as the
            // page is leaving; a plain fetch is aborted on unload (pre-mortem
            // #1 — the "crash-only" claim was wrong). `keepalive` lets a
            // small final flush survive unload. It's capped (~64KB across
            // all keepalive requests), so large states skip it and warn
            // once — those lose the final unsaved delta on tab close
            // (reload-based flushes are unaffected).
            keepalive: keepaliveSafe(value),
          });
          if (res.status === 423) return lostWriterLock();
          if (!res.ok) throw new Error(`state flush → ${res.status}`);
          diagnostics.lastFlushAt = Date.now();
        },
        async clear() {
          if (readOnly) return;
          await fetch(section('firestore'), { method: 'POST', headers: writerHeaders, body: 'null' });
        },
      }),
    });
    diagnostics.persistEnabled = true;

    // Heartbeat: keep an alive-but-idle writer's lock fresh. PUT refreshes
    // the lock WITHOUT writing state (a POST would clobber). Release on
    // pagehide so another tab can take over promptly.
    const heartbeat = setInterval(() => {
      if (readOnly) return;
      void fetch('/__pyric/state', { method: 'PUT', headers: writerHeaders }).then((res) => {
        if (res.status === 423) {
          lostWriterLock();
          clearInterval(heartbeat);
        }
      }, () => {});
    }, 20_000);
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        clearInterval(heartbeat);
        if (!readOnly) {
          fetch('/__pyric/state', { method: 'DELETE', headers: writerHeaders, keepalive: true }).catch(() => {});
        }
      });
    }

    // Auth user-DB changes flush separately (the controller's blob is
    // firestore-only). Debounced; exportUsers→seedUsers round-trips.
    const auth = getAuth(sandbox);
    let authFlushTimer: ReturnType<typeof setTimeout> | null = null;
    authOps.subscribeUsers(auth, () => {
      if (readOnly) return;
      if (authFlushTimer) clearTimeout(authFlushTimer);
      authFlushTimer = setTimeout(() => {
        void fetch(section('auth'), {
          method: 'POST',
          headers: writerHeaders,
          body: JSON.stringify({ users: authOps.exportUsers(auth) }),
        }).then(
          (res) => {
            if (res.status === 423) lostWriterLock();
            else if (res.ok) diagnostics.lastFlushAt = Date.now();
          },
          (e) => console.warn('[pyric serve] auth state flush failed:', e),
        );
      }, 500);
    });
  }
  if (payload.capture) {
    // ── capture mode (the write-side of the pyric verify loop): whenever
    // the sandbox changes, push a snapshot of the full session fixture
    // (rules + history + firestore state) to /__pyric/capture. The server
    // writes it verbatim to `.pyric/last-session.json` so `pyric verify`
    // can replay without any extra arguments. This is independent of
    // --persist — capture is about the verify loop, persist is about
    // cross-reload durability.
    const flushCapture = (): void => {
      const rtdbState =
        payload.databaseRules || sandbox.history().some((event) => event.service === 'rtdb')
          ? rtdbSandbox.snapshotState(getDatabase(sandbox))
          : undefined;
      const auth = getAuth(sandbox);
      const body = JSON.stringify(buildVerifyFixture({
        sandbox,
        firestoreRules: payload.rules,
        rtdbRules: payload.databaseRules ?? null,
        rtdbState,
        rtdbDatabaseUrl: payload.databaseUrl ?? null,
        authState: {
          users: authOps.exportUsers(auth),
          currentUser: auth.currentUser,
        },
      }));
      fetch('/__pyric/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: keepaliveSafe(body),
      }).catch(() => {});
    };

    // Debounced flush on every sandbox event — coalesces rapid writes (e.g.
    // seeding multiple docs) into a single push. 400ms matches the cadence
    // of the persist auth flush; small enough to feel live, large enough to
    // avoid one-POST-per-write on bulk ops.
    let captureTimer: ReturnType<typeof setTimeout> | null = null;
    sandbox.onEvent(() => {
      if (captureTimer) clearTimeout(captureTimer);
      captureTimer = setTimeout(flushCapture, 400);
    });

    // Unload flush — best-effort, keepalive. Separate from any persist
    // pagehide listener so they don't interfere.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        flushCapture();
      });
    }
  }
  if (payload.seed && Object.keys(payload.seed).length > 0) {
    // Admin-style fixture load (bypasses rules) — runs before app code
    // (top-level await), so the app's first render sees the seeded state.
    sandboxOps.seedDocuments(getFirestore(sandbox), payload.seed);
    diagnostics.seededDocs = Object.keys(payload.seed).length;
  }
} catch (e) {
  diagnostics.initError = e instanceof Error ? e.message : String(e);
  console.error(
    '[pyric serve] init failed — the sandbox is running WITHOUT your project rules:',
    diagnostics.initError,
  );
}

// ── auth session persistence (flow doc section 3c — client-fidelity item): real
// Firebase keeps you signed in across reloads by default. Restore BEFORE
// subscribing so the initial signed-out emission can't clear the stored
// session; a session only resolves while its uid still exists in the user
// DB (ephemeral reloads drop helper-created sessions, consistently).
// WORKER PATH (#754): sessions are PER-PORT in the worker, so this page
// re-establishes ITS OWN session (`auth.restorePortSession`) from the same
// web-storage record, then keeps the record in sync. The top-level await
// below is load-bearing: it keeps a restored session ordered BEFORE the
// app's first auth op on this port (worker messages are FIFO). ──
if (useWorker && workerDb) {
  const auth = workerGetAuth(workerDb);
  const stored = sessionStore.load();
  if (stored) {
    const user = await workerRestorePortSession(auth, stored.uid);
    if (user) console.info(`[pyric serve] auth session restored (${user.uid})`);
    else sessionStore.clear(); // user gone or disabled — signed out, like a stale token
  }
  workerOnAuthStateChanged(auth, (user) => {
    if (user) sessionStore.save(user.uid);
    else sessionStore.clear();
  });
} else if (!useWorker) {
  const auth = getAuth(sandbox);
  const stored = sessionStore.load();
  if (stored) {
    try {
      authOps.restoreSession(auth, stored.uid);
      console.info(`[pyric serve] auth session restored (${stored.uid})`);
    } catch {
      sessionStore.clear(); // user gone or disabled — signed out, like a stale token
    }
  }
  onAuthStateChanged(auth, (user) => {
    if (user) sessionStore.save(user.uid);
    else sessionStore.clear();
  });
}

// ── provenance (flow doc section 3a): make the shim's presence unmistakable.
// Source says `firebase/*`; what runs is the pyric sandbox — say so loudly
// once, and explain any stack frame that points into /__pyric/sdk/. ────────
console.info(
  `[pyric serve] firebase/* on this page is served by the pyric sandbox` +
    (useWorker
      ? ' in a SharedWorker (one backend for all tabs; rules/seed/persist owned by the worker)'
      : diagnostics.rulesHash
        ? ` (rules ${diagnostics.rulesHash})`
        : ' (no project rules)') +
    ` — diagnostics: globalThis.__pyricServe`,
);

let provenanceHintShown = false;
function explainSandboxFrame(stackOrUrl: string | undefined): void {
  if (provenanceHintShown || !stackOrUrl || !stackOrUrl.includes('/__pyric/sdk/')) return;
  provenanceHintShown = true;
  console.info(
    '[pyric serve] the error above originates in the pyric sandbox shim serving firebase/*, ' +
      'not the real Firebase SDK — behavior can differ where COMPAT coverage is incomplete.',
  );
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) =>
    explainSandboxFrame(e.error instanceof Error ? (e.error.stack ?? e.filename) : e.filename),
  );
  window.addEventListener('unhandledrejection', (e) =>
    explainSandboxFrame(e.reason instanceof Error ? e.reason.stack : undefined),
  );
}

// ── bridge peer (only when `pyric serve --bridge` put a URL in the payload;
//    dynamic import so bridge-less pages never load the client chunk) ─────
async function connectBridgePeer(rawUrl: string): Promise<void> {
  // Re-anchor the bridge WS to THIS page's origin so it reaches the server the
  // page was actually served from over Tailscale / a LAN IP / https, not the
  // server's baked-in localhost. See bridge-url.ts.
  const url = toPageOriginWsUrl(rawUrl, window.location);
  const { connectBridge } = await import('../../bridge/client/bridge.js');
  // On the worker path, route agent tool-calls THROUGH the SharedWorker so the
  // agent shares the one sandbox the app + Studio use (no separate in-page
  // backend). Off the worker path (in-page fallback), dispatch in-page as before.
  if (useWorker && workerDb) {
    const wdb = workerDb;
    connectBridge(sandbox, {
      url,
      dispatcher: (_sandbox, name, args) => workerCallTool(wdb, name, args),
    });
  } else {
    connectBridge(sandbox, { url });
  }
  diagnostics.bridgeConnected = true;
  console.info('[pyric serve] sandbox registered with the MCP bridge at', url);
}
if (bridgeUrlFromPayload) {
  // In-page path: bridgeUrlFromPayload came from the (already-blocking) init
  // block above, so connect inline.
  try {
    await connectBridgePeer(bridgeUrlFromPayload);
  } catch (e) {
    console.error('[pyric serve] bridge connect failed:', e instanceof Error ? e.message : String(e));
  }
} else if (useWorker) {
  // Worker path: the worker owns serve-init, so the page skipped the init.json
  // fetch. Discover the bridge URL (the agent routes its tool-calls THROUGH the
  // worker) in a FIRE-AND-FORGET task so app boot is NEVER blocked — runtime.ts
  // is on the load-bearing top-level-await path, and the agent connecting a beat
  // later is fine. Bridge-less pages just read a null bridgeUrl and stop.
  void (async () => {
    try {
      const res = await fetch('/__pyric/init.json');
      const url = res.ok ? ((await res.json()) as InitPayload).bridgeUrl : null;
      if (url) await connectBridgePeer(url);
    } catch (e) {
      console.error('[pyric serve] bridge connect failed:', e instanceof Error ? e.message : String(e));
    }
  })();
}

// ── cross-tab realtime sync — wire AFTER sandbox + auth are fully set up ──────
//
// Two independent channels, two independent kinds of state:
//
//   Channel 1 — Firestore writes (`pyric:serve:tabsync`):
//     `sandbox.enableTabSync` owns the channel entirely. It broadcasts every
//     committed Firestore write event to peer tabs and runs the hello/state
//     late-join handshake so a freshly-opened tab inherits the current
//     Firestore documents. A write in Tab A fires `onSnapshot` listeners in Tab B
//     — restoring production's cross-client realtime without a server.
//
//   Channel 2 — Auth state (`pyric:serve:auth-sync`):
//     Auth lives outside the Firestore environment so `enableTabSync` can't
//     carry it. `wireAuthTabSync` bridges sign-in/sign-out/user-DB changes
//     over its own BroadcastChannel using a full-state protocol (see
//     `tab-sync-wiring.ts` for the detailed protocol + echo-guard rationale).
//
// Both are no-ops in non-browser environments (`BroadcastChannel` absent).
//
// WORKER PATH: retired. The SharedWorker IS the single backend for all tabs, so
// cross-tab Firestore + auth are automatic — the in-page sandbox these channels
// would sync isn't the data backend here. Kept ONLY for the in-page fallback
// (the tier the plan designates for browsers without SharedWorker).
if (!useWorker && typeof BroadcastChannel !== 'undefined') {
  // 1. Firestore cross-tab — library primitive does the heavy lifting.
  sandbox.enableTabSync({
    channel: new BroadcastChannel('pyric:serve:tabsync'),
  });

  // 2. Auth cross-tab — our own bridge (see tab-sync-wiring.ts).
  //    Dynamic import keeps the module out of the critical path; the channel
  //    is opened synchronously above so `hello` is posted as soon as the
  //    listener is wired (wireAuthTabSync handles ordering internally).
  void import('./tab-sync-wiring.js').then(({ wireAuthTabSync }) => {
    wireAuthTabSync(
      getAuth(sandbox),
      // Cast: authOps's generics are narrowed to `Auth` which is exactly what
      // wireAuthTabSync expects; `as` here avoids a deep generic unification
      // that TypeScript can't resolve across module boundaries.
      authOps as import('./tab-sync-wiring.js').AuthOps,
      onAuthStateChanged,
      signOut,
    );
  });
}

// ── rules hot-reload (SSE) — `pyric serve` watches firestore.rules and
//    broadcasts; we re-deploy in place, no page refresh. EventSource is
//    browser-only; guarded so the bundle stays inert under other runtimes. ──
// IN-PAGE PATH ONLY: open a per-tab SSE to re-deploy rules to the in-page
// sandbox. On the WORKER path the SharedWorker owns ONE hot-reload stream for
// the whole origin (see entry.ts), so tabs open NO SSE connection — multi-tab
// pages would otherwise exhaust Chrome's ~6-connections-per-origin cap and a
// later tab's navigation would hang until an earlier tab closed.
if (!useWorker && typeof EventSource !== 'undefined') {
  const events = new EventSource('/__pyric/events');
  events.addEventListener('rules-changed', (e) => {
    try {
      const { rules, rulesHash } = JSON.parse((e as MessageEvent).data as string) as {
        rules: string;
        rulesHash: string;
      };
      const lint = sandboxOps.setRules(getFirestore(sandbox), rules);
      if (lint.parseError) throw new Error(JSON.stringify(lint.parseError));
      diagnostics.rulesDeployed = true;
      diagnostics.rulesHash = rulesHash;
      console.info(`[pyric serve] firestore.rules hot-reloaded (hash ${rulesHash})`);
    } catch (err) {
      console.error('[pyric serve] rules hot-reload failed:', err instanceof Error ? err.message : String(err));
    }
  });
}
