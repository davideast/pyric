/**
 * Worker-side serve init (Phase 3c.B) — apply `pyric dev`'s init payload
 * INSIDE the SharedWorker.
 *
 * WHY THIS EXISTS
 * ---------------
 * On the in-page path, `entries/runtime.ts` is the whole backend: it fetches
 * `/__pyric/init.json` and deploys rules, seeds users + docs, and (when
 * `--capture` is on, which is the default) pushes the session fixture to
 * `/__pyric/capture` so `pyric verify` can replay. When `pyric dev` routes
 * `firebase/*` to the SharedWorker instead (the default-on flip, 3c.E), the
 * sandbox lives in the worker — so the worker must subsume that same init, or
 * those features silently no-op on every modern browser.
 *
 * This module is the worker's mirror of `runtime.ts`'s init block, factored so
 * it is unit-testable WITHOUT a browser: it takes a real `HostCtx` (sandbox +
 * db) and an injected `fetch`, exactly like `host.ts`. `entry.ts` wires the
 * real `fetch` on first connect.
 *
 * SCOPE (3c.B): rules → authUsers → seed docs → capture. The `--persist`
 * server-file tier and the `seedState` ephemeral-fixture restore are state-blob
 * concerns handled in 3c.D (the worker already attaches its own IDB durable
 * store; persist adds the committable server-file tier on top).
 *
 * CAPTURE FIDELITY: the worker's sandbox accumulates EVERY tab's events, so a
 * single capture reflects the unified backend — strictly better for the verify
 * loop than the per-tab in-page capture it replaces.
 */

