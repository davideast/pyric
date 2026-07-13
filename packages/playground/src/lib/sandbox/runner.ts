/**
 * Glue between the playground and `@pyric/sandbox`. One root sandbox
 * per page; `deployRules` swaps the active ruleset without dropping
 * seeded data, `readState` exposes an admin-bypass snapshot the
 * diagnostic tools + Firestore data viewer read from.
 *
 * Persistence: the workspace sandbox persists PER SESSION under
 * `pyric:sandbox:{sessionId}` (IndexedDB) — seeded data, AUTH USERS, and the
 * signed-in session all survive a reload and come back when the user reopens
 * the session. Firestore + the auth user DB ride the durable snapshot; the
 * current user follows `setPersistence` semantics via per-session
 * localStorage/sessionStorage wrappers (see the constructor). Matches prod
 * Firebase: reload keeps you signed in.
 *
 * Historical note: this used to host an AsyncFunction-based script
 * interpreter (`run(source)`) that the `runOnce` tool invoked. That
 * lane was retired when the playground moved to the file-tools loop
 * (`write_file` + `seed_firestore_data_as_admin` + `simulate_firestore_write`).
 * The `run()` method survives as a hard-throw stub so the
 * `SandboxHandle` interface from `@inbrowser/agent` (which mandates
 * `run`) still compiles for tool authors who reach for `ctx.sandbox`.
 */
import {
  initializeSandbox,
  SandboxError,
  type Sandbox,
  type SandboxPersistenceOptions,
  type WebStorageLike,
} from 'pyric/sandbox';
import {
  getFirestore,
  type Firestore,
} from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  sandbox as authSandboxOps,
} from 'pyric/auth';
import { wireAuthTabSync } from './tab-sync-wiring.js';

export type LogLevel = 'info' | 'error' | 'denial';

export interface LogEntry {
  level: LogLevel;
  tag?: string;
  message: string;
  /** Stringified payload; `undefined` means the message stands alone. */
  payload?: string;
}

export interface RunResult {
  ok: boolean;
  entries: LogEntry[];
  durationMs: number;
  docsTouched: number;
  writes: number;
  deletes: number;
  denials: number;
  errors: number;
}

export interface DeployResult {
  ok: boolean;
  messages: { severity: 'info' | 'warn' | 'error'; text: string; line?: number; column?: number }[];
}

export interface SandboxRunnerOptions {
  /**
   * Persistence wiring for the sandbox. When set, the runner enables
   * sandbox persistence at construction (restoring any prior snapshot for
   * `persistence.key`) and exposes the restore as `ready`. When omitted the
   * sandbox is ephemeral — the pre-persistence behavior, kept for headless
   * tests and sessionless pages.
   *
   * What persists: Firestore documents AND the auth user DB (both ride the
   * durable `Sandbox.snapshot()` services). The signed-in session restores
   * too — the constructor injects per-session `sessionStorage` wrappers so
   * the current user survives reload (honoring `setPersistence`). Pass an
   * explicit `sessionStorage` to override the default browser wiring.
   */
  persistence?: SandboxPersistenceOptions;
}

/**
 * Wrap a browser Storage so every key is prefixed with `ns` — scopes the
 * auth session per playground session (each session's IndexedDB key is its
 * namespace) so switching sessions doesn't cross-wire who's signed in. The
 * library's session controller uses one fixed key; this makes it per-session.
 */
function namespacedStorage(real: Storage, ns: string): WebStorageLike {
  const prefix = `${ns}:`;
  return {
    getItem: (k) => real.getItem(prefix + k),
    setItem: (k, v) => real.setItem(prefix + k, v),
    removeItem: (k) => real.removeItem(prefix + k),
  };
}

/** Debounce for runner-scheduled flushes (admin writes). Matches the
 *  persistence controller's own default flush interval. */
const ADMIN_FLUSH_DEBOUNCE_MS = 250;

