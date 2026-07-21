/**
 * `pyric dev` — local dev server with the pyric sandbox standing in for
 * Firebase. Feels like `firebase serve` (banner, labeled lines, port 3473,
 * SIGINT shutdown) with the sandbox-flavored extras firebase can't do: the
 * served page runs an in-browser backend, your `firestore.rules` deploy into
 * it at page load, and unmodified `firebase/*` imports resolve to pyric via a
 * served import map.
 *
 * Orchestration: firebase.json (optional — warn + serve cwd without it) →
 * rules load (fail fast on broken rules) → SDK bundle (cached per pyric
 * version) → static server with the `/__pyric/` namespace + HTML injection.
 */
import { dirname, join, relative, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, readFirebaseRc, type FirebaseJson } from './firebase-json.js';
import { bundleSdk, bundleWorker, defaultSdkEntries, resolveDocsUiDir, resolveStudioUiDir } from '../serve/bundler.js';
import {
  isStandalone,
  materializeDocsUi,
  materializeServeAssets,
  materializeStudioUi,
  embeddedWorkerVersion,
} from '../serve/standalone-assets.js';
import { loadProjectDatabaseRules, loadProjectRules, loadProjectStorageRules, watchProjectRules } from '../serve/rules.js';
import { hasSandboxBuildMarker } from '../serve/sandbox-marker.js';
import {
  createEventHub,
  createPyricNamespace,
  injectServeTags,
  type InitPayload,
} from '../serve/namespace.js';
import { formatActivityWarning } from '../serve/activity-warning.js';
import { createStateStore, STATE_FILE_VERSION, type PyricStateFile } from '../serve/state-store.js';
import { diskProjectStore, diskWorkspace } from '../serve/studio/index.js';
import { createCaptureStore } from '../serve/capture-store.js';
import { consoleServeLogger, startStaticServer, stderrServeLogger, type ServeHandle } from '../serve/server.js';
import { createBridgeMount } from '../serve/bridge-mount.js';
import { openBrowser, shouldAutoOpen } from '../serve/open-browser.js';
import {
  buildChildEnv,
  createLinePrefixer,
  detectPackageManager,
  readDevScript,
  registerModuleUrl,
  resolveDevChild,
  spawnDevChild,
  waitForSandboxPeer,
  type DevChildHandle,
} from './dev-runner.js';
import {
  spawnFunctionsRtdbChild,
  type FunctionsRtdbChildHandle,
} from '../functions-rtdb/child.js';
import {
  discoverFunctionsRtdbProject,
  type FunctionsRtdbProject,
} from '../functions-rtdb/project.js';

interface HostingConfig {
  public?: string;
  rewrites?: Array<{ source?: string; destination?: string }>;
}

/** Extract the single hosting config `pyric dev` v1 supports. Arrays
 *  (multi-site) take the first entry with a warning — multi-site is out of
 *  scope (plan section 6). */
export function extractHosting(config: FirebaseJson | null): HostingConfig | null {
  const h = config?.hosting;
  if (!h || typeof h !== 'object') return null;
  if (Array.isArray(h)) return (h[0] as HostingConfig) ?? null;
  return h as HostingConfig;
}

/** firebase.json's SPA idiom: a `**` rewrite to /index.html. */
export function wantsSpaRewrite(hosting: HostingConfig | null): boolean {
  return (hosting?.rewrites ?? []).some(
    (r) => r.source === '**' && r.destination === '/index.html',
  );
}


export interface ServeRuntime {
  handle: ServeHandle;
  publicDir: string;
  payload: () => InitPayload;
  /** HTTP MCP endpoint when `--bridge` is on; null otherwise. */
  mcpUrl: string | null;
  /** The Studio app URL (`/__pyric/ui/`) when `--ui` is on and the build is
   *  present; null otherwise. */
  uiUrl: string | null;
  /** Persistence summary (null when `--persist` is off). */
  persist: { restoredDocs: number; restoredUsers: number } | null;
}

/** The `--json` stdout contract — one line, keep stable; agents parse this.
 *  Readiness probe: GET {url}/__pyric/init.json → 200 (body carries the live
 *  rules hash). */
export function serveJsonLine(runtime: ServeRuntime): string {
  return JSON.stringify({
    url: runtime.handle.url,
    port: runtime.handle.port,
    uiUrl: runtime.uiUrl,
    mcpUrl: runtime.mcpUrl,
    rulesHash: runtime.payload().rulesHash,
    databaseRulesHash: runtime.payload().databaseRulesHash ?? null,
    persist: runtime.persist !== null,
    restoredDocs: runtime.persist?.restoredDocs ?? 0,
    restoredUsers: runtime.persist?.restoredUsers ?? 0,
  });
}

/**
 * Programmatic entry — everything but flag parsing and process lifecycle.
 * Exported so integration tests drive a real server without a subprocess.
 */