import { getFirestore } from 'pyric/firestore';
import { seedDocuments, setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { getDatabase, sandbox as rtdbSandbox } from 'pyric/database';
import { getAuth, sandbox as authOps, type SeedUser } from 'pyric/auth';
import { getStorageSandbox } from 'pyric/storage';
import type { PersistenceBackend } from 'pyric/sandbox';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import {
  primeEventHistory,
} from 'pyric/sandbox/internal';
import type { InitPayload } from '../namespace.js';
import { setupFirebaseActivityGuard } from './activity-bootstrap.js';
import { setupAiDiagnosticsRelay } from '../ai-diagnostics-relay.js';
import { createWorkerDurableBackend, setupServerAuthFlush } from './durable-persistence.js';
import { ensureAuth, getOrCreateInstanceId, type HostCtx } from './host.js';
import { buildVerifyFixture, type PyricVerifyFixture } from '../../verify/fixture.js';

/** Injected environment — `fetch` is the only ambient the worker init needs
 *  (capture POSTs through it). Injectable so tests drive it with a stub. */
export interface ServeInitEnv {
  fetch: typeof fetch;
  /** Capture debounce window (ms). Default 400 — matches `runtime.ts`. Tests
   *  pass a small value to keep the round-trip fast. */
  captureDebounceMs?: number;
}

/** Minimal EventSource surface the worker hot-reload needs. The real browser
 *  `EventSource` satisfies it; tests pass a fake. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

/**
 * Re-deploy rules to the worker's sandbox when `pyric dev` hot-reloads
 * `firestore.rules`. On the worker path the SharedWorker owns ONE
 * `/__pyric/events` connection for the whole origin — so tabs open ZERO SSE
 * connections (avoiding Chrome's ~6-per-origin HTTP/1.1 cap, which multi-tab
 * pages otherwise hit) AND a single rules-change deploys once, not once per
 * tab. The `EventSource` is injected so this is testable without a browser.
 *
 * Returns a teardown that closes the stream.
 */
export function setupWorkerHotReload(
  ctx: HostCtx,
  makeEventSource: (url: string) => EventSourceLike,
): () => void {
  const events = makeEventSource('/__pyric/events');
  events.addEventListener('rules-changed', (ev) => {
    try {
      const { rules } = JSON.parse(ev.data) as { rules: string; rulesHash?: string };
      const lint = setRules(ctx.sandbox, rules);
      if (lint.parseError) throw new Error(JSON.stringify(lint.parseError));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[pyric worker] rules hot-reload failed:', err instanceof Error ? err.message : String(err));
    }
  });
  events.addEventListener('rtdb-rules-update', (ev) => {
    try {
      const { rules } = JSON.parse(ev.data) as { rules: { rules: Record<string, unknown> }; rulesHash?: string };
      const isRtdbMissing = ctx.rtdb === undefined;
      if (isRtdbMissing) {
        ctx.rtdb = getDatabase(ctx.sandbox);
      }
      rtdbSandbox.setRules(ctx.rtdb as ReturnType<typeof getDatabase>, rules);
      const isActiveRulesMissing = ctx.activeRules === undefined;
      if (isActiveRulesMissing) {
        ctx.activeRules = {};
      }
      (ctx.activeRules as Record<string, unknown>).database = {
        source: rules,
        updatedAt: Date.now(),
        status: 'active',
        messages: [],
      };
      // eslint-disable-next-line no-console
      console.info('[pyric worker] database.rules.json hot-reloaded');
    } catch (err) {
      const isErrorInstance = err instanceof Error;
      let errorMessage = String(err);
      if (isErrorInstance) {
        errorMessage = (err as Error).message;
      }
      // eslint-disable-next-line no-console
      console.error('[pyric worker] database rules hot-reload failed:', errorMessage);
    }
  });
  return () => events.close();
}

/** What `applyServeInit` did — surfaced for diagnostics + tests. `dispose`
 *  stops the capture event subscription (worker teardown / re-init). */
export interface ServeInitResult {
  rulesDeployed: boolean;
  /** Whether storage rules were deployed at boot. Storage rules are
   *  honored only on the FIRST `pyric/storage` call per Sandbox
   *  (see `getStorageSandbox`'s `StorageOptions.rules` doc) — so unlike
   *  `rulesDeployed`/database rules this never flips true→false→true
   *  across a session; it is decided once, here, before any storage op
   *  runs. */
  storageRulesDeployed: boolean;
  seededDocs: number;
  seededUsers: number;
  captureEnabled: boolean;
  /** Whether the init payload enabled the Messaging host capability. */
  messagingEnabled: boolean;
  /** Parse error from a malformed ruleset (defensive — the server lints first);
   *  the sandbox keeps its default rules rather than bricking. */
  rulesParseError: string | null;
  /** Set when a `--seed` fixture (docs and/or authUsers) was withheld because
   *  the sandbox already held restored/lived data — see the "seed applies
   *  only into an empty home" guard below. */
  seedSkipped: 'existing-data' | null;
  dispose(): void;
}

/**
 * A seed fixture applies ONLY into an empty home. `buildWorkerCtx` calls
 * `sandbox.enablePersistence` (restoring from IDB — and, with `--persist`,
 * priming from the committable server file — see `createWorkerDurableBackend`)
 * BEFORE `applyServeInit` runs, so by the time this check runs any restored
 * data is already visible on `ctx`. If the sandbox holds ANY Firestore
 * document or auth user at this point, that's lived/restored state, not a
 * blank slate — a `--seed` fixture must never stomp it. This is the fix for
 * the worst persistence bug: without it, `--seed` (map form) re-applies on
 * EVERY boot because default (no `--persist`) mode never has a state.json
 * file to gate on, silently reverting whatever IndexedDB persistence just
 * restored.
 */
function sandboxHasExistingData(ctx: HostCtx): boolean {
  const docs = snapshotDocuments(ctx.sandbox);
  if (Object.keys(docs).length > 0) return true;
  const auth = ensureAuth(ctx);
  return authOps.exportUsers(auth).length > 0;
}

/**
 * Apply the init payload to the worker's sandbox.
 *
 * Ordering mirrors `runtime.ts`: rules first (so the first write is governed),
 * then authUsers (so restored docs' owner uids resolve in rules), then seed
 * docs, then capture wiring. Synchronous except for capture's fire-and-forget
 * POSTs — the caller (`entry.ts`) does not need to await anything here.
 */
export function applyServeInit(
  ctx: HostCtx,
  payload: InitPayload,
  env: ServeInitEnv,
): ServeInitResult {
  const result: ServeInitResult = {
    rulesDeployed: false,
    storageRulesDeployed: false,
    seededDocs: 0,
    seededUsers: 0,
    captureEnabled: false,
    messagingEnabled: false,
    rulesParseError: null,
    seedSkipped: null,
    dispose: () => {},
  };

  // 0. Messaging host capability. Serve producers enable it as part of the
  //    canonical SDK swap; a worker without an init payload stays disabled.
  if (payload.messaging === true) {
    ctx.messagingEnabled = true;
    result.messagingEnabled = true;
  }

  // 1. Rules — deploy the project's ruleset, replacing the permissive starter
  //    `entry.ts` deployed at bootstrap. A parse error is defensive (the server
  //    lints before serving): keep the default rules, surface loudly.
  if (payload.rules) {
    const lint = setRules(ctx.sandbox, payload.rules);
    if (lint.parseError) {
      result.rulesParseError = JSON.stringify(lint.parseError);
      console.error(
        '[pyric worker] firestore.rules failed to parse — running WITHOUT your rules:',
        result.rulesParseError,
      );
    } else {
      result.rulesDeployed = true;
      // Record the deployed source on ctx (mirrors the database branch below)
      // so diagnostics report it AND the `resetAll` op can re-deploy it —
      // `sandbox.resetAll()` swaps the env, which wipes env-owned Firestore
      // rules; a data reset must not silently de-govern writes.
      ctx.activeRules ??= {};
      ctx.activeRules.firestore = {
        source: payload.rules,
        updatedAt: Date.now(),
        status: 'active',
        messages: [],
      };
    }
  }
  const rtdb = ctx.rtdb ??= getDatabase(ctx.sandbox);
  if (payload.databaseRules) {
    rtdbSandbox.setRules(rtdb, payload.databaseRules);
    ctx.activeRules ??= {};
    ctx.activeRules.database = {
      source: payload.databaseRules,
      updatedAt: Date.now(),
      status: 'active',
      messages: [],
    };
  } else if (payload.permissive) {
    rtdbSandbox.setDefaultPolicy(rtdb, 'allow');
  } else {
    rtdbSandbox.setDefaultPolicy(rtdb, 'deny');
  }

  // 1b. Storage rules — deployed ONCE, here, before any storage op can run.
  //     `pyric/storage`'s `getStorageSandbox` only honors a `rules` option on
  //     the FIRST call per Sandbox (later differing rules throw — a
  //     deliberate silent-rules-wipe guard, see StorageOptions.rules). This
  //     call IS that first call: `ensureStorage`/`lensStorage` in host.ts
  //     always open storage with no `rules` option, so whichever call opens
  //     the service first wins — making this the sanctioned place to
  //     configure it. `payload.storageRules` is null when the project has no
  //     storage.rules, so the storage sandbox retains its fail-closed default.
  //     The open ALSO claims the project-scoped IDB name
  //     (`pyric-storage:<projectKey>`, issue #359) — which is why it now runs
  //     unconditionally: a lazy first open from `ensureStorage`/`lensStorage`
  //     would land on the legacy shared database.
  getStorageSandbox(ctx.sandbox, {
    ...(payload.storageRules ? { rules: payload.storageRules } : {}),
    ...(payload.projectKey ? { projectId: payload.projectKey } : {}),
  });
  if (payload.storageRules) {
    result.storageRulesDeployed = true;
  }

  // A seed fixture applies only into an empty home — checked ONCE, before
  // either seed step, so step 2's own writes can't make step 3's check look
  // non-empty (see sandboxHasExistingData).
  const hasExistingData =
    ((payload.seed && Object.keys(payload.seed).length > 0) ||
      (payload.authUsers && payload.authUsers.length > 0)) &&
    sandboxHasExistingData(ctx);
  if (hasExistingData) {
    result.seedSkipped = 'existing-data';
    console.info(
      '[pyric worker] --seed skipped: the sandbox already has restored data (persisted state or ' +
        'an earlier session in this browser) — the fixture would have overwritten it. Use ' +
        '`--persist --fresh` to discard existing state and re-seed from scratch.',
    );
  }

  // 2. Auth users — seed BEFORE docs so any owner-uid the rules reference
  //    resolves, and before session restore so there is a DB to restore into.
  if (!hasExistingData && payload.authUsers && payload.authUsers.length > 0) {
    const auth = ensureAuth(ctx);
    authOps.seedUsers(auth, payload.authUsers as unknown as ReadonlyArray<SeedUser>);
    result.seededUsers = payload.authUsers.length;
  }

  // 3. Seed docs — admin-style fixture load (bypasses rules).
  if (!hasExistingData && payload.seed && Object.keys(payload.seed).length > 0) {
    seedDocuments(ctx.sandbox, payload.seed);
    result.seededDocs = Object.keys(payload.seed).length;
  }

  // 4. Capture — the write side of the `pyric verify` loop. On every sandbox
  //    event, debounce-POST the full session fixture (rules + history + state)
  //    to `/__pyric/capture`. The server writes it verbatim to
  //    `.pyric/last-session.json`. Independent of --persist.
  if (payload.capture) {
    const debounceMs = payload.capture ? (env.captureDebounceMs ?? 400) : 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = async (): Promise<void> => {
      const rtdb = ctx.rtdb ??= getDatabase(ctx.sandbox);
      const rtdbState =
        payload.databaseRules || ctx.sandbox.history().some((event) => event.service === 'rtdb')
          ? rtdbSandbox.snapshotState(rtdb)
          : undefined;
      const auth = ensureAuth(ctx);
      const body = JSON.stringify(buildVerifyFixture({
        sandbox: ctx.sandbox,
        firestoreRules: payload.rules,
        rtdbRules: payload.databaseRules ?? null,
        rtdbState,
        rtdbDatabaseUrl: payload.databaseUrl ?? null,
        authState: {
          users: authOps.exportUsers(auth),
          currentUser: ctx.sandbox.currentUser,
        },
        // Stamp WHO produced this capture so a booting worker only re-hydrates
        // its OWN session (see hydrateEventHistory's identity guard).
        capturedBy: ctx.instanceId,
      }));
      // Relative URL resolves against the worker script's origin (same origin
      // as the page). Fire-and-forget — capture failures never break ops.
      const captureHeaders: Record<string, string> = {
        'content-type': 'application/json',
        ...(payload.sessionToken ? { 'x-pyric-session-token': payload.sessionToken } : {}),
      };
      await env.fetch('/__pyric/capture', {
          method: 'POST',
          headers: captureHeaders,
          body,
        })
        .catch(() => {});
    };

    const unsub = ctx.sandbox.onEvent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, debounceMs);
    });

    result.captureEnabled = true;
    // Immediate-flush seam for the `resetAll` op (issue #359 extension):
    // reset clears `sandbox.history()`, and the SERVER-persisted capture
    // (`.pyric/last-session.json`) must follow NOW — inside the debounce
    // window a dying worker leaves the wiped session's events on disk, and
    // the next boot's `hydrateEventHistory` would prime them straight back
    // into Traffic. Bypasses the debounce; cancels any pending flush (it
    // would only re-write the same post-reset history).
    ctx.captureFlush = async (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    };
    result.dispose = (): void => {
      if (timer) clearTimeout(timer);
      unsub();
      ctx.captureFlush = undefined;
    };
  }

  return result;
}