export class SandboxRunner {
  private sandbox: Sandbox;
  private db: Firestore;
  /**
   * Resolves once persistence (when configured) has restored any prior
   * snapshot into the live sandbox. Mirrors `SessionsSandbox.ready`.
   * Resolves immediately for an ephemeral runner. Never rejects —
   * persistence failures are non-fatal (warn + proceed in-memory).
   */
  readonly ready: Promise<void>;
  /** Persistence key in effect, or `null` for an ephemeral runner.
   *  Exposed for tests and diagnostics. */
  readonly persistenceKey: string | null;
  /** True once `enablePersistence` succeeded — gates runner-scheduled
   *  flushes so a failed enable doesn't produce a warn per write. */
  private persistenceActive = false;
  private readonly flushDebounceMs: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Cross-tab sync ─────────────────────────────────────────────────────
  //
  // WHY: two tabs open on the same playground session must see each other's
  // Firestore writes + sign-in/out in real time, mirroring production
  // Firebase's WebSocket-backed live updates. Two independent channels carry
  // two independent kinds of state:
  //
  //   1. Firestore data  — `sandbox.enableTabSync()` (the library primitive).
  //      The channel name includes `persistence.key` (which encodes the
  //      session id) so only tabs on the SAME session sync — different
  //      sessions use different channels and never cross-wire.
  //
  //   2. Auth state      — `wireAuthTabSync()` (playground-local helper).
  //      Same per-session scoping via a SECOND channel with the key in its
  //      name. See `tab-sync-wiring.ts` for the full protocol description.
  //
  // Both channels are created here (owned by this instance) and closed in
  // `dispose()`. The disable fns returned by both wiring calls are also
  // stored so `dispose()` tears down listeners before the channels close.
  //
  // Node / SSR / bun-test guard: both channels are created only when
  // `BroadcastChannel` is available in the global scope. The existing
  // node tests (which lack BroadcastChannel) therefore remain unaffected
  // — no sandbox event subscribers are added, no channels are created.
  private disableFirestoreTabSync: (() => void) | null = null;
  private disableAuthTabSync: (() => void) | null = null;
  private firestoreTabSyncChannel: { close(): void } | null = null;
  private authTabSyncChannel: { close(): void } | null = null;

  constructor(options: SandboxRunnerOptions = {}) {
    this.sandbox = initializeSandbox();
    this.db = getFirestore(this.sandbox);
    const persistence = options.persistence;
    this.persistenceKey = persistence?.key ?? null;
    this.flushDebounceMs = persistence?.flushIntervalMs ?? ADMIN_FLUSH_DEBOUNCE_MS;
    // Default the session storage to per-session-namespaced browser storage so
    // the signed-in user survives reload (prod parity). Honors setPersistence:
    // LOCAL→localStorage, SESSION→sessionStorage. Skipped server-side (tests)
    // where window is absent — the user DB still persists, the session doesn't.
    if (
      persistence &&
      !persistence.sessionStorage &&
      typeof window !== 'undefined' &&
      window.localStorage &&
      window.sessionStorage
    ) {
      persistence.sessionStorage = {
        local: namespacedStorage(window.localStorage, persistence.key),
        session: namespacedStorage(window.sessionStorage, persistence.key),
      };
    }
    if (persistence) {
      // Fire-and-forget mirror of `SessionsSandbox`: the enable promise
      // is exposed as `ready`; failures degrade to in-memory only.
      this.ready = this.sandbox
        .enablePersistence(persistence)
        .then(() => {
          this.persistenceActive = true;
          // The one-line restore status (console is the playground's
          // status surface for sandbox lifecycle, cf. `[sessions]`).
          const docs = Object.keys(this.sandbox.snapshot().firestore).length;
          console.info(
            `[sandbox] workspace persistence on '${persistence.key}' — restored ${docs} doc(s)`,
          );
        })
        .catch((e) => {
          console.warn('[sandbox] workspace persistence failed to enable:', e);
        });

      // ── Cross-tab sync (browser only) ────────────────────────────────
      //
      // Guard on BroadcastChannel presence so Node / SSR / bun tests
      // (which lack BroadcastChannel) stay inert — no channels created,
      // no subscribers added, existing tests unaffected.
      //
      // The channel names MUST embed `persistence.key` (which encodes
      // the session id): only tabs on the SAME session share a channel.
      // Different sessions → different key → different channel name →
      // zero cross-session bleed. This is the isolation guarantee.
      if (typeof BroadcastChannel !== 'undefined') {
        // 1. Firestore data — delegated to the library primitive.
        //    All tabs on this session broadcast their committed writes;
        //    receiving tabs apply them (re-evaluating read-rules for
        //    each listener's own identity). Independent of persistence —
        //    all tabs broadcast; the writer-lock tab still owns the
        //    persistence flush.
        const firestoreChannel = new BroadcastChannel(
          `pyric:playground:tabsync:${persistence.key}`,
        );
        this.firestoreTabSyncChannel = firestoreChannel;
        this.disableFirestoreTabSync = this.sandbox.enableTabSync({
          channel: firestoreChannel,
        });

        // 2. Auth state — bridged on a second per-session channel.
        //    `enableTabSync` carries Firestore write events only; auth
        //    sign-in / sign-out lives outside Firestore. The helper in
        //    `tab-sync-wiring.ts` uses a full-state protocol (user DB +
        //    currentUid), a hello/state late-join handshake, and an
        //    `applyingRemoteAuth` echo guard. See that file for the
        //    full protocol rationale.
        const authChannel = new BroadcastChannel(
          `pyric:playground:auth-sync:${persistence.key}`,
        );
        this.authTabSyncChannel = authChannel;
        const auth = getAuth(this.sandbox);
        this.disableAuthTabSync = wireAuthTabSync(
          auth,
          authSandboxOps,
          onAuthStateChanged,
          signOut,
          authChannel,
        );
      }
    } else {
      this.ready = Promise.resolve();
    }
  }

