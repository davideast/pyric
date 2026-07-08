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

import { sandbox as sandboxOps } from 'pyric/firestore';
import { getDatabase, sandbox as rtdbSandbox } from 'pyric/database/modular';
import { sandbox as authOps, type SeedUser } from 'pyric/auth';
import type { PersistenceBackend } from 'pyric/sandbox';
import { serializeToBuckets, bundleRecords, parseBundle } from 'pyric/sandbox';
import type { InitPayload } from '../namespace.js';
import { ensureAuth, type HostCtx } from './host.js';
import { buildVerifyFixture } from '../../verify/fixture.js';

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
      const lint = sandboxOps.setRules(ctx.db, rules);
      if (lint.parseError) throw new Error(JSON.stringify(lint.parseError));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[pyric worker] rules hot-reload failed:', err instanceof Error ? err.message : String(err));
    }
  });
  return () => events.close();
}

/** What `applyServeInit` did — surfaced for diagnostics + tests. `dispose`
 *  stops the capture event subscription (worker teardown / re-init). */
export interface ServeInitResult {
  rulesDeployed: boolean;
  seededDocs: number;
  seededUsers: number;
  captureEnabled: boolean;
  /** Parse error from a malformed ruleset (defensive — the server lints first);
   *  the sandbox keeps its default rules rather than bricking. */
  rulesParseError: string | null;
  dispose(): void;
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
    seededDocs: 0,
    seededUsers: 0,
    captureEnabled: false,
    rulesParseError: null,
    dispose: () => {},
  };

  // 1. Rules — deploy the project's ruleset, replacing the permissive starter
  //    `entry.ts` deployed at bootstrap. A parse error is defensive (the server
  //    lints before serving): keep the default rules, surface loudly.
  if (payload.rules) {
    const lint = sandboxOps.setRules(ctx.db, payload.rules);
    if (lint.parseError) {
      result.rulesParseError = JSON.stringify(lint.parseError);
      console.error(
        '[pyric worker] firestore.rules failed to parse — running WITHOUT your rules:',
        result.rulesParseError,
      );
    } else {
      result.rulesDeployed = true;
    }
  }
  if (payload.databaseRules) {
    const rtdb = ctx.rtdb ??= getDatabase(ctx.sandbox);
    rtdbSandbox.setRules(rtdb, payload.databaseRules);
    ctx.activeRules ??= {};
    ctx.activeRules.database = {
      source: payload.databaseRules,
      updatedAt: Date.now(),
      status: 'active',
      messages: [],
    };
  }

  // 2. Auth users — seed BEFORE docs so any owner-uid the rules reference
  //    resolves, and before session restore so there is a DB to restore into.
  if (payload.authUsers && payload.authUsers.length > 0) {
    const auth = ensureAuth(ctx);
    authOps.seedUsers(auth, payload.authUsers as unknown as ReadonlyArray<SeedUser>);
    result.seededUsers = payload.authUsers.length;
  }

  // 3. Seed docs — admin-style fixture load (bypasses rules).
  if (payload.seed && Object.keys(payload.seed).length > 0) {
    sandboxOps.seedDocuments(ctx.db, payload.seed);
    result.seededDocs = Object.keys(payload.seed).length;
  }

  // 4. Capture — the write side of the `pyric verify` loop. On every sandbox
  //    event, debounce-POST the full session fixture (rules + history + state)
  //    to `/__pyric/capture`. The server writes it verbatim to
  //    `.pyric/last-session.json`. Independent of --persist.
  if (payload.capture) {
    const debounceMs = payload.capture ? (env.captureDebounceMs ?? 400) : 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
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
      }));
      // Relative URL resolves against the worker script's origin (same origin
      // as the page). Fire-and-forget — capture failures never break ops.
      env
        .fetch('/__pyric/capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        .catch(() => {});
    };

    const unsub = ctx.sandbox.onEvent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    });

    result.captureEnabled = true;
    result.dispose = (): void => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }

  return result;
}

// ─── Durable persistence: the --persist server-file tier + seedState (3c.D) ─

/**
 * Stable writer id the worker sends on every `/__pyric/state` POST. There is
 * exactly ONE worker per origin, so it is the sole writer — the multi-tab
 * 423 / writer-lock contention the in-page path fights does not arise. The id
 * is constant so the server's lock recognizes the same holder across writes;
 * if the worker dies (all tabs closed) the server frees the stale lock and the
 * next worker reclaims it.
 */
const WORKER_WRITER_ID = 'pyric-shared-worker';

const stateSection = (name: 'firestore' | 'auth'): string => `/__pyric/state?section=${name}`;