// ─── Event-history hydration: survive worker death (served mode) ─────────────

/**
 * Cap on the number of events primed on boot. A long-lived session can
 * accumulate a large capture; a fresh worker only needs enough recent history
 * for Traffic / activity / metrics to feel continuous, so we prime the most
 * recent N and drop older events rather than balloon worker memory with the
 * whole log. The full log still lives on disk for `pyric verify`.
 */
export const MAX_PRIMED_EVENTS = 2000;

/**
 * Re-hydrate the worker's in-memory event history from the served capture
 * file on boot — the fix for "worker death zeroes Traffic / activity / metrics
 * even though the data restored from IDB".
 *
 * The SERVER already holds the complete event log (`.pyric/last-session.json`,
 * written continuously by the capture flush). On a fresh worker we GET it back
 * and REPLAY `events[]` into the sandbox's `history()` via the
 * {@link primeEventHistory} seam — append-only, NO re-execution of ops and NO
 * dispatch to live `onEvent` subscribers. Studio subscribes AFTER boot and
 * reads history-first, so append-only-no-dispatch gives every consumer
 * continuity for free with zero Studio changes.
 *
 * GUARD RAILS:
 *  - Only primes when history is EMPTY (the {@link primeEventHistory} seam
 *    enforces this) — a warm sandbox is never disturbed and primed events can
 *    never interleave after live boot events. Call this BEFORE applyServeInit.
 *  - Caps at {@link MAX_PRIMED_EVENTS} (most recent) so a huge capture can't
 *    balloon worker memory.
 *  - IDENTITY: skips when the capture was produced by a DIFFERENT instance
 *    (`capturedBy !== ctx.instanceId`) — another browser profile sharing one
 *    `pyric dev` shouldn't see someone else's session as its own. A capture
 *    with no `capturedBy` (older / standalone) primes best-effort.
 *  - Skips cleanly when the endpoint 404s (capture off / nothing captured) or
 *    the fetch throws (standalone worker, no `pyric dev` behind it).
 *
 * FRESHNESS: the capture lags the last pre-death moments by up to the debounce
 * window (~400ms), so the final events before a worker death may be missing.
 * That is acceptable — the data itself is durable via IDB; this only restores
 * the activity RECORD, and near-perfect is enough for Traffic/feed continuity.
 *
 * Returns the number of events primed (0 when skipped).
 */
