/**
 * `pyric-tools/vite` — the firebase→pyric-sandbox swap as a Vite plugin.
 *
 * The serve analog for SOURCE-driven apps: instead of `vite build && pyric serve
 * dist`, a team keeps `vite dev` (HMR, source maps) with the in-process sandbox
 * standing in for Firebase. The app's `firebase/*` imports are UNCHANGED — the
 * plugin swaps them at the module-resolution layer (`resolveId`), the same way
 * `pyric serve` swaps via a runtime import map. (Design: `plans/pyric-vite-plugin.md`.)
 *
 * Dev-only (`apply: 'serve'`): a production `vite build` ships the real `firebase`
 * package — the swap is a development affordance and never reaches prod output.
 *
 * This is a thin adapter over serve's proven machinery. It REUSES, not reimplements:
 *   - the firebase peer stubs — `collectFirebaseBindings` + `stubModuleSource`
 *     (named-export inert proxies; a bare default proxy fails the build);
 *   - the node-builtin shims — `NODE_BUILTIN_SHIMS`;
 *   - the swap targets — `defaultSdkEntries()` (the `serve/entries/*` wrappers,
 *     compiled-dist preferred, src fallback);
 *   - the `/__pyric/*` namespace — `createPyricNamespace` mounted verbatim behind
 *     a connect-middleware adapter;
 *   - rules load + prepare — `loadProjectRules` / `prepareRulesSource`;
 *   - the SharedWorker host — `bundleWorker` served at `/__pyric/sdk/worker.js`;
 *   - durable stores — `createStateStore` (persist) / `createCaptureStore`.
 *
 * Scope = M1 (swap + rules) + M2 (SharedWorker multi-tab + persist/capture/seed)
 * + M3 (the MCP bridge fold — `{ bridge }`). M3 reuses `createBridgeMount` (the
 * proven serve-flavored bridge behind `pyric serve --bridge`), composing it into
 * the same `/__pyric` middleware; bridge mode forces the in-page sandbox path so
 * the agent and the app share one backend.
 *
 * Serving `worker.js` flips `runtime.ts` to the worker path (one backend across
 * tabs, IndexedDB-durable); on that path the WORKER owns persist/capture/seed via
 * the same `/__pyric/*` routes. If the worker bundle fails, the plugin falls back
 * to the in-page sandbox (single-tab, ephemeral).
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { Plugin, UserConfig } from 'vite';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import {
  SDK_MODULES,
  collectFirebaseBindings,
  stubModuleSource,
  defaultSdkEntries,
  resolvePlaygroundUiDir,
  resolveStudioUiDir,
  pyricPackageRoot,
  bundleWorker,
  workerSourceHash,
  NODE_BUILTIN_RE,
  NODE_BUILTIN_SHIMS,
} from './bundler.js';
import { createEventHub, createPyricNamespace, type InitPayload } from './namespace.js';
import { diskWorkspace, diskProjectStore } from './studio/index.js';
import { createBridgeMount } from './bridge-mount.js';
import { loadProjectDatabaseRules, loadProjectRules, prepareRulesSource, rulesHashOf } from './rules.js';
import { createStateStore, STATE_FILE_VERSION, type PyricStateFile } from './state-store.js';
import { createCaptureStore } from './capture-store.js';
import { isAllowedHost } from './server.js';
import { readFirebaseJson, type FirebaseJson } from '../cli/firebase-json.js';

/** Any `firebase/<sub>` specifier. */
const FB_ANY = /^firebase\/([a-z-]+)$/;
/** The only subpaths with a swap entry (mirror of `SDK_MODULES`). */
const SERVED = new Set(['app', 'auth', 'firestore', 'database']);
const STUB_PREFIX = '\0pyric:fb-stub:';
const NODE_SHIM_PREFIX = '\0pyric:node-shim:';