export async function startServe(opts: {
  cwd: string;
  port?: number;
  host?: string;
  noCache?: boolean;
  /** Override the bundle cache root (tests). */
  cacheRoot?: string;
  /** Mount the MCP bridge on the serve origin (`--bridge`). */
  bridge?: boolean;
  /** Project label for the bridge health/audit surfaces. */
  project?: string;
  /** Disable the bridge audit writer (tests). */
  disableAuditLog?: boolean;
  /** Path to a seed JSON file (path → fields map), applied at page init. */
  seed?: string;
  /** Watch firestore.rules and hot-reload over SSE. Default true when a
   *  rules file exists. */
  watch?: boolean;
  /** Persist sandbox state to `.pyric/state/state.json` (flow doc section 3c).
   *  Ephemeral remains the default. */
  persist?: boolean;
  /** With `--persist`: discard any existing state file and re-seed from
   *  scratch (the escape hatch from "state wins after the first run"). */
  fresh?: boolean;
  /** Extra hostnames allowed past the DNS-rebinding guard. */
  allowedHosts?: string[];
  /** Write the session capture to `.pyric/last-session.json` so `pyric verify`
   *  can replay it. Default true; pass false (via `--no-capture`) to suppress.
   *  This is independent of `--persist` — capture records the live session
   *  fixture for the verify loop regardless of whether state is persisted. */
  capture?: boolean;
  /** Mount the Pyric Studio storage routes (`--ui`): `/__pyric/workspace`
   *  (the served project's file tree) + `/__pyric/projects` (single-project
   *  store over `cwd`). The Studio app's `local` mode talks to these. */
  ui?: boolean;
  logger?: Parameters<typeof startStaticServer>[0]['logger'];
}): Promise<ServeRuntime> {
  const logger = opts.logger ?? consoleServeLogger();

  // --fresh only means anything against the state.json file `--persist`
  // maintains — without `--persist` there is no file to discard, so
  // `--fresh` alone was a silent no-op (nothing happened, nothing said so).
  // Fail fast instead of pretending to reset something.
  if (opts.fresh && !opts.persist) {
    throw new Error(
      'pyric dev: --fresh requires --persist (it discards .pyric/state/state.json). ' +
        'Browser-stored data is cleared from Studio → Settings → Reset, or DevTools → Clear site data.',
    );
  }

  // firebase.json is optional for serving (firebase-serve parity: warn, then
  // serve the directory anyway).
  let config: FirebaseJson | null = null;
  try {
    config = await readFirebaseJson(opts.cwd);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('no firebase.json')) throw e;
    logger.note('  ⚠ no firebase.json found — serving the current directory without hosting config');
  }

  const hosting = extractHosting(config);
  if (Array.isArray(config?.hosting) && (config.hosting as unknown[]).length > 1) {
    logger.note('  ⚠ multiple hosting sites configured — pyric dev v1 serves the first entry only');
  }
  const publicDir = resolve(opts.cwd, hosting?.public ?? '.');
  if (!existsSync(publicDir)) {
    // A missing `dist/` almost always means "no build yet" — the web scaffold's
    // hosting.public is the Vite output. Point at the dev/build loop instead of
    // a bare path error (serve previews a build; `vite dev` is the dev server).
    const looksLikeBuildOutput = /(^|[\\/])(dist|build|out)$/.test(publicDir);
    const hint = looksLikeBuildOutput
      ? `\n  No build yet? Run \`bun run dev\` for the live sandbox dev server, ` +
        `or \`bun run build\` then \`pyric dev\` to preview the production build.`
      : '';
    throw new Error(`pyric dev: hosting.public directory does not exist: ${publicDir}${hint}`);
  }

  // The import map can only remap BARE `firebase/*` specifiers. A plain bundler
  // build (`vite build`) inlines the real SDK into the app chunk, leaving
  // nothing to intercept — the page would then talk to REAL Firebase endpoints
  // with the sandbox's fake credentials while the injected banner claims
  // otherwise. That hole is structural, so `pyric dev` REFUSES such a dist
  // rather than serving it. A pyric SANDBOX build (`vite build --mode
  // development`) carries the marker and bundles pyric's in-page adapters, so it
  // is trusted and the scan is skipped (marker present → no real SDK to find).
  if (!hasSandboxBuildMarker(publicDir)) {
    const inlined = scanForInlinedFirebase(publicDir);
    if (inlined.length > 0) {
      throw new Error(
        `pyric dev: ${inlined[0]} bundles the REAL firebase SDK, so this dist cannot be ` +
          `sandboxed — its firebase/* calls would reach LIVE Google endpoints, not the ` +
          `pyric sandbox. Two ways forward:\n` +
          `  (a) plain \`pyric dev\` runs the child dev-server flow (the @pyric/cli/vite ` +
          `plugin swaps firebase/* live) — use \`bun run dev\`;\n` +
          `  (b) rebuild as a self-contained sandbox bundle and serve THAT: ` +
          `\`vite build --mode development\` (or pyric({ swapInBuild: true })) then ` +
          `\`pyric dev\`.\n` +
          `A plain \`vite build\` is your production build — deploy it, don't sandbox it.`,
      );
    }
  }

  // Rules: fail fast on broken rules; serve rule-less only when genuinely absent.
  // Held in a mutable box — the watcher swaps it and the payload producer
  // always serves the live version.
  const loaded = await loadProjectRules(opts.cwd, config);
  const loadedDatabase = await loadProjectDatabaseRules(opts.cwd, config);
  // Storage rules deploy ONCE at boot — see the `storageRules` doc on
  // `InitPayload`: `pyric/storage` only honors rules on the FIRST storage
  // call per Sandbox, so unlike firestore/database rules there is no live
  // "live" box to swap here; a storage.rules edit needs a restart.
  const loadedStorage = await loadProjectStorageRules(opts.cwd, config);
  const live = {
    rules: loaded.rules,
    rulesHash: loaded.rulesHash,
    databaseRules: loadedDatabase.rules,
    databaseRulesHash: loadedDatabase.rulesHash,
    databaseUrl: loadedDatabase.databaseUrl,
  };

  // --capture (default on): the capture store writes .pyric/last-session.json
  // whenever the page pushes its session fixture via POST /__pyric/capture.
  // pyric verify (no-arg) reads that file. Independent of --persist — capture
  // records for the verify loop, persist is for cross-reload durability.
  const capture = (opts.capture ?? true) ? createCaptureStore(opts.cwd) : null;

  // --persist: the state store IS the durable sandbox (section 3c). Load eagerly so
  // a corrupt/mismatched file fails the start (inspect-or-delete message)
  // instead of silently serving ephemeral.
  const state = opts.persist ? createStateStore(opts.cwd) : null;
  // --fresh: the escape hatch from "state wins after the first run" — drop
  // the existing state (+ its backup) so this run re-seeds from scratch.
  if (state && opts.fresh) {
    for (const p of [state.path, state.backupPath]) if (existsSync(p)) rmSync(p);
    logger.note('  ⓘ --fresh: discarded the existing state file; re-seeding');
    // Half-reset warning: --fresh only deletes the SERVER file. The worker's
    // durable store is browser IndexedDB, and prime-once only fills an EMPTY
    // IDB (createWorkerDurableBackend) — a browser that already holds sandbox
    // data KEEPS it and its next flush repopulates the supposedly-fresh file.
    // The reset handshake (making --fresh actually clear the browser store) is
    // future work; until then, say so loudly rather than let the file quietly
    // refill.
    logger.note(
      '  ⚠ --fresh only resets the server-side state file — a browser tab that already has ' +
        'sandbox data in IndexedDB keeps it and will write it straight back on its next flush. ' +
        'For a full reset, also clear the browser store: Studio → Settings → Reset, or open an ' +
        'incognito/private window.',
    );
  }
  let persistedEnvelope = state?.load() ?? null;

  // --seed accepts BOTH shapes: a bare path→fields map, or a PyricStateFile
  // envelope (detected by its `version` key — what `pyric snapshot` emits).
  let seed: Record<string, Record<string, unknown>> | null = null;
  /** Ephemeral fixture restore: the controller blob from a state-file seed,
   *  restored in-page through the persistence deserializer (wrapper
   *  re-hydration) via a read-only backend. */
  let seedState: unknown | null = null;
  let seedUsers: Record<string, unknown>[] | null = null;
  let seedLabel = '';
  if (opts.seed) {
    const seedPath = resolve(opts.cwd, opts.seed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(seedPath, 'utf8'));
    } catch (e) {
      throw new Error(`pyric dev: failed to read --seed ${seedPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`pyric dev: --seed must be a JSON object of "collection/doc" → fields, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version === STATE_FILE_VERSION && ('firestore' in obj || 'auth' in obj)) {
      const fixture = obj as unknown as PyricStateFile;
      const docCount = Object.keys(
        ((fixture.firestore as { firestore?: Record<string, unknown> } | null)?.firestore) ?? {},
      ).length;
      const userCount = fixture.auth?.users?.length ?? 0;
      seedLabel = `${docCount} doc(s) + ${userCount} user(s) from state fixture`;
      if (state && !state.exists()) {
        // Persist first run seeded from a fixture: prime the store, then the
        // normal persist path restores it like any lived state.
        if (fixture.firestore != null) state.writeSection('firestore', fixture.firestore);
        if (fixture.auth != null) state.writeSection('auth', fixture.auth);
        persistedEnvelope = state.load();
      } else if (!state) {
        seedState = fixture.firestore ?? null;
        seedUsers = (fixture.auth?.users as Record<string, unknown>[] | undefined) ?? null;
      }
      // persist + existing state: the lived state wins; the fixture is inert.
    } else {
      seed = parsed as Record<string, Record<string, unknown>>;
      seedLabel = `${Object.keys(seed).length} document(s)`;
    }
  }

  // SDK bundles (cached per pyric version + entry hash). In a standalone
  // binary the runtime esbuild bundler is unavailable, so the deterministic
  // bundles were built at compile time and embedded; materialize them to a
  // temp dir instead (see serve/standalone-assets.ts). Everything downstream
  // (the /__pyric/sdk/* namespace, worker route) reads from `bundle.outDir`
  // and is identical either way.
  const t0 = performance.now();
  let bundle: { outDir: string; cached: boolean; dispose?: () => void };
  // The worker executable epoch: stamped into the page (`<meta name="pyric-worker-v">`)
  // so the page can WARN when a still-running worker is older than the served
  // bundle. The worker NAME is origin-generation scoped — all tabs share
  // one backend — so a SharedWorker (which can't hot-update) is detected as
  // stale, not auto-replaced; the user closes all tabs to load the new worker.
  let workerVersion: string;
  if (isStandalone()) {
    bundle = await materializeServeAssets();
    workerVersion = embeddedWorkerVersion();
  } else {
    bundle = await bundleSdk({ entries: defaultSdkEntries(), noCache: opts.noCache, cacheRoot: opts.cacheRoot });
    // The SharedWorker host (Phase 3c): bundled into the SAME sdk dir so the
    // existing /__pyric/sdk/worker.js route serves it. The page's entry
    // adapters feature-detect SharedWorker → this worker; unsupported browsers
    // fall back to the in-page sandbox. Built alongside the SDK so a warm
    // start skips both.
    try {
      const worker = await bundleWorker({ outDir: bundle.outDir, noCache: opts.noCache });
      workerVersion = worker.epoch;
    } catch (error) {
      bundle.dispose?.();
      throw error;
    }
  }
  const bundleMs = Math.round(performance.now() - t0);

  const mount = opts.bridge
    ? createBridgeMount({
        project: opts.project,
        disableAuditLog: opts.disableAuditLog,
        upgradeGuard: { boundHost: opts.host ?? 'localhost', allowedHosts: opts.allowedHosts },
      })
    : null;

  // bridgeUrl needs the BOUND port; resolved after listen via this box.
  const origin = { host: opts.host ?? 'localhost', port: 0 };
  const payload = (): InitPayload => ({
    rules: live.rules,
    rulesHash: live.rulesHash,
    databaseRules: live.databaseRules,
    databaseRulesHash: live.databaseRulesHash,
    databaseUrl: live.databaseUrl,
    storageRules: loadedStorage.rules,
    storageRulesHash: loadedStorage.rulesHash,
    // Project identity: scopes the storage IDB name per served project
    // (issue #359). Local-only — a dev path never leaves the machine.
    projectKey: opts.cwd,
    bridgeUrl: mount && origin.port > 0 ? mount.wsUrl(origin) : null,
    // Precedence: once a state file exists, the lived state is the truth —
    // --seed applies only on the first (state-less) run.
    seed: state?.exists() ? null : seed,
    seedState,
    persist: Boolean(state),
    capture: Boolean(capture),
    authUsers: state
      ? ((state.readSection('auth') as { users?: Record<string, unknown>[] } | null)?.users ?? null)
      : seedUsers,
    // Served firebase/messaging is part of the canonical swap, so the worker
    // broker must be available whenever the SDK entries are served.
    messaging: true,
  });

  const events = createEventHub();
  // --ui (Pyric Studio): serve the disk-backed workspace + project routes.
  // Single-project mode: the served `cwd` IS the one project's file tree; the
  // project store roots at `.pyric/projects` (multi-project ready) but the
  // current served tree is also reachable directly via /__pyric/workspace.
  const studio = opts.ui
    ? {
        workspace: diskWorkspace(opts.cwd),
        projects: diskProjectStore(join(opts.cwd, '.pyric', 'projects')),
      }
    : undefined;
  // --ui also serves the BUILT Studio app under /__pyric/ui/. The dir is
  // resolved by file path (never imported), so a missing build is a clear
  // warning rather than a crash; the data routes still mount.
  let studioUiDir: string | undefined;
  let docsUiDir: string | undefined;
  if (opts.ui) {
    // Standalone: the Studio app was embedded at compile time; materialize it.
    const dir = isStandalone() ? await materializeStudioUi() : resolveStudioUiDir();
    const docsDir = isStandalone() ? await materializeDocsUi() : resolveDocsUiDir();
    if (dir) {
      studioUiDir = dir;
    } else {
      logger.note(
        '  ⚠ --ui: built Studio app not found (run the full build first). ' +
          'The data routes are mounted, but /__pyric/ui/ will 404.',
      );
    }
    if (docsDir) {
      docsUiDir = docsDir;
    } else {
      logger.note(
        '  ⚠ --ui: built docs site not found (run the full build first). ' +
          'Studio is mounted, but /__pyric/ui/docs/ will 404.',
      );
    }
  }
  const sdkNamespace = createPyricNamespace({
    sdkDir: bundle.outDir,
    initPayload: payload,
    events,
    activity: (incident) => logger.note(formatActivityWarning(incident)),
    state: state ?? undefined,
    capture: capture ?? undefined,
    studio,
    studioUiDir,
    docsUiDir,
    logger,
  });
  let handle: Awaited<ReturnType<typeof startStaticServer>>;
  try {
    handle = await startStaticServer({
      publicDir,
      port: opts.port ?? 3473,
      host: opts.host ?? 'localhost',
      spaRewrite: wantsSpaRewrite(hosting),
      namespaceHandler: mount
        ? async (req, res, url) => (await mount.handler(req, res, url)) || sdkNamespace(req, res, url)
        : sdkNamespace,
      // Never force in-page: serve always serves the worker, and the bridge peer
      // routes agent tool-calls THROUGH the worker (see connectBridgePeer), so app
      // + Studio + agent share the one sandbox even under --bridge.
      transformHtml: (html) => injectServeTags(html, undefined, workerVersion),
      allowedHosts: opts.allowedHosts,
      logger,
    });
  } catch (error) {
    bundle.dispose?.();
    throw error;
  }
  if (bundle.dispose) handle.server.once('close', bundle.dispose);
  origin.port = handle.port;
  // Attach the WS upgrade to EVERY bound server so the sandbox peer connects on
  // whichever loopback family the page resolved (localhost binds both now).
  if (mount) for (const s of handle.servers) mount.attachUpgrade(s);
  const uiUrl = studioUiDir ? `${handle.url}/__pyric/ui/` : null;
  const docsUrl = docsUiDir ? `${handle.url}/__pyric/ui/docs/` : null;

  // Discovery pointer (the Claude Code plugin's stdio proxy reads this so it
  // never has to guess the dynamic port). Written next to the project state
  // when --bridge is on; removed on clean shutdown. plans/pyric-plugin.
  if (mount) {
    const pointer = join(opts.cwd, '.pyric', 'serve.json');
    try {
      mkdirSync(dirname(pointer), { recursive: true });
      writeFileSync(
        pointer,
        JSON.stringify(
          { url: handle.url, mcpUrl: mount.mcpUrl(origin), port: handle.port, pid: process.pid, instanceId: mount.instanceId, project: opts.project ?? 'sandbox' },
          null,
          2,
        ) + '\n',
      );
      handle.server.once('close', () => { try { rmSync(pointer); } catch { /* gone already */ } });
    } catch { /* best-effort: discovery falls back to a port scan */ }
  }

  // Hot-reload: watch the rules file, swap the live ruleset, broadcast.
  const watching = (opts.watch ?? true) && loaded.sourcePath !== null;
  if (watching) {
    const watcher = watchProjectRules(
      loaded.sourcePath!,
      (next) => {
        live.rules = next.rules;
        live.rulesHash = next.rulesHash;
        events.broadcast('rules-changed', next);
        logger.note(`  ↻ rules reloaded (hash ${next.rulesHash}) → ${events.clientCount()} page(s)`);
      },
      (message) => logger.note(`  ⚠ rules NOT reloaded (last-good stays live): ${message}`),
    );
    handle.server.once('close', () => watcher.close());
  }

  logger.info(`=== Serving from '${opts.cwd}'...`);
  logger.info('');
  logger.info(`✔ hosting  Serving files from: ${hosting?.public ?? '.'}`);
  logger.info(`✔ hosting  Local server: ${handle.url}`);
  logger.info(
    isStandalone()
      ? `✔ sandbox  pyric SDK bundles ready (embedded)`
      : bundle.cached
        ? `✔ sandbox  pyric SDK bundles ready (cache)`
        : `✔ sandbox  pyric SDK bundles built in ${bundleMs}ms`,
  );
  logger.info(
    loaded.rules
      ? `✔ rules    ${loaded.sourcePath} → deployed to the in-page sandbox (hash ${loaded.rulesHash})`
      : `• rules    no firestore.rules — sandbox runs with default rules`,
  );
  logger.info(
    loadedDatabase.rules
      ? `✔ rules    ${loadedDatabase.sourcePath} → deployed to the RTDB sandbox (hash ${loadedDatabase.rulesHash})`
      : `• rules    no database.rules — RTDB sandbox runs with default rules`,
  );
  logger.info(
    loadedStorage.rules
      ? `✔ rules    ${loadedStorage.sourcePath} → deployed to the storage sandbox (hash ${loadedStorage.rulesHash}; ` +
        `edits require a restart — storage rules do not hot-reload)`
      : `• rules    no storage.rules — storage sandbox runs open (no rules configured)`,
  );
  if (uiUrl) {
    logger.info(`✔ studio   Pyric Studio: ${uiUrl}`);
  }
  if (docsUrl) {
    logger.info(`✔ docs     Pyric docs: ${docsUrl}`);
  }
  if (mount) {
    logger.info(`✔ bridge   MCP endpoint: ${mount.mcpUrl(origin)} (sandbox peers over ws at /__pyric/sandbox)`);
  }
  let persistSummary: ServeRuntime['persist'] = null;
  if (state) {
    const fsDocs = persistedEnvelope?.firestore
      ? Object.keys((persistedEnvelope.firestore as { firestore?: Record<string, unknown> }).firestore ?? {}).length
      : 0;
    const users = (persistedEnvelope?.auth as { users?: unknown[] } | null)?.users?.length ?? 0;
    persistSummary = { restoredDocs: fsDocs, restoredUsers: users };
    logger.info(
      persistedEnvelope
        ? `✔ persist  ${state.path} (${fsDocs} doc(s), ${users} user(s) restored; --seed skipped)`
        : `✔ persist  new state file at ${state.path} (first run — seed applies)`,
    );
    if (existsSync(state.backupPath)) {
      logger.note(
        `  ⓘ a recovery backup exists at ${state.backupPath} (prior non-empty state was ` +
          'replaced by an empty one — e.g. a reset). Restore: mv it back over state.json.',
      );
    }
  } else {
    // Say the durability tier out loud: refresh behavior must never be a coin
    // flip. Coverage detail (which services, worker vs in-page) lives in the
    // persistence guide — this line names the tier and the upgrade path.
    logger.note(
      '  ⓘ persist  data lives in this browser (IndexedDB) — see docs/how-to/serve-persistence-and-multi-tab.md' +
        '\n             for what survives refresh/restart; `--persist` adds a committable .pyric/state/state.json',
    );
  }
  // (A fixture that primed the persist store is reported by the persist
  // line; a fixture ignored because lived state exists is intentionally
  // silent about staging.)
  if ((seed && !state?.exists()) || seedState || seedUsers) {
    logger.info(`✔ seed     ${seedLabel} staged for page init`);
  }
  if (capture) {
    logger.info(`✔ capture  session → ${capture.path} (run \`pyric verify\` to replay it)`);
  }
  if (watching) logger.info(`✔ watch    hot-reloading ${loaded.sourcePath} over /__pyric/events`);
  // Browser-honesty: the sandbox is browser-resident — firestore/auth and
  // persistence run IN the served page. With no page open, data ops silently
  // no-op. This warning (paired with auto-open in runServe) is the fix for the
  // "I ran serve and nothing happened" surprise. Always printed.
  logger.note('');
  logger.note('  ⚠ the pyric sandbox runs IN the served page — keep the browser tab open.');
  logger.note('    Firestore/auth data and persistence stop when no page is open.');
  return { handle, publicDir, payload, uiUrl, mcpUrl: mount ? mount.mcpUrl(origin) : null, persist: persistSummary };
}