export async function hydrateEventHistory(
  ctx: HostCtx,
  env: ServeInitEnv,
  sessionToken?: string,
): Promise<number> {
  let res: Response;
  try {
    const headers: Record<string, string> = sessionToken
      ? { 'x-pyric-session-token': sessionToken }
      : {};
    res = await env.fetch('/__pyric/capture', { headers });
  } catch {
    return 0; // standalone / no capture endpoint.
  }
  if (res.status !== 200) return 0; // 404 → capture off or nothing captured.

  let fixture: PyricVerifyFixture;
  try {
    fixture = JSON.parse(await res.text()) as PyricVerifyFixture;
  } catch {
    return 0; // corrupt capture — never brick boot over the activity log.
  }

  const events = fixture.events;
  if (!Array.isArray(events) || events.length === 0) return 0;

  // Identity: don't show a neighbor profile's session as ours.
  if (fixture.capturedBy && fixture.capturedBy !== ctx.instanceId) return 0;

  const capped =
    events.length > MAX_PRIMED_EVENTS ? events.slice(-MAX_PRIMED_EVENTS) : events;
  return primeEventHistory(ctx.sandbox, capped);
}

// ─── Worker boot: build the ONE shared HostCtx ──────────────────────────────

/** Legacy shared persistence key — also the IndexedDB database name. Stable
 *  across reloads (never derived from the page path). Used ONLY when no
 *  project identity exists (older servers without `InitPayload.projectKey`,
 *  standalone workers) — see {@link workerPersistenceKey}. */