  /** Root sandbox. Exposed so the App preview can derive identity. */
  getSandbox(): Sandbox {
    return this.sandbox;
  }

  /** Identity-following Firestore (reads `sandbox.currentUser` per call). */
  getDb(): Firestore {
    return this.db;
  }

  /**
   * Admin surface that keeps persistence honest. Admin writes bypass
   * rules AND the sandbox event stream (`adminSetDocument` emits no
   * `kind: 'write'` event), so the persistence controller's auto-flush
   * never sees them. Every admin-path writer to the workspace sandbox
   * (the agent's `seed_firestore_data_as_admin` tool, the Firestore
   * tab's console-style edits) must go through THIS wrapper rather
   * than `getSandbox().admin` — it delegates 1:1 and schedules a
   * debounced flush after each mutation. Reads pass straight through.
   */
  get admin(): Sandbox['admin'] {
    const inner = this.sandbox.admin;
    return {
      getDocument: (path) => inner.getDocument(path),
      listDocuments: (prefix) => inner.listDocuments(prefix),
      setDocument: (path, data) => {
        inner.setDocument(path, data);
        this.schedulePersistFlush();
      },
      deleteDocument: (path) => {
        const result = inner.deleteDocument(path);
        this.schedulePersistFlush();
        return result;
      },
    };
  }

  /**
   * Debounced `sandbox.flush()` for mutations the persistence
   * controller can't observe (admin writes). No-op when persistence is
   * not configured or failed to enable.
   */
  schedulePersistFlush(): void {
    if (!this.persistenceKey) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.ready
        .then(() => (this.persistenceActive ? this.sandbox.flush() : undefined))
        .catch((e) => {
          console.warn('[sandbox] persist flush failed:', e);
        });
    }, this.flushDebounceMs);
  }

  /**
   * Reset the sandbox AND wipe its persisted blob. The order matters:
   *
   *   1. await `ready` — if the initial restore is still in flight,
   *      resetting first would let the restore re-hydrate stale docs
   *      into the post-reset env.
   *   2. `sandbox.reset()` — wipes in-memory state (docs, identity,
   *      event history).
   *   3. `clearPersistence()` — cancels any pending controller flush
   *      and deletes the persisted blob, so a reload after reset comes
   *      up empty instead of resurrecting pre-reset data.
   *
   * The quarantined `…:corrupt` blob (if any) is intentionally NOT
   * cleared — it's a forensic artifact, not live data.
   */
  async reset(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.ready;
    this.sandbox.reset();
    await this.sandbox.clearPersistence();
  }

  dispose(): void {
    // Tear down the sandbox so the persistence controller detaches its
    // event subscription, pending flush timer, and `beforeunload`
    // listener. Disposal does NOT clear the persisted blob — that's
    // `reset()`'s job; a dispose on navigation must leave the data for
    // the next page load to restore.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Detach tab-sync listeners before closing the channels so no
    // in-flight message handler fires against a closed channel.
    this.disableFirestoreTabSync?.();
    this.disableFirestoreTabSync = null;
    this.disableAuthTabSync?.();
    this.disableAuthTabSync = null;
    // Close the BroadcastChannels — releases the OS handle and stops
    // any further message delivery to this tab. Channels are only
    // non-null when BroadcastChannel was available at construction time.
    this.firestoreTabSyncChannel?.close();
    this.firestoreTabSyncChannel = null;
    this.authTabSyncChannel?.close();
    this.authTabSyncChannel = null;
    this.sandbox.dispose();
  }

  /**
   * Re-deploy just the rules. Existing documents are untouched so the
   * user can iterate on a ruleset against the same working data. The
   * lint result determines `ok` — error-severity warnings or a parse
   * failure both block the swap.
   */
  deployRules(source: string): DeployResult {
    try {
      const lint = setRules(this.sandbox, source);
      const messages: DeployResult['messages'] = [];
      if (lint.parseError) {
        const { line, column, expected, actual } = lint.parseError;
        const got = actual ? JSON.stringify(actual.slice(0, 40)) : '<eof>';
        messages.push({
          severity: 'error',
          text: `PARSE ERROR: expected ${expected}, got ${got}`,
          line,
          column,
        });
      }
      const warnings: Array<{ severity: string; message: string }> = lint.warnings;
      for (const w of warnings) {
        const severity: 'info' | 'warn' | 'error' =
          w.severity === 'error' ? 'error' : w.severity === 'warning' ? 'warn' : 'info';
        messages.push({ severity, text: w.message });
      }
      const ok = lint.parseError == null && !warnings.some((w) => w.severity === 'error');
      return { ok, messages };
    } catch (e) {
      return { ok: false, messages: [{ severity: 'error', text: describeError(e) }] };
    }
  }

  /**
   * Read state via the admin/bypass-rules path. Filters to paths under
   * `opts.path` when provided.
   */
  readState(opts: { path?: string; maxDepth?: number } = {}): Record<string, unknown> {
    const snap = this.sandbox.snapshot().firestore;
    const out: Record<string, unknown> = {};
    const prefix = opts.path ?? '';
    for (const [path, data] of Object.entries(snap)) {
      if (prefix && !path.startsWith(prefix)) continue;
      if (opts.maxDepth !== undefined) {
        const depth = path.split('/').length;
        if (depth > opts.maxDepth) continue;
      }
      out[path] = data;
    }
    return out;
  }

  /**
   * Removed. The AsyncFunction interpreter was retired when the agent
   * loop moved to file tools + diagnostic primitives. The method
   * stays on the class so `SandboxHandle` consumers (the agent
   * framework's `ctx.sandbox`) still type-check; calling it is a hard
   * error so we surface the rewrite explicitly instead of silently
   * succeeding with empty results.
   */
  async run(_source: string): Promise<RunResult> {
    throw new Error(
      'sandbox.run() was removed. Use `write_file` + `simulate_firestore_write` / `seed_firestore_data_as_admin` instead.',
    );
  }
}