/**
 * `--ui` implies `--bridge` (hybrid-MCP plan Phase 3): a Studio user almost
 * always wants MCP too, and the two independent flags were a real setup footgun.
 * Pure + exported for unit coverage.
 */
export function bridgeEnabledFromFlags(flags: { get(key: string): unknown }): boolean {
  return Boolean(flags.get('bridge')) || Boolean(flags.get('ui'));
}

/**
 * A dev child also implies the bridge: the runner injects
 * `PYRIC_SANDBOX=remote:<url>` into the child, whose remote client dials the
 * `/__pyric/sandbox` WS — without the bridge mount that upgrade 404s and
 * plain `pyric dev -- <cmd>` (or a detected dev script) breaks its own
 * child. Pure + exported for unit coverage.
 */
export function bridgeEnabledFor(
  flags: { get(key: string): unknown },
  childPlan: unknown,
  functionsProject: unknown = null,
): boolean {
  return bridgeEnabledFromFlags(flags) || childPlan != null || functionsProject != null;
}

/**
 * Process-level last line of defense for the dev server: a single bad
 * request/WS interaction must never take `pyric dev` down. Node kills the
 * process on an unhandled rejection (default `--unhandled-rejections=throw`
 * since v15) and on any uncaught exception — and the serve process hosts
 * long-lived, browser-driven machinery (WS peers, SSE streams, file watchers,
 * MCP transports) where one missed error path is fatal. Route both to a LOUD
 * stderr log instead and keep serving.
 *
 * Installed by `runServe` once the server is up (startup errors still fail
 * fast). Returns the uninstaller. Exported for unit coverage.
 */