export const WORKER_PERSISTENCE_KEY = 'pyric-shared-worker';

/**
 * Resolve the worker's persistence key (= IndexedDB database name) for a
 * project identity: `pyric-shared-worker:<projectKey>`, or the legacy shared
 * {@link WORKER_PERSISTENCE_KEY} when none is available.
 *
 * IndexedDB is origin-scoped, so the FIXED key made every project served on
 * one localhost port share ONE sandbox snapshot database — another app's auth
 * users, Firestore docs, and RTDB tree appeared in an unrelated project
 * (issue #359's storage defect, same family; identity flows from the same
 * `InitPayload.projectKey` the storage fix uses).
 *
 * Migration decision — mirrors `storageDbName` in pyric's
 * `storage/persistence.ts`, recorded here deliberately: the legacy shared
 * `pyric-shared-worker` database is ORPHANED, not migrated (cross-project
 * state disappearing from the sandbox is the point of the fix) and not
 * deleted (older pyric versions on the same origin may still read it).
 */
export function workerPersistenceKey(projectKey?: string | null): string {
  return projectKey ? `${WORKER_PERSISTENCE_KEY}:${projectKey}` : WORKER_PERSISTENCE_KEY;
}

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

/** Environment for {@link buildWorkerCtx}. Everything ambient is injected so
 *  the REAL boot path is testable headlessly (fake-indexeddb + stub fetch). */
