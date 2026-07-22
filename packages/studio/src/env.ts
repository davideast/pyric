/**
 * Pyric Studio environment factory (Phase 0 contract C3).
 *
 * `StudioEnvironment` is the single object the Studio app talks to: it bundles
 * the storage ports (`./ports`) with a `PersistenceBackend` for sandbox durable
 * state. `createStudioEnvironment(mode)` is the one wiring seam: each `mode`
 * branch supplies concrete impls + the right transport.
 *
 *   - `local`   : `pyric dev --ui`: disk via the pyric devr (HTTP clients
 *                 over `/__pyric/workspace`, `/__pyric/projects`). SHIPS FIRST.
 *   - `browser` : today's playground re-expressed over the ports (IDB virtual FS,
 *                 session-as-project). FUTURE.
 *   - `hosted`  : a remote API behind the same ports. FUTURE.
 *
 * The interfaces are shaped from the UNION of disk + playground so `browser`
 * stays a valid future branch. Concrete impls land in Wave 1 (T3 storage);
 * this file is the signature only.
 */

import { createMemoryBackend } from 'pyric/sandbox';
import type {
  ConnectedBridge,
  ConnectedBridgeState,
} from '@pyric/cli/bridge/client';

import type {
  PersistenceBackend,
  ProjectStore,
  RemoteLifecycle,
} from './ports.js';
import { httpProjectStore, httpPersistence } from './clients/index.js';
import { createMemoryProjectStore } from './clients/memory-project-store.js';
import {
  connectWorkerLive,
  type WorkerLivePlane,
} from './clients/worker-live.js';
import { connectStudioBridgePeer } from './clients/bridge-peer.js';

/**
 * `STUDIO_STATIC` — the composed static-site build flag (`scripts/build-site.sh`).
 * Set at build time by the Astro host (`packages/site-docs/astro.config.mjs`);
 * absent for the normal `pyric dev --ui` build AND for the `dist/env.js`
 * library export consumed outside Vite (Node/Bun, where `import.meta.env`
 * itself doesn't exist — hence the `typeof` guard rather than a bare access).
 *
 * When true, `createStudioEnvironment('local')` never constructs
 * `httpProjectStore`/`httpPersistence` (no pyric devr exists to answer
 * `/__pyric/workspace|projects|state` under static hosting) — it wires the
 * in-memory, single-project store + backend instead. The SharedWorker's own
 * IDB-backed durable state (rules/docs/auth users) is unaffected either way;
 * this flag only concerns Studio's OWN ports.
 */
function isStudioStatic(): boolean {
  if (typeof import.meta.env === 'undefined') return false;
  // `as unknown as Record<...>`: a pure compile-time assertion (erased by
  // `tsc`, emits no runtime code), so the ACTUAL expression Astro's Vite `define`
  // matches (`import.meta.env.STUDIO_STATIC`) survives untouched in the
  // compiled output. The cast only sidesteps `bun-types`' `ImportMetaEnv`
  // (merged globally via this package's `tsconfig.json` "types"), which
  // models unknown keys as `string | undefined` (it shapes `import.meta.env`
  // on `process.env`) — conflicting with the boolean `define` bakes in here.
  return (import.meta.env as unknown as Record<string, unknown>).STUDIO_STATIC === true;
}

/** Where Studio's storage lives. Only `local` is wired in v1. */
export type StudioMode = 'local' | 'browser' | 'hosted';

/**
 * Everything the Studio app needs from its host, resolved per {@link StudioMode}.
 * `remote` is optional: modes implement the lifecycle ops they support.
 */
export interface StudioEnvironment {
  mode: StudioMode;
  projects: ProjectStore;
  /** Sandbox durable state (already polymorphic in pyric). */
  persistence: PersistenceBackend;
  remote?: RemoteLifecycle;
  /**
   * The LIVE data plane over the SharedWorker backend (Wave 2.5a). Present in
   * `local` mode when a `SharedWorker` is reachable; `undefined` otherwise (SSR /
   * unsupported browser / tests; features fall back to their empty/HTTP path).
   *
   * This connects Studio to the SAME `pyric-shared-worker` sandbox the served
   * app + the agent operate (NOT a durable-state mirror): the unified event feed
   * (F1), the auth lens (F2/F4: admin / view-as-user / re-run-as-user), and the
   * runtime confirm-policy setter (F3) all ride one worker port. Wave 2.5b wires
   * each feature to these seams; 2.5a wires F1 + exposes the rest.
   */
  live?: WorkerLivePlane;
  /**
   * Live connection state of Studio's own bridge-peer registration (the MCP
   * relay). Present whenever a live worker plane exists in `local` mode; the
   * shell's presence chip subscribes. Settles on `disconnected` when there is
   * no serve/bridge to register with (dev-seed / review, bridge off).
   */
  bridge?: BridgeStatusStore;
  /** Release page-lifetime worker, presence, and bridge resources. */
  dispose(): void;
}