/**
 * Build the worker's DURABLE backend for the persistence controller.
 *
 *  - **default** (no `--persist`, no `seedState`): the injected IDB backend,
 *    untouched — IDB is the durable store and the multi-tab sync point.
 *  - **`--persist`**: a composite over IDB that ALSO mirrors the controller
 *    blob to the committable server file (`/__pyric/state?section=firestore`).
 *    On a fresh worker (IDB empty) it PRIMES from the server file, so a
 *    committed `.pyric/state` restores. The blob the controller hands `write`
 *    is the SAME `serializeSnapshot(firestore, services)` the in-page path
 *    posts there, so the on-disk format is byte-identical — and auth rides it
 *    via `services` (the #629 registry).
 *  - **`seedState`** (a `--seed <state-file>` fixture WITHOUT `--persist`):
 *    primes IDB once from the fixture blob, then lives in IDB. No server file.
 *
 * IMPORTANT: this wraps ONLY the persistence-controller backend. The worker's
 * session record (`SESSION_RECORD_KEY`) is local-only and must NOT reach the
 * server file, so `entry.ts` keeps the RAW IDB backend as `ctx.sessionBackend`.
 *
 * Local IDB always wins on read: we never clobber live local state with a
 * stale server file — pyric is a single local backend (no two-source
 * reconciliation), so the server file is a prime-once source + an export sink.
 */
export function createWorkerDurableBackend(
  idb: PersistenceBackend,
  payload: InitPayload,
  env: ServeInitEnv,
): PersistenceBackend {
  const persist = Boolean(payload.persist);
  const seed = (payload.seedState ?? null) as {
    firestore?: Record<string, Record<string, unknown>>;
    services?: Record<string, unknown>;
  } | null;
  // Fixture (seedState without --persist): the seed docs as v3 records, primed
  // once into IDB. The committable v3 BUNDLE the file holds and the records IDB
  // holds are the same data in two shapes.
  const fixtureRecords =
    !persist && seed != null
      ? serializeToBuckets(seed.firestore ?? {}, seed.services ?? {}, 0)
      : null;

  // Plain IDB — nothing to layer on.
  if (!persist && fixtureRecords === null) return idb;

  // Prime IDB once from the export source (committable file / fixture) on a
  // fresh worker. Local IDB always wins: never clobber live local state.
  let primed = false;
  const primeOnce = async (key: string): Promise<void> => {
    if (primed) return;
    primed = true;
    if ((await idb.listRecords(key)).length > 0) return;
    if (persist) {
      const res = await env.fetch(stateSection('firestore'));
      if (res.status === 200) {
        const records = parseBundle(await res.text());
        if (records.size > 0) await idb.putRecords(key, records);
      }
    } else if (fixtureRecords !== null) {
      await idb.putRecords(key, fixtureRecords);
    }
  };

  // Mirror the FULL current record set to the committable server file as one v3
  // bundle. Fire-and-forget: a flaky export must never block a local write.
  const mirror = async (key: string): Promise<void> => {
    if (!persist) return;
    try {
      const ids = await idb.listRecords(key);
      const all = new Map<string, unknown>();
      for (const id of ids) {
        const r = await idb.getRecord(key, id);
        if (r != null) all.set(id, r);
      }
      const res = await env.fetch(stateSection('firestore'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pyric-writer': WORKER_WRITER_ID },
        body: bundleRecords(all),
      });
      if (res.status === 423) {
        console.warn('[pyric worker] --persist: server file is held by another writer; export skipped.');
      }
    } catch {
      /* export sink offline; local IDB is unaffected. */
    }
  };

  return {
    async getRecord(key, recordId) {
      await primeOnce(key);
      return idb.getRecord(key, recordId);
    },
    async listRecords(key) {
      await primeOnce(key);
      return idb.listRecords(key);
    },
    async putRecords(key, records) {
      await idb.putRecords(key, records); // IDB is the live durable store.
      await mirror(key);
    },
    async deleteRecords(key, recordIds) {
      await idb.deleteRecords(key, recordIds);
      await mirror(key);
    },
    async clear(key) {
      await idb.clear(key);
      if (!persist) return;
      try {
        await env.fetch(stateSection('firestore'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pyric-writer': WORKER_WRITER_ID },
          body: 'null',
        });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Mirror the auth user DB to the committable server file's `auth` section
 * (`--persist` only), matching the in-page path so a worker-written
 * `.pyric/state` is format-identical (and `pyric dev`'s init payload, which
 * reads `section=auth` for `authUsers`, stays populated). Auth ALSO rides the
 * firestore controller blob via `services`; this separate mirror is the
 * belt-and-suspenders the in-page path keeps.
 *
 * Returns a teardown that stops the subscription.
 */
export function setupServerAuthFlush(
  ctx: HostCtx,
  payload: InitPayload,
  env: ServeInitEnv,
): () => void {
  if (!payload.persist) return () => {};
  const auth = ensureAuth(ctx);
  const debounceMs = env.captureDebounceMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    const body = JSON.stringify({ users: authOps.exportUsers(auth) });
    env
      .fetch(stateSection('auth'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pyric-writer': WORKER_WRITER_ID },
        body,
      })
      .catch(() => {});
  };

  const unsub = authOps.subscribeUsers(auth, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
}