export interface WorkerBootEnv extends ServeInitEnv {
  /** The raw local backend (IndexedDB in the real worker). Also used for the
   *  instance id + branches + (via the durable wrapper) the controller blob. */
  idb: PersistenceBackend;
  /** Persistence key / IDB database name. An explicit key always wins (tests
   *  isolate per-case state with it); the default is project-scoped via
   *  {@link workerPersistenceKey} from the init payload's `projectKey`. */
  persistenceKey?: string;
  /** Hot-reload EventSource factory. Omit/null when unavailable (tests, hosts
   *  without EventSource). */
  makeEventSource?: ((url: string) => EventSourceLike) | null;
}

/**
 * Build the ONE shared sandbox + Firestore handle — the SharedWorker's boot
 * path, extracted from `entry.ts` so it is testable without a SharedWorker
 * runtime (the reload-durability regression tests boot it twice over one
 * fake-IDB factory).
 *
 * DURABILITY CONTRACT: persistence is wired via `sandbox.enablePersistence`
 * (NOT the raw `attachPersistence` helper) so the controller registers on the
 * sandbox and `sandbox.flush()` works. The worker host awaits that flush —
 * which awaits the IndexedDB transaction's `oncomplete` — before acking every
 * mutating op. That is the worker's ONLY durability mechanism: a SharedWorker
 * gets no beforeunload/beforeterminate, so anything not committed to IDB when
 * the last tab closes is lost.
 */