/** Read-and-subscribe store over the bridge peer's connection state. */
export interface BridgeStatusStore {
  get(): ConnectedBridgeState;
  subscribe(cb: () => void): () => void;
}

function createBridgeStatusStore(): BridgeStatusStore & {
  set(state: ConnectedBridgeState): void;
} {
  let state: ConnectedBridgeState = { kind: 'connecting' };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next) {
      state = next;
      for (const cb of listeners) cb();
    },
  };
}

/** Per-mode wiring options. Firms up as the mode branches land. */
export interface StudioEnvironmentOptions {
  /** `local`: base URL of the pyric devr (defaults to current origin, `''`). */
  baseUrl?: string;
  /**
   * `local`: how sandbox durable state is stored.
   *   - `'http'` (default): the server's `--persist` `/__pyric/state` channel.
   *   - `'memory'`: in-process, non-durable (tests / `dev` without `--persist`).
   */
  persistence?: 'http' | 'memory';
  /**
   * `local`: URL of the served SharedWorker script. Defaults to
   * `/__pyric/sdk/worker.js` (the path `pyric dev` serves the worker at).
   */
  workerUrl?: string;
  /**
   * `local`: opt OUT of the live SharedWorker plane (the env still wires the
   * HTTP project/persistence path). Defaults to `false`. Use in tests / SSR to
   * keep the env worker-free even where a `SharedWorker` global is shimmed.
   */
  disableLive?: boolean;
}

/**
 * Wire a {@link StudioEnvironment} for the given mode.
 *
 * T3 implements the `local` branch (HTTP clients over the pyric devr's
 * `/__pyric/workspace` + `/__pyric/projects` disk-backed routes); the
 * `browser`/`hosted` branches land later (A3).
 */
export function createStudioEnvironment(
  mode: StudioMode,
  options: StudioEnvironmentOptions = {},
): StudioEnvironment {
  if (mode === 'local') {
    // Default to same-origin: `pyric dev --ui` serves Studio AND the routes
    // from one server, so an empty base resolves `/__pyric/*` against it.
    const baseUrl = options.baseUrl ?? '';
    const staticBuild = isStudioStatic();
    const persistence: PersistenceBackend =
      options.persistence === 'memory' || staticBuild
        ? createMemoryBackend()
        : httpPersistence(baseUrl);

    // Prefer the LIVE SharedWorker plane (Wave 2.5a): Studio reaches the SAME
    // backend the served app + agent use, so its event feed / lens / policy are
    // live, not a mirror. `connectWorkerLive` returns null when no SharedWorker
    // is present (SSR / unsupported browser / tests), so the HTTP project +
    // persistence path remains the fallback and the env never throws here.
    const live = options.disableLive
      ? null
      : connectWorkerLive(options.workerUrl);

    // Served Studio must ALSO register as the bridge's sandbox peer — the
    // relay the agent (MCP) and `connectRemoteSandbox` reach the SharedWorker
    // through. Otherwise a Studio-only session (exactly what `pyric dev --ui`
    // auto-opens) gets "no browser tab is connected". Fire-and-forget: the
    // factory stays synchronous, and the peer connect no-ops cleanly when no
    // serve is present (dev-seed / review) or the bridge is off. The status
    // store observes the connection so the shell's presence chip stays honest.
    const bridge = live ? createBridgeStatusStore() : null;
    let disposed = false;
    let bridgeConnection: ConnectedBridge | null = null;
    if (live && bridge) {
      void connectStudioBridgePeer(live.db, {
        baseUrl,
        onStateChange: (state) => bridge.set(state),
      }).then((connection) => {
        if (disposed) connection?.disconnect();
        else bridgeConnection = connection;
      });
    }

    return {
      mode,
      projects: staticBuild ? createMemoryProjectStore() : httpProjectStore(baseUrl),
      persistence,
      ...(live ? { live } : {}),
      ...(bridge ? { bridge } : {}),
      dispose() {
        disposed = true;
        bridgeConnection?.disconnect();
        void live?.dispose();
      },
    };
  }

  throw new Error(
    `createStudioEnvironment(${mode}): only 'local' is wired in v1 (T3). ` +
      `'browser'/'hosted' land in A3.`,
  );
}

// Re-export the port surface so consumers import everything from `@pyric/studio`.
export type {
  PersistenceBackend,
  ProjectHandle,
  ProjectMeta,
  ProjectStore,
  RemoteLifecycle,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceStore,
} from './ports.js';

// Re-export the live data-plane surface (Wave 2.5a) so features + tests import
// it from `@pyric/studio` rather than reaching into `./clients`.
export {
  connectWorkerLive,
  workerEventFeed,
  DEFAULT_WORKER_URL,
  type WorkerLivePlane,
  type LiveEventFeed,
  type StudioLens,
} from './clients/worker-live.js';

// Re-export the bridge-peer seam (served Studio registers as the bridge's
// sandbox peer) for the same reason.
export {
  connectStudioBridgePeer,
  studioBridgePeerOptions,
  type StudioBridgePeerOptions,
} from './clients/bridge-peer.js';