/** Walk up from a file to the nearest directory containing a package.json. */
function packageRootOf(file: string): string {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir) && !existsSync(path.join(dir, 'package.json'))) {
    dir = path.dirname(dir);
  }
  return dir;
}

/** Memoize the (synchronous, O(pyric/dist)) firebase-binding scan across plugin
 *  constructions + Vite config reloads, keyed by the resolved pyric root. */
const bindingsCache = new Map<string, Map<string, Set<string>>>();
function bindingsFor(pyricRoot: string): Map<string, Set<string>> {
  let b = bindingsCache.get(pyricRoot);
  if (!b) {
    const distDir = path.join(pyricRoot, 'dist');
    if (!existsSync(distDir)) {
      throw new Error(
        `pyric-tools/vite: pyric is not built — run \`bun run build\` first ` +
          `(expected pyric dist at ${distDir}).`,
      );
    }
    b = collectFirebaseBindings(distDir);
    bindingsCache.set(pyricRoot, b);
  }
  return b;
}

export interface PyricSandboxOptions {
  /** firestore.rules path (relative to `root`). Default: `firebase.json`'s
   *  `firestore.rules`, else `firestore.rules` in the project root. */
  rules?: string;
  /** Project dir for `firebase.json` / rules discovery. Default: Vite's `root`. */
  root?: string;
  /** Persist sandbox state to `.pyric/state/state.json` so data + test users
   *  survive reloads/restarts. Off by default (ephemeral). */
  persist?: boolean;
  /** With `persist`: discard any existing state file and re-seed from scratch. */
  fresh?: boolean;
  /** Write the live session fixture to `.pyric/last-session.json` (for
   *  `pyric verify`). Default `true`; pass `false` to suppress. */
  capture?: boolean;
  /** Seed file: a `"collection/doc" → fields` JSON map, or a `pyric snapshot`
   *  state-file envelope. Applied at page init (state wins once it exists). */
  seed?: string;
  /** Mount the MCP **bridge** on Vite's dev origin so an external agent
   *  (Claude Code, Cursor) can drive this sandbox over MCP — `POST /__pyric/mcp`
   *  + `GET /__pyric/health` + `WS /__pyric/sandbox`, all on Vite's port.
   *  `true` is shorthand for `{}`. The agent and the page share ONE sandbox.
   *
   *  ⚠ **Forces the in-page sandbox (single-tab).** The bridge peer is the
   *  in-page sandbox, never the SharedWorker, so enabling `bridge` disables the
   *  default multi-tab SharedWorker path — otherwise the agent would drive an
   *  empty in-page sandbox while the app's data lived in the worker. */
  bridge?: boolean | { project?: string; disableAuditLog?: boolean };
  /** Serve the **Pyric Studio** app at `/__pyric/ui/` on Vite's dev origin (the
   *  `pyric serve --ui` equivalent). Mounts the disk-backed workspace/project
   *  routes Studio's `local` mode talks to AND serves the built Studio assets
   *  (vendored in this package at `dist/serve/studio-ui`). **On by default**;
   *  pass `ui: false` to disable.
   *
   *  Not compatible with `bridge`: bridge forces the app in-page, but Studio's
   *  live plane reads the SharedWorker, so Studio would observe nothing. Under
   *  `bridge` ui therefore defaults OFF (an explicit `ui: true` still works but
   *  warns). Use `ui` without `bridge`, or `pyric serve --ui`. */
  ui?: boolean;
}

/**
 * The dev-only Vite plugin. Add to `vite.config`:
 *
 *   import { pyricSandbox } from 'pyric-tools/vite';
 *   export default defineConfig({ plugins: [pyricSandbox()] });
 */