export async function buildWorkerCtx(bootEnv: WorkerBootEnv): Promise<HostCtx> {
  // Detach `fetch` from the env record before ANY use (issue #364). Every call
  // site in this module invokes it as `env.fetch(...)`, which binds `this` to
  // the env object — and the real browser/worker `fetch` is this-sensitive:
  // it throws "Illegal invocation" unless `this` is undefined or the global.
  // That silent throw meant the capture flush never POSTed and
  // `hydrateEventHistory`'s GET failed into its catch, so a REBOOTED worker
  // always answered Studio's first event subscription with an EMPTY history —
  // the Activity/Traffic first open showed nothing until new live events
  // arrived. The wrapper restores a plain call (`this` undefined ⇒ the
  // global); injected test stubs are unaffected.
  const ambientFetch = bootEnv.fetch;
  const env: WorkerBootEnv = {
    ...bootEnv,
    // Cast: Bun's `typeof fetch` also declares a `preconnect` member the
    // plain-call wrapper doesn't need (nothing in this module uses it).
    fetch: ((...args: Parameters<typeof fetch>) => ambientFetch(...args)) as typeof fetch,
  };
  const sandbox = createSandboxRoot();

  // Deploy permissive starter rules via admin-firestore.
  // Callers override at runtime via the setRules op.
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(PERMISSIVE_RULES);

  // Fetch serve's init payload FIRST — it decides the DURABLE strategy before
  // we attach (`--persist` mirrors the controller blob to the committable
  // server file and primes from it on a fresh worker; a `seedState` fixture
  // primes IDB once) AND it carries `projectKey`, which must exist BEFORE the
  // first restore/save below: the persistence key is chosen exactly once at
  // enablePersistence, so a lazy identity here would claim the legacy shared
  // database — the same eager-vs-lazy trap the storage DB scoping hit (see
  // applyServeInit's unconditional storage open). Null when standalone (no
  // `pyric dev` behind us) — the legacy shared key then applies.
  const payload = await fetchInitPayload(env.fetch);

  // The persistence-controller backend. `--persist`/`seedState` wrap IDB (see
  // createWorkerDurableBackend); plain IDB otherwise. The session record stays
  // on the RAW idb (local-only — it must NEVER reach the committable server
  // file), so that is what we hand the host as `sessionBackend`.
  const durable = payload ? createWorkerDurableBackend(env.idb, payload, env) : env.idb;
  await sandbox.enablePersistence({
    key: env.persistenceKey ?? workerPersistenceKey(payload?.projectKey),
    injectedBackend: durable,
  });

  // Register the auth service with the persistence registry BEFORE we read
  // back any session: `getAuth(sandbox)` makes the user DB ride the snapshot
  // (the #629 mechanism). One auth per worker — one shared user pool across
  // all tabs (sessions are per-port; see host-auth.ts).
  getAuth(sandbox);

  // Register RTDB with the persistence registry EAGERLY, same reasoning as
  // auth above: `getDatabase(sandbox)` calls `registerPersistableService`,
  // which makes the persisted tree ride the controller blob AND (via the
  // controller's late-registration hook) applies the restored tree NOW. The
  // worker otherwise creates RTDB handles lazily (`ctx.rtdb ??= ...`), so a
  // Studio RTDB-tab read that arrives before any RTDB op would see an empty
  // tree even though a prior session's data was persisted. Eager registration
  // makes the restored tree queryable immediately.
  getDatabase(sandbox);

  // Sandbox-live Firestore: `getFirestore(sandbox)` reads
  // `sandbox.currentUser` per operation, so auth changes propagate
  // to subsequent Firestore ops without rebuilding the handle.
  const db = getFirestore(sandbox);

  const ctx: HostCtx = {
    db,
    sandbox,
    // Stable per-SharedWorker identity (raw idb, local-only). Two browser
    // profiles on the same port get two ids — how the UI tells them apart.
    instanceId: await getOrCreateInstanceId(env.idb),
    subs: new Map(),
    sessionBackend: env.idb,
    sessionMode: 'LOCAL',
  };

  // Re-hydrate the event history from the served capture BEFORE applyServeInit
  // runs — history is empty here (fresh sandbox, persistence restore emits no
  // sandbox events), so primed events land first and any live boot events
  // (seed, first ops) follow. This is what makes Traffic / activity / metrics
  // survive a worker death: the DATA came back from IDB above, this restores
  // the RECORD of it. Best-effort — a failure never blocks boot.
  if (payload?.capture) {
    try {
      await hydrateEventHistory(ctx, env, payload?.sessionToken);
    } catch {
      /* activity-log hydration is non-essential; never brick boot over it. */
    }
  }

  // Plugin-level engine config (`@pyric/cli/vite`'s `ai.engine`) → the host
  // engine slot. It wins over any op-carried `engine` field (see ensureAiBroker
  // in host-ai.ts) and is honored on the first ai op — mirroring getAI's
  // first-call-wins idempotence. Absent under `pyric dev` (no CLI surface).
  if (payload?.ai?.engine) ctx.aiEngine = payload.ai.engine;

  // Default-on, warning-only. Start after hydration so a restored capture can
  // populate a report without replaying an old warning into a fresh terminal.
  setupFirebaseActivityGuard(ctx, env, payload?.activityToken);

  // Same seam, AI's diagnostics: relay every broker `request_rejected`,
  // `response_blocked`, and `model_substituted` event to the dev server's
  // denial relay so a headless developer sees why the broker said no, why an
  // answer came back empty, or which model actually answered. Live events
  // only, so it is safe on either side of hydration.
  setupAiDiagnosticsRelay({ subscribe: (listener) => ctx.sandbox.onEvent(listener) }, env.fetch);

  // Apply rules / seed / authUsers / capture BEFORE any port op runs (so
  // seeded users exist and project rules govern the first write), then mirror
  // auth to the committable server file (`--persist` only).
  if (payload) {
    applyServeInit(ctx, payload, env);
    setupServerAuthFlush(ctx, payload, env);
  }

  // The worker owns the SINGLE hot-reload stream for the origin (tabs open
  // none) — so a rules change deploys once and multi-tab pages never exhaust
  // the per-origin connection cap.
  if (env.makeEventSource) {
    setupWorkerHotReload(ctx, env.makeEventSource);
  }

  return ctx;
}

/**
 * Fetch + parse `/__pyric/init.json`. The URL is relative to the worker
 * script's origin (same origin as the page). Returns null on any failure: a
 * worker opened outside `pyric dev` has no init endpoint and simply keeps
 * the permissive starter rules + a plain-IDB durable store.
 */
async function fetchInitPayload(fetchFn: typeof fetch): Promise<InitPayload | null> {
  try {
    const res = await fetchFn('/__pyric/init.json');
    if (!res.ok) return null;
    return (await res.json()) as InitPayload;
  } catch {
    return null;
  }
}