export function installServeProcessGuard(
  log: (message: string) => void,
  proc: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
  const describe = (reason: unknown): string =>
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  const onRejection = (reason: unknown): void => {
    log(
      `  ✖ pyric dev: UNHANDLED REJECTION (the server was kept alive — please report this):\n` +
        `    ${describe(reason).split('\n').join('\n    ')}`,
    );
  };
  const onException = (err: unknown): void => {
    log(
      `  ✖ pyric dev: UNCAUGHT EXCEPTION (the server was kept alive — please report this):\n` +
        `    ${describe(err).split('\n').join('\n    ')}`,
    );
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}

/** CLI entry. Resolves on SIGINT/SIGTERM after a clean stop. */
export async function runServe(parsed: ParsedArgs): Promise<number> {
  const flagPort = parsed.flags.get('port');
  const port = typeof flagPort === 'string' ? Number(flagPort) : 3473;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    process.stderr.write(`pyric: invalid --port '${flagPort}'.\n`);
    return 1;
  }
  const flagHost = parsed.flags.get('host');
  const host = typeof flagHost === 'string' ? flagHost : 'localhost';

  const only = parsed.flags.get('only');
  if (typeof only === 'string' && only !== 'hosting') {
    process.stderr.write(
      `pyric: --only '${only}' is not supported — pyric dev v1 serves hosting (with the in-page sandbox standing in for firestore/auth).\n`,
    );
    return 1;
  }

  const json = Boolean(parsed.flags.get('json'));

  const uiOn = Boolean(parsed.flags.get('ui'));

  // Resolve the child plan BEFORE the server starts: a planned child implies
  // the bridge (see bridgeEnabledFor) — the child's injected PYRIC_SANDBOX
  // is useless without the /__pyric/sandbox WS mount.
  const cwd = process.cwd();
  let functionsProject: FunctionsRtdbProject | null;
  let functionsProjectId: string | null = null;
  try {
    functionsProject = discoverFunctionsRtdbProject(cwd);
    if (functionsProject) {
      const flagProject = parsed.flags.get('project');
      const rc = await readFirebaseRc(cwd);
      functionsProjectId =
        (typeof flagProject === 'string' ? flagProject : undefined) ??
        process.env.PYRIC_PROJECT ??
        rc?.projects?.default ??
        'demo-project';
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const plan = resolveDevChild({
    passthrough: parsed.passthrough ?? [],
    noRun: Boolean(parsed.flags.get('no-run')),
    json,
    devScript: readDevScript(cwd),
    packageManager: detectPackageManager(cwd),
  });
  const bridgeOn = bridgeEnabledFor(parsed.flags, plan, functionsProject);

  let runtime: ServeRuntime;
  try {
    runtime = await startServe({
      cwd: process.cwd(),
      port,
      host,
      logger: json ? stderrServeLogger() : undefined,
      noCache: Boolean(parsed.flags.get('no-cache')),
      bridge: bridgeOn,
      seed: typeof parsed.flags.get('seed') === 'string' ? (parsed.flags.get('seed') as string) : undefined,
      watch: parsed.flags.get('no-watch') ? false : undefined,
      persist: Boolean(parsed.flags.get('persist')),
      fresh: Boolean(parsed.flags.get('fresh')),
      // --ui mounts the Pyric Studio storage routes (workspace + projects).
      ui: uiOn,
      // --no-capture disables the default-on session capture. The pattern
      // mirrors --no-open: default is true, one flag inverts it.
      capture: parsed.flags.get('no-capture') ? false : true,
      allowedHosts:
        typeof parsed.flags.get('allowed-host') === 'string'
          ? (parsed.flags.get('allowed-host') as string).split(',').map((h) => h.trim()).filter(Boolean)
          : undefined,
      project:
        typeof parsed.flags.get('project') === 'string'
          ? (parsed.flags.get('project') as string)
          : process.env.PYRIC_PROJECT ?? functionsProjectId ?? undefined,
    });
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  // The server is up: from here on, no single bad request/WS/watcher error
  // may kill the process — log loudly and keep serving (startup errors above
  // still fail fast).
  installServeProcessGuard((m) => process.stderr.write(m + '\n'));

  // The agent contract: with --json, stdout carries exactly this one line
  // (the banner went to stderr). Readiness probe: GET /__pyric/init.json.
  if (json) process.stdout.write(serveJsonLine(runtime) + '\n');

  // Footgun guard (hybrid-MCP plan Phase 3): plain `dev` mounts no MCP bridge,
  // so a `pyric mcp-proxy` in an editor cannot attach. Nudge toward --bridge.
  if (!bridgeOn && !json) {
    process.stderr.write(
      '  tip  MCP? re-run with --bridge so an editor (Cursor / Claude / Antigravity) can attach via `pyric mcp-proxy`.\n',
    );
  }

  // Auto-open the served page (best-effort) so the browser-resident sandbox is
  // actually running. Suppressed in non-interactive paths (--json, --no-open,
  // no TTY, CI) — see shouldAutoOpen. A failed open never fails serve.
  const opened = shouldAutoOpen({
    json,
    noOpen: Boolean(parsed.flags.get('no-open')),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (opened) {
    // With --ui, open Studio directly; the served page is still available.
    void openBrowser(runtime.uiUrl ?? runtime.handle.url);
  }

  let devChild: DevChildHandle | null = null;
  let functionsChild: FunctionsRtdbChildHandle | null = null;
  let resolveSignal!: (signal: NodeJS.Signals) => void;
  const signal = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const onSigint = (): void => resolveSignal('SIGINT');
  const onSigterm = (): void => resolveSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const removeSignalHandlers = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
  const waitOrSignal = async <T>(pending: Promise<T>): Promise<{ value: T } | { signal: NodeJS.Signals }> =>
    Promise.race([
      pending.then((value) => ({ value })),
      signal.then((received) => ({ signal: received })),
    ]);
  const stopAfterSignal = async (): Promise<number> => {
    (json ? process.stderr : process.stdout).write('\nShutting down...\n');
    if (devChild && devChild.child.exitCode === null) devChild.signal(await signal);
    await functionsChild?.stop().catch(() => undefined);
    await runtime.handle.stop().catch(() => undefined);
    removeSignalHandlers();
    return 0;
  };

  if (functionsProject && functionsProjectId) {
    const info = json ? process.stderr : process.stdout;
    info.write('• functions waiting for the browser tab to connect the sandbox…\n');
    const connectedOutcome = await waitOrSignal(waitForSandboxPeer(runtime.handle.url));
    if ('signal' in connectedOutcome) return stopAfterSignal();
    const connected = connectedOutcome.value;
    if (!connected) {
      process.stderr.write(
        `  ⚠ functions not started — no browser tab connected after 30s. ` +
          `Open ${runtime.handle.url} and restart pyric dev.\n`,
      );
    } else {
      functionsChild = spawnFunctionsRtdbChild({
        cwd: functionsProject.sourceDir,
        entry: functionsProject.entry,
        env: buildChildEnv(process.env, {
          serveUrl: runtime.handle.url,
          registerUrl: registerModuleUrl(),
        }),
        instance: `${functionsProjectId}-default-rtdb`,
        location: process.env.PYRIC_FUNCTIONS_RTDB_REGION ?? 'us-central1',
        onEvent(event) {
          if (event.type === 'execution') {
            const params = Object.entries(event.params)
              .map(([name, value]) => `${name}=${value}`)
              .join(', ');
            const paramsSuffix = params ? ` (${params})` : '';
            if (event.status === 'fulfilled') {
              info.write(`✔ function  ${event.exportName} ← /${event.ref}${paramsSuffix}\n`);
            } else {
              process.stderr.write(
                `✖ function  ${event.exportName} ← /${event.ref}${paramsSuffix}: ${event.error.message}\n`,
              );
            }
          } else {
            process.stderr.write(
              `✖ functions delivery for ${event.exportName}: ${event.error.message}\n`,
            );
          }
        },
      });

      const stdout = createLinePrefixer('[functions] ', (line) =>
        (json ? process.stderr : process.stdout).write(line));
      const stderr = createLinePrefixer('[functions] ', (line) => process.stderr.write(line));
      functionsChild.child.stdout?.setEncoding('utf8');
      functionsChild.child.stderr?.setEncoding('utf8');
      functionsChild.child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      functionsChild.child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
      functionsChild.child.stdout?.once('end', () => stdout.flush());
      functionsChild.child.stderr?.once('end', () => stderr.flush());

      try {
        const readyOutcome = await waitOrSignal(functionsChild.ready);
        if ('signal' in readyOutcome) return stopAfterSignal();
        const ready = readyOutcome.value;
        info.write(
          `✔ functions ${ready.triggerCount} onValueCreated trigger${ready.triggerCount === 1 ? '' : 's'} ` +
            `from ${relative(cwd, functionsProject.entry)}\n`,
        );
        for (const unsupported of ready.unsupportedTriggers) {
          process.stderr.write(
            `  ⚠ functions export ${unsupported.exportName} uses unsupported trigger ` +
              `${unsupported.eventType}; it will not run in pyric dev.\n`,
          );
        }
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        await functionsChild.stop();
        await runtime.handle.stop();
        removeSignalHandlers();
        return 2;
      }
    }
  }

  // The child runner ("one command, not two"): run the user's own dev
  // command with the sandbox environment injected. Precedence: `-- <cmd>`
  // wins; else the package.json dev script; else host-only. --no-run forces
  // host-only; --json defaults to host-only (explicit `--` still wins).
  // (`plan` was resolved above so it could imply the bridge mount.)
  if (plan) {
    const info = json ? process.stderr : process.stdout;
    // First-run race guard: we just opened the tab ourselves, so wait
    // (bounded) for it to register as the sandbox peer before the child's
    // first op can lose the race and die on the no-tab fail-fast. Skipped
    // when nothing was opened (CI/--no-open/--json): no tab is coming, and
    // stalling would only delay the honest failure.
    if (opened) {
      info.write('• run      waiting for the browser tab to connect the sandbox…\n');
      const connectedOutcome = await waitOrSignal(waitForSandboxPeer(runtime.handle.url));
      if ('signal' in connectedOutcome) return stopAfterSignal();
      const connected = connectedOutcome.value;
      if (!connected) {
        info.write(
          `  ⚠ no browser tab connected after 30s — starting your command anyway; sandbox ops will fail until ${runtime.handle.url} is open.\n`,
        );
      }
    }
    info.write(
      `✔ run      \`${plan.label}\` — firebase-admin/firebase imports are routed to the sandbox at ${runtime.handle.url}\n`,
    );
    devChild = spawnDevChild(plan, {
      cwd,
      json,
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
    });
  }

  return await new Promise<number>((resolveExit) => {
    let settled = false;
    let shuttingDown = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      void (async () => {
        await functionsChild?.stop().catch(() => undefined);
        if (devChild && devChild.child.exitCode === null) {
          devChild.signal('SIGTERM');
          await devChild.exited.catch(() => undefined);
        }
        await runtime.handle.stop().catch(() => undefined);
        removeSignalHandlers();
        resolveExit(code);
      })();
    };
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      (json ? process.stderr : process.stdout).write('\nShutting down...\n');
      void functionsChild?.stop();
      if (devChild && devChild.child.exitCode === null) {
        // Forward the signal; the child's exit (below) closes the host.
        // (The terminal delivers Ctrl-C to the whole group too — the
        // forward makes non-TTY / programmatic signals behave the same.)
        devChild.signal(signal);
      } else {
        finish(0);
      }
    };
    // Child exits → close the host and propagate its code (Ctrl-C → 0).
    if (devChild) void devChild.exited.then((code) => finish(code));
    if (functionsChild) {
      void functionsChild.exited.then((code) => {
        if (!settled && !shuttingDown) {
          process.stderr.write(`pyric dev: Functions child exited unexpectedly (code ${code}).\n`);
          finish(code === 0 ? 1 : code);
        }
      });
    }
    void signal.then(shutdown);
  });
}

/**
 * Detect a bundler build that INLINED the real firebase SDK into its served
 * assets (`vite build` output). The served import map remaps only bare
 * `firebase/*` specifiers, so such a build cannot be sandboxed — its calls
 * reach real Google endpoints. Fingerprints are real-SDK-only endpoint hosts
 * that never appear in a sandbox-clean app (whose calls all route to
 * `/__pyric/*`). Bounded: depth ≤ 4, ≤ 200 script files, first hit per file.
 * Returns publicDir-relative paths of offending assets.
 */
export function scanForInlinedFirebase(dir: string): string[] {
  const FINGERPRINTS = [
    'identitytoolkit.googleapis.com',
    'firestore.googleapis.com',
    'securetoken.googleapis.com',
    'firebasedatabase.app',
  ];
  const hits: string[] = [];
  let scanned = 0;
  const walk = (d: string, rel: string, depth: number): void => {
    if (depth > 4 || scanned >= 200) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (scanned >= 200) return;
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // The pyric namespace itself never lands in hosting.public, but a
        // node_modules inside a served dir would be a scan-cost trap.
        if (name === 'node_modules') continue;
        walk(p, r, depth + 1);
      } else if (/\.(js|mjs)$/.test(name)) {
        scanned++;
        try {
          const text = readFileSync(p, 'utf8');
          if (FINGERPRINTS.some((f) => text.includes(f))) hits.push(r);
        } catch {
          // unreadable asset: skip
        }
      }
    }
  };
  walk(dir, '', 0);
  return hits;
}