export function pyricSandbox(options: PyricSandboxOptions = {}): Plugin {
  // Resolved once: the swap entries + the firebase binding set the inert stub
  // must export. `defaultSdkEntries()` prefers compiled dist `.js`, falls back
  // to src `.ts`; `collectFirebaseBindings` scans pyric's compiled dist.
  const entries = defaultSdkEntries(); // { app, auth, firestore, init } → abs paths
  const pyricRoot = pyricPackageRoot();
  const bindings = bindingsFor(pyricRoot); // memoized; throws an actionable error if pyric isn't built
  // The pyric-TOOLS package root — covers the served entries AND their siblings
  // (`worker/client.js`, the bridge client) that the entries statically import.
  const pyricToolsRoot = packageRootOf(entries.init);

  // section 8 refinement: a firebase import is "pyric-internal" iff its importer lives
  // under the resolved pyric package root — keyed on the root, not a `/pyric/`
  // substring (which a user project path could false-positive).
  const isPyricImporter = (importer: string | undefined): boolean => {
    if (!importer) return false;
    const f = importer.split('?')[0];
    return f === pyricRoot || f.startsWith(pyricRoot + path.sep);
  };
  // Node builtins are reached only from OUR code (pyric internals + the served
  // entries) — shim those, but NEVER hijack a user app or third-party library's
  // own `fs`/`path`/`url` (which Vite, or the user's polyfill plugin, should
  // resolve). The firebase branch stays scoped to pyric; this is the wider "ours".
  const isOurCode = (importer: string | undefined): boolean => {
    if (!importer) return false;
    if (isPyricImporter(importer)) return true;
    const f = importer.split('?')[0];
    return f === pyricToolsRoot || f.startsWith(pyricToolsRoot + path.sep);
  };
  const stubFor = (spec: string): string => stubModuleSource(spec, bindings.get(spec) ?? new Set());
  const shimFor = (spec: string): string => NODE_BUILTIN_SHIMS[spec.replace(/^node:/, '')]!;

  // The esbuild mirror for Vite's dep optimizer — REQUIRED so a node_modules
  // library's `firebase/*` swaps too (the optimizer's esbuild pass bypasses the
  // Rollup-pipeline resolveId below and would otherwise pre-bake real firebase).
  const esbuildMirror: EsbuildPlugin = {
    name: 'pyric-sandbox-optimizer',
    setup(build) {
      build.onResolve({ filter: FB_ANY }, (args) => {
        const sub = FB_ANY.exec(args.path)![1]!;
        if (isPyricImporter(args.importer)) return { path: args.path, namespace: 'pyric-fb-stub' };
        if (SERVED.has(sub)) return { path: entries[sub]! };
        return null; // non-served firebase from a lib → real firebase
      });
      build.onLoad({ filter: /.*/, namespace: 'pyric-fb-stub' }, (args) => ({
        contents: stubFor(args.path),
        loader: 'js',
      }));
      build.onResolve({ filter: NODE_BUILTIN_RE }, (args) => {
        if (!isOurCode(args.importer)) return null; // user/lib node builtins → Vite/their polyfill
        return { path: args.path.replace(/^node:/, ''), namespace: 'pyric-node-shim' };
      });
      build.onLoad({ filter: /.*/, namespace: 'pyric-node-shim' }, (args) => ({
        contents: NODE_BUILTIN_SHIMS[args.path]!,
        loader: 'js',
      }));
    },
  };

  // Live rules box — the watcher swaps it; the init payload always serves the
  // current version.
  const live: {
    rules: string | null;
    rulesHash: string | null;
    databaseRules: { rules: Record<string, unknown> } | null;
    databaseRulesHash: string | null;
    databaseUrl: string | null;
  } = {
    rules: null,
    rulesHash: null,
    databaseRules: null,
    databaseRulesHash: null,
    databaseUrl: null,
  };

  // M2: the SharedWorker bundle's content hash (sync) — stamped into the page so
  // a still-running OLD worker is detected as stale. `workerReady` flips true once
  // `bundleWorker` succeeds in configureServer; until then (or on bundle failure)
  // the page is forced onto the in-page sandbox path. transformIndexHtml reads it.
  const workerVersion = workerSourceHash();
  let workerReady = false;

  // M3 bridge fold: normalize `bridge` once (true ⇒ `{}`, falsy ⇒ null). When
  // on, the MCP mount is composed into the /__pyric middleware (createBridgeMount,
  // shared with `pyric serve --bridge`) AND the page is forced onto the in-page
  // sandbox path — the bridge peer is the in-page sandbox, never the SharedWorker,
  // so multi-tab is disabled under bridge to keep agent + app on one backend.
  const bridgeOpts = options.bridge === true ? {} : options.bridge || null;

  return {
    name: 'pyric:sandbox',
    // Dev-only — prod `vite build` ships real firebase; the swap never reaches
    // production output.
    apply: 'serve',
    enforce: 'pre',

    config() {
      // Cast: the `esbuild` package's `Plugin` type skews slightly from Vite's
      // bundled esbuild types (benign — the Plugin shape is stable across the
      // versions in range).
      return {
        optimizeDeps: {
          // Keep firebase out of the optimizer's pre-bake; the resolver swaps it
          // per-importer at request time.
          exclude: [...SDK_MODULES],
          esbuildOptions: { plugins: [esbuildMirror] },
        },
      } as unknown as UserConfig;
    },

    configResolved(resolved) {
      // AUGMENT (don't replace) the fs allow-list: pyric dist + the pyric-tools
      // tree live outside the app root, but setting `server.fs.allow` in config()
      // would clobber Vite's auto-added root/workspace entries and 403 the app's
      // own source. Push the two PACKAGE ROOTS — pyric-tools' root (not just the
      // entries dir) is needed because the served init entry statically imports
      // siblings (`worker/client.js`, the bridge client) outside entries/.
      const allow = resolved.server?.fs?.allow;
      if (allow) {
        for (const dir of [pyricRoot, pyricToolsRoot]) {
          if (!allow.includes(dir)) allow.push(dir);
        }
      }
    },

    resolveId(source, importer) {
      const fb = FB_ANY.exec(source);
      if (fb) {
        const sub = fb[1]!;
        if (isPyricImporter(importer)) return STUB_PREFIX + source; // stub ANY firebase/* from pyric
        if (SERVED.has(sub)) return entries[sub]!; // swap served set for user/lib
        return null; // non-served firebase from user → real firebase
      }
      const node = NODE_BUILTIN_RE.exec(source);
      // Shim node builtins ONLY when reached from our own code — never hijack a
      // user app or library's own fs/path/url (Vite/their polyfill handles those).
      if (node && isOurCode(importer)) return NODE_SHIM_PREFIX + node[2]!;
      return null;
    },

    load(id) {
      if (id.startsWith(STUB_PREFIX)) return stubFor(id.slice(STUB_PREFIX.length));
      if (id.startsWith(NODE_SHIM_PREFIX)) return shimFor(id.slice(NODE_SHIM_PREFIX.length));
      return null;
    },

    async configureServer(server) {
      const cwd = options.root ?? server.config.root;

      // Reproduce serve's rules prelude: firebase.json (optional) → loadProjectRules.
      let fbJson: FirebaseJson | null = null;
      try {
        fbJson = await readFirebaseJson(cwd);
      } catch {
        /* optional — serve without a firebase.json */
      }
      // Honor an explicit `rules` option by overriding the resolved config.
      const config: FirebaseJson | null = options.rules
        ? { ...(fbJson ?? {}), firestore: { ...(fbJson?.firestore ?? {}), rules: options.rules } }
        : fbJson;
      const loaded = await loadProjectRules(cwd, config);
      const loadedDatabase = await loadProjectDatabaseRules(cwd, config);
      live.rules = loaded.rules;
      live.rulesHash = loaded.rulesHash;
      live.databaseRules = loadedDatabase.rules;
      live.databaseRulesHash = loadedDatabase.rulesHash;
      live.databaseUrl = loadedDatabase.databaseUrl;

      // ── M2 durable stores (mirrors serve's startServe orchestration) ──────
      // Capture (default-on): the worker/page pushes its session fixture to
      // /__pyric/capture; the store writes .pyric/last-session.json for `pyric verify`.
      const capture = (options.capture ?? true) ? createCaptureStore(cwd) : undefined;
      // Persist: createStateStore IS the durable sandbox. Load eagerly so a
      // corrupt/mismatched file fails the start (not silently ephemeral).
      const state = options.persist ? createStateStore(cwd) : undefined;
      if (state && options.fresh) {
        for (const p of [state.path, state.backupPath]) if (existsSync(p)) rmSync(p);
        server.config.logger.info('  ⓘ [pyric] fresh: discarded the existing state file; re-seeding');
      }
      // Eager load (mirrors serve.ts:158) — parse the file NOW so a corrupt or
      // version-mismatched state file throws StateFileError and FAILS THE START
      // with the actionable inspect-or-delete message. Without this the first
      // parse is deferred into initPayload() at request time, where it throws
      // synchronously AFTER namespace.ts has committed `writeHead(200)`: the
      // client gets a 200 with an empty body, the page/worker swallow the JSON
      // error, and the sandbox silently runs WITHOUT the persisted data + rules.
      // (No-op on first run: load() returns null for a missing file.)
      // configureServer is async, so an uncaught throw aborts the dev start.
      if (state) state.load();

      // Seed: a "collection/doc" → fields map, OR a `pyric snapshot` state-file
      // envelope (detected by its `version` key). Ported from serve.ts.
      let seed: Record<string, Record<string, unknown>> | null = null;
      let seedState: unknown | null = null;
      let seedUsers: Record<string, unknown>[] | null = null;
      if (options.seed) {
        const seedPath = path.resolve(cwd, options.seed);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(seedPath, 'utf8'));
        } catch (e) {
          throw new Error(`pyric-tools/vite: failed to read seed ${seedPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('pyric-tools/vite: seed must be a JSON object of "collection/doc" → fields');
        }
        const obj = parsed as Record<string, unknown>;
        if (obj.version === STATE_FILE_VERSION && ('firestore' in obj || 'auth' in obj)) {
          const fixture = obj as unknown as PyricStateFile;
          if (state && !state.exists()) {
            // persist first run from a fixture: prime the store, then the normal
            // persist path restores it like any lived state.
            if (fixture.firestore != null) state.writeSection('firestore', fixture.firestore);
            if (fixture.auth != null) state.writeSection('auth', fixture.auth);
          } else if (!state) {
            seedState = fixture.firestore ?? null;
            seedUsers = (fixture.auth?.users as Record<string, unknown>[] | undefined) ?? null;
          }
          // persist + existing state: lived state wins; the fixture is inert.
        } else {
          seed = parsed as Record<string, Record<string, unknown>>;
        }
      }

      // ── M2 SharedWorker host: bundle it (cached per version) and serve it at
      // /__pyric/sdk/worker.js. This is what flips runtime.ts to the worker path.
      // On bundle failure, fall back to the in-page sandbox (workerReady stays
      // false → transformIndexHtml forces in-page).
      const sdkDir = path.join(homedir(), '.pyric', 'vite-worker', workerVersion);
      try {
        await bundleWorker({ outDir: sdkDir });
        workerReady = true;
      } catch (e) {
        server.config.logger.warn(
          `  ⚠ [pyric] SharedWorker bundle failed — using the in-page sandbox (single-tab, ephemeral): ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // ── M3 MCP bridge (mirrors serve.ts:221–274) ─────────────────────────
      // The mount is long-lived (one bridge per dev session); its MCP transport
      // is rebuilt per request (stateless). Composed into the /__pyric middleware
      // below (handler tier) + the server's WS upgrade. middlewareMode has no
      // httpServer → HTTP routes still work, no WS peer.
      // Guard the WS upgrade with the SAME allow rule Vite's own host check
      // uses (host + allowedHosts, where `true` = opted into all hosts). Vite's
      // upgrade path bypasses connect middleware, so this is the only guard on it.
      const mount = bridgeOpts
        ? createBridgeMount({
            ...bridgeOpts,
            upgradeGuard: {
              boundHost: typeof server.config.server.host === 'string' ? server.config.server.host : 'localhost',
              allowedHosts:
                server.config.server.allowedHosts === true
                  ? true
                  : Array.isArray(server.config.server.allowedHosts)
                    ? server.config.server.allowedHosts
                    : [],
            },
          })
        : null;

      // The /__pyric/* namespace, reused VERBATIM (now with the sdk dir + state +
      // capture routes live).
      const events = createEventHub();
      const initPayload = (): InitPayload => ({
        rules: live.rules,
        rulesHash: live.rulesHash,
        databaseRules: live.databaseRules,
        databaseRulesHash: live.databaseRulesHash,
        databaseUrl: live.databaseUrl,
        // The bound port is known only after `listen`; initPayload runs per
        // request (after listen), so resolve it lazily here. Absolute ws://host:port
        // mirrors serve (the browser reads this as the bridge peer URL).
        bridgeUrl: (() => {
          if (!mount) return null;
          const addr = server.httpServer?.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          const host = (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
          return port > 0 ? mount.wsUrl({ host, port }) : null;
        })(),
        // Precedence: once a state file exists, lived state is the truth — seed
        // applies only on the first (state-less) run.
        seed: state?.exists() ? null : seed,
        seedState,
        persist: Boolean(state),
        capture: Boolean(capture),
        authUsers: state
          ? ((state.readSection('auth') as { users?: Record<string, unknown>[] } | null)?.users ?? null)
          : seedUsers,
      });
      // Pyric Studio: mount the disk-backed workspace/project routes that
      // Studio's `local` mode talks to + serve the built Studio app at
      // /__pyric/ui/. Mirrors `pyric serve --ui`; the studio-ui assets are
      // vendored in this package's dist (resolveStudioUiDir).
      //
      // ON BY DEFAULT, including under `bridge`: the bridge now routes agent
      // tool-calls THROUGH the SharedWorker (see `connectBridgePeer`), so the
      // app, Studio, and agent all observe the ONE sandbox. Explicit `ui: false`
      // still wins.
      const uiEnabled = options.ui ?? true;
      const studio = uiEnabled
        ? {
            workspace: diskWorkspace(cwd),
            projects: diskProjectStore(path.join(cwd, '.pyric', 'projects')),
          }
        : undefined;
      let studioUiDir: string | undefined;
      let playgroundUiDir: string | undefined;
      if (uiEnabled) {
        studioUiDir = resolveStudioUiDir() ?? undefined;
        playgroundUiDir = resolvePlaygroundUiDir() ?? undefined;
        if (!studioUiDir) {
          server.config.logger.warn(
            '[pyric] ui: built Studio app not found; /__pyric/ui/ will 404 ' +
              '(run the full build, or reinstall pyric-tools).',
          );
        }
        if (!playgroundUiDir) {
          server.config.logger.warn(
            '[pyric] ui: built Playground app not found; /__pyric/playground/ will 404 ' +
              '(run the full build, or reinstall pyric-tools).',
          );
        }
      }
      const namespace = createPyricNamespace({
        sdkDir,
        initPayload,
        events,
        state,
        capture,
        studio,
        studioUiDir,
        playgroundUiDir,
      });

      // DNS-rebinding guard for the /__pyric/* surface. Vite has its own host
      // check, but a `configureServer` hook that doesn't return a function mounts
      // BEFORE it (and the ordering differs across Vite 5/6/7), so guard here too
      // — independent of Vite's internals. Reuses serve's `isAllowedHost`.
      const srvOpts = server.config.server;
      const hostAllowed = (req: IncomingMessage): boolean => {
        if (srvOpts.allowedHosts === true) return true; // user opted into all hosts
        const boundHost = typeof srvOpts.host === 'string' ? srvOpts.host : 'localhost';
        const extra = Array.isArray(srvOpts.allowedHosts) ? srvOpts.allowedHosts : [];
        return isAllowedHost(req.headers.host, boundHost, extra);
      };

      // Connect-middleware adapter (build `url` from originalUrl; next() when the
      // namespace closure returns false; never rewrite route bodies).
      server.middlewares.use('/__pyric', (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
        if (!hostAllowed(req)) {
          res.statusCode = 403;
          res.end(`pyric: refused request for Host '${req.headers.host ?? ''}' (DNS-rebinding guard).`);
          return;
        }
        const url = new URL(req.originalUrl ?? req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        // Bridge first (mirrors serve.ts): /__pyric/mcp + /__pyric/health must be
        // handled by the mount, not 404 through the namespace. Falls through to the
        // namespace when the mount returns false (every non-bridge route).
        Promise.resolve(mount ? mount.handler(req, res, url) : false)
          .then((bridged) => (bridged ? true : Promise.resolve(namespace(req, res, url))))
          .then((handled) => {
            if (!handled) next();
          })
          .catch((err: unknown) => {
            if (!res.headersSent) res.statusCode = 500;
            res.end(err instanceof Error ? err.message : String(err));
          });
      });

      // WS upgrade for the in-page sandbox peer (ws://…/__pyric/sandbox). The
      // listener only fires once upgrades arrive (after listen), so adding it in
      // configureServer is safe. middlewareMode has no httpServer → HTTP bridge
      // routes still work, just no WS peer.
      // Cast: Vite types `httpServer` as http.Server | http2.Http2SecureServer;
      // attachUpgrade only needs `.on('upgrade')`, present on both. (serve passes
      // a plain http.Server, so this widening is plugin-specific.)
      if (mount && server.httpServer) mount.attachUpgrade(server.httpServer as unknown as HttpServer);

      // A2 discovery pointer: the stdio `mcp-proxy` (the sanctioned Claude Code
      // entrypoint) reads `.pyric/serve.json` to find the bridge without a fixed
      // URL -- it takes the PORT and probes BOTH loopback families, defeating the
      // IPv6/IPv4 trap that broke the hand-written `.mcp.json`. serve writes this
      // pointer; the Vite plugin must too. Written after listen (port known),
      // removed on close.
      if (mount && server.httpServer) {
        const httpServer = server.httpServer;
        const pointer = path.join(cwd, '.pyric', 'serve.json');
        const host =
          (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
        const writePointer = (): void => {
          const addr = httpServer.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          if (!port) return;
          try {
            mkdirSync(path.dirname(pointer), { recursive: true });
            writeFileSync(
              pointer,
              JSON.stringify(
                {
                  url: `http://${host}:${port}`,
                  mcpUrl: mount.mcpUrl({ host, port }),
                  port,
                  pid: process.pid,
                  instanceId: mount.instanceId,
                  project: bridgeOpts?.project ?? 'sandbox',
                },
                null,
                2,
              ) + '\n',
            );
          } catch {
            /* best-effort: the proxy falls back to a port scan */
          }
        };
        // Cross-family collision guard: once listening, probe BOTH loopback
        // families on our port. If a DIFFERENT sandbox answers on the other
        // family, two dev servers are colliding (IPv4 `*:P` + IPv6 `[::1]:P`)
        // and the agent/browser can split across them (writes seem to vanish).
        // #697's dual-bind can't apply here — Vite owns the single listen — so
        // we can only warn, loudly. (Our own family answers with our instanceId
        // and is skipped; a dual-stack bind owns both and never trips this.)
        const warnOnCollision = async (): Promise<void> => {
          const a = httpServer.address();
          const p = a && typeof a === 'object' ? a.port : 0;
          if (!p) return;
          for (const probe of [`http://127.0.0.1:${p}`, `http://[::1]:${p}`]) {
            try {
              const res = await fetch(`${probe}/__pyric/health`, { signal: AbortSignal.timeout(1000) });
              if (res.status !== 200) continue;
              const body = (await res.json()) as { mode?: string; instanceId?: string };
              if (body.mode === 'sandbox' && body.instanceId && body.instanceId !== mount.instanceId) {
                server.config.logger.warn(
                  `\n⚠  pyric: another sandbox already serves port ${p} on a different loopback ` +
                    `family (${probe}). Two dev servers are colliding across IPv4/IPv6 — your MCP ` +
                    `agent and browser can land on DIFFERENT sandboxes (writes seem to vanish). ` +
                    `Stop the other server, or give this app a unique \`server.port\` so the two ` +
                    `don't share one (pinning server.host to a family the squatter holds would ` +
                    `just EADDRINUSE).\n`,
                  { timestamp: true },
                );
                return; // one warning is enough
              }
            } catch {
              /* other family silent — no collision */
            }
          }
        };
        const announce = (): void => {
          writePointer();
          void warnOnCollision();
        };
        if ((httpServer as unknown as { listening?: boolean }).listening) announce();
        else httpServer.once('listening', announce);
        httpServer.once('close', () => {
          try {
            rmSync(pointer);
          } catch {
            /* gone already */
          }
        });
      }

      // Rules hot-reload from Vite's OWN watcher (no second fs watcher). Reuse
      // prepareRulesSource (resolve + lint); last-good stays live on a broken save.
      // Debounced (editors emit several change events per save) — matches
      // watchProjectRules' 150ms cadence, which we can't reuse here (it opens its
      // own fs watcher).
      if (loaded.sourcePath) {
        const rulesFile = loaded.sourcePath;
        let debounce: ReturnType<typeof setTimeout> | null = null;
        server.watcher.add(rulesFile);
        server.watcher.on('change', (file) => {
          if (path.resolve(file) !== path.resolve(rulesFile)) return;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
          void readFile(rulesFile, 'utf8').then(
            (raw) => {
              try {
                const rules = prepareRulesSource(raw, rulesFile);
                live.rules = rules;
                live.rulesHash = rulesHashOf(rules);
                events.broadcast('rules-changed', { rules, rulesHash: live.rulesHash });
                server.config.logger.info(`  ↻ [pyric] rules reloaded (${live.rulesHash})`);
              } catch (e) {
                server.config.logger.warn(
                  `  ⚠ [pyric] rules NOT reloaded (last-good stays live): ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            },
            () => {},
          );
          }, 150);
        });
      }
    },

    transformIndexHtml(html) {
      const MARKER = 'data-pyric-sandbox';
      if (html.includes(MARKER)) return html;
      // Worker path (default): stamp the served worker's content hash so the page
      // can WARN when a still-running OLD worker is stale (a SharedWorker can't
      // hot-update). In-page path: force it via the explicit flag before the init
      // module evaluates — a classic inline script runs before the deferred module.
      // The flag (not nulling `window.SharedWorker`) leaves the user's own
      // SharedWorker usage intact. We force in-page ONLY when the worker bundle
      // failed (workerReady false) — the ephemeral fallback. `bridge` no longer
      // forces in-page: the bridge peer routes agent tool-calls THROUGH the
      // worker (see `connectBridgePeer`), so the agent shares the one sandbox the
      // app + Studio use.
      const head = workerReady
        ? `<meta name="pyric-worker-v" content="${workerVersion}" ${MARKER}>`
        : `<script ${MARKER}>globalThis.__PYRIC_FORCE_INPAGE__=true;</script>`;
      // Boot the sandbox by loading the real init entry as a module (Vite
      // serves + transforms it). The init module's top-level await deploys rules
      // before app code runs. Mirrors serve's injectServeTags.
      const tag = head + `<script type="module" src="/@fs/${entries.init}" ${MARKER}></script>`;
      return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
    },
  };
}