function describeError(e: unknown): string {
  if (e instanceof SandboxError) {
    const ctx = e.denialContext;
    if (!ctx) return `${e.code}: ${e.message}`;
    const lines: string[] = [`${e.code}: ${e.message}`];
    if (ctx.request) {
      lines.push(`  request.method: ${ctx.request.method}`);
      lines.push(`  request.path: ${ctx.request.path}`);
    }
    if (ctx.auth !== undefined) {
      lines.push(`  request.auth: ${JSON.stringify(ctx.auth)}`);
    }
    if (ctx.reasons && ctx.reasons.length > 0) {
      lines.push(`  reasons: ${JSON.stringify(ctx.reasons)}`);
    }
    return lines.join('\n');
  }
  if (e instanceof Error) {
    return `${e.name}: ${e.message}`;
  }
  return String(e);
}

/**
 * Storage-key convention for per-session workspace persistence. One
 * IndexedDB database per session (the backend is one-DB-per-key), so
 * sessions can never read each other's data and a single session's
 * blob can be cleared independently. Distinct from the sessions-
 * METADATA sandbox key (`pyric:playground:sessions`).
 */
const PERSISTENCE_KEY_PREFIX = 'pyric:sandbox:';

/**
 * Session id for the current page, from the same `?session={id}` query
 * param `useSessionRouting` reads. Read directly (rather than through
 * React state) because the runner constructs lazily from non-React
 * call sites (tools, hooks) and the param is synchronously available
 * from page load — the session bootstrap guarantees `/playground`
 * without a session id redirects to `/` before any sandbox use.
 *
 * `null` outside a browser (SSR, bun tests — including the headless
 * suite's partial `window` shim with no `location`) and on pages
 * without a session id: the runner stays ephemeral there.
 */
function workspaceSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  const search = window.location?.search;
  if (!search) return null;
  return new URLSearchParams(search).get('session');
}

/**
 * Module-level singleton. The playground hosts one sandbox at a time;
 * sharing across tool calls + the App preview is the natural fit.
 *
 * Session scoping: the singleton is constructed once per page load,
 * keyed to the session id in the URL at construction time. Session
 * SWITCHING is always a full navigation (`window.location` from the
 * home page / routing redirects), so a switch tears down this module
 * and the next page constructs a fresh runner against the new
 * session's key — there is no in-page key swap to get wrong, and no
 * cross-session bleed.
 */
let runner: SandboxRunner | null = null;

export function getRunner(): SandboxRunner {
  if (!runner) {
    const sessionId = workspaceSessionId();
    runner = new SandboxRunner(
      sessionId
        ? { persistence: { key: `${PERSISTENCE_KEY_PREFIX}${sessionId}` } }
        : {},
    );
  }
  return runner;
}

export function disposeRunner(): void {
  runner?.dispose();
  runner = null;
}
