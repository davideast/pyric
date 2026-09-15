/**
 * `pyric sandbox` is the local server with the Pyric sandbox standing in for
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
import { randomBytes } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { existsSync, watch as watchFile } from 'node:fs';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, readFirebaseRc, type FirebaseJson } from './firebase-json.js';
import { bundleSdk, bundleWorker, defaultSdkEntries, resolveSiteUiDir } from '../serve/bundler.js';
import {
  isStandalone,
  materializeServeAssets,
  materializeSiteUi,
  embeddedWorkerVersion,
} from '../serve/standalone-assets.js';
import { hasSandboxBuildMarker } from '../serve/sandbox-marker.js';
import { formatBeaconReceipt } from '../serve/beacon-route.js';
import type { InitPayload } from '../serve/namespace.js';
import { formatAiStatusLine } from '../serve/ai-status.js';
import { injectServeTags } from '../serve/html-injection.js';
import { formatActivityWarning } from '../serve/activity-warning.js';
import { consoleServeLogger, startStaticServer, stderrServeLogger, type ServeHandle } from '../serve/server.js';
import { createBridgeMount } from '../serve/bridge-mount.js';
import { openBrowser, shouldAutoOpen } from '../serve/open-browser.js';
import { readPyricConfig, type PyricConfig } from './pyric-config.js';
import {
  buildChildEnv,
  formatStartupEnvExport,
  registerModuleUrl,
  resolveSandboxChild,
  spawnSandboxChild,
  waitForSandboxPeer,
  type SandboxChildHandle,
} from './sandbox-runner.js';
import {
  reportLaunchChecks,
  startBeaconWatchdog,
  type BeaconWatchdog,
} from './sandbox-interlock.js';
import { scanForInlinedFirebase } from './inlined-sdk-scanner.js';
import {
  createFunctionsDevelopmentRuntime,
  createHttpFunctionsPeerReadiness,
  type FunctionsDevelopmentEvent,
  type FunctionsDevelopmentRuntime,
} from '../functions-rtdb/development-runtime.js';
import {
  discoverFunctionsRtdbProject,
  type FunctionsRtdbProject,
} from '../functions-rtdb/project.js';
import {
  createSandboxSession,
  SandboxSeedError,
  type SandboxSession,
} from '../serve/sandbox-session.js';
import { resolveAvatarsConfig } from '../serve/avatars-config.js';

interface HostingConfig {
  public?: string;
  rewrites?: Array<{ source?: string; destination?: string }>;
}

/** Extract the single hosting config `pyric sandbox` supports. Arrays
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
  /** The Studio hub URL (`/__pyric/ui/studio`) when `--ui` is on and the build is
   *  present; null otherwise. */
  uiUrl: string | null;
  /** Persistence summary (null when `--persist` is off). */
  persist: { restoredDocs: number; restoredUsers: number } | null;
  /** Handshake beacons posted to `/__pyric/beacon` so far, the interlock
   *  watchdog's only input. */
  beaconCount: () => number;
  /** The per-launch secret a beacon must present, placed in every child's
   *  `PYRIC_BEACON_TOKEN`. */
  beaconToken: string;
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

function serveErrorMessage(error: unknown): string {
  const isError = error instanceof Error;
  if (isError) return error.message;
  return String(error);
}

/**
 * Programmatic entry — everything but flag parsing and process lifecycle.
 * Exported so integration tests drive a real server without a subprocess.
 */
export async function startServe(opts: Parameters<typeof startServeRuntime>[0]): Promise<ServeRuntime> {
  const usesHostedSandbox = opts.hosted === true;
  const usesBrowserPersistence = opts.persist === true;
  const ownsPersistedState = usesHostedSandbox || usesBrowserPersistence;
  if (ownsPersistedState) {
    const { claimProjectState } = await import('../serve/hosted/project-ownership.js');
    const owner = await claimProjectState(opts.cwd);
    try {
      return await startServeRuntime(opts, owner.close);
    } catch (error) {
      owner.close();
      throw error;
    }
  }
  return startServeRuntime(opts);
}

async function startServeRuntime(opts: {
  cwd: string;
  port?: number;
  host?: string;
  noCache?: boolean;
  /** Override the bundle cache root (tests). */
  cacheRoot?: string;
  /** Mount the MCP bridge on the serve origin (`--bridge`). */
  bridge?: boolean;
  /** Run the authoritative sandbox in this Node process. */
  hosted?: boolean;
  /** Execute supported Firestore operations through the application's real SDK. */
  live?: boolean;
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
  /** Explicit opt-in to permissive mode (default-allow RTDB rules when unconfigured). */
  permissive?: boolean;
  logger?: Parameters<typeof startStaticServer>[0]['logger'];
}, releaseOwnership?: () => void): Promise<ServeRuntime> {
  const logger = opts.logger ?? consoleServeLogger();

  // Handshake beacons from pyric-launched children, plus the per-launch secret
  // that authorizes one. Both live here because the route does.
  let beaconsSeen = 0;
  const beaconCount = (): number => beaconsSeen;
  const beaconToken = randomBytes(24).toString('base64url');

  // --fresh only means anything against the state.json file `--persist`
  // maintains — without `--persist` there is no file to discard, so
  // `--fresh` alone was a silent no-op (nothing happened, nothing said so).
  // Fail fast instead of pretending to reset something.
  const freshWithoutPersistence = Boolean(opts.fresh && !opts.persist);
  if (freshWithoutPersistence) {
    throw new Error(
      'pyric sandbox: --fresh requires --persist (it discards .pyric/state/state.json). ' +
        'Browser-stored data is cleared from Studio → Settings → Reset, or DevTools → Clear site data.',
    );
  }

  // firebase.json is optional for serving (firebase-serve parity: warn, then
  // serve the directory anyway).
  let config: FirebaseJson | null = null;
  try {
    config = await readFirebaseJson(opts.cwd);
  } catch (e) {
    const isMissingConfig = e instanceof Error && e.message.includes('no firebase.json');
    const shouldFailStartup = !isMissingConfig;
    if (shouldFailStartup) throw e;
    logger.note('  ⚠ no firebase.json found — serving the current directory without hosting config');
  }

  const pyricConfig = await readPyricConfig(opts.cwd);
  const ruleOverrides = pyricConfig.rules;
  const hasRuleOverrides = ruleOverrides !== undefined && ruleOverrides !== '';
  if (hasRuleOverrides) {
    config ??= {};
    const isFirestorePath = typeof ruleOverrides === 'string';
    if (isFirestorePath) {
      config.firestore = { ...config.firestore, rules: ruleOverrides };
    } else {
      const hasFirestoreOverride = Boolean(ruleOverrides.firestore);
      if (hasFirestoreOverride) {
        config.firestore = { ...config.firestore, rules: ruleOverrides.firestore };
      }
      const hasDatabaseOverride = Boolean(ruleOverrides.database);
      if (hasDatabaseOverride) {
        config.database = { ...config.database, rules: ruleOverrides.database };
      }
      const hasStorageOverride = Boolean(ruleOverrides.storage);
      if (hasStorageOverride) {
        const storageConfig = config.storage;
        const isSingleStorageConfig = typeof storageConfig === 'object' && !Array.isArray(storageConfig);
        const baseStorage = isSingleStorageConfig ? storageConfig : {};
        config.storage = { ...baseStorage, rules: ruleOverrides.storage };
      }
    }
  }

  const hosting = extractHosting(config);
  const hostingConfig = config?.hosting;
  const hasMultipleHostingSites = Array.isArray(hostingConfig) && hostingConfig.length > 1;
  if (hasMultipleHostingSites) {
    logger.note('  ⚠ multiple hosting sites configured. pyric sandbox serves the first entry only');
  }
  const publicDir = resolve(opts.cwd, hosting?.public ?? '.');
  const isPublicDirectoryMissing = !existsSync(publicDir);
  if (isPublicDirectoryMissing) {
    // A missing `dist/` almost always means "no build yet" — the web scaffold's
    // hosting.public is the Vite output. Point at the dev/build loop instead of
    // a bare path error (serve previews a build; `vite dev` is the dev server).
    const looksLikeBuildOutput = /(^|[\\/])(dist|build|out)$/.test(publicDir);
    const hint = looksLikeBuildOutput
      ? `\n  No build yet? Run \`bun run dev\` for the live sandbox dev server, ` +
        `or \`bun run build\` then \`pyric sandbox\` to preview the production build.`
      : '';
    throw new Error(`pyric sandbox: hosting.public directory does not exist: ${publicDir}${hint}`);
  }

  // The import map can only remap BARE `firebase/*` specifiers. A plain bundler
  // build (`vite build`) inlines the real SDK into the app chunk, leaving
  // nothing to intercept: the page would then talk to REAL Firebase endpoints
  // with the sandbox's fake credentials while the injected banner claims
  // otherwise. That hole is structural, so `pyric sandbox` refuses such a dist
  // rather than serving it. A pyric SANDBOX build (`vite build --mode
  // development`) carries the marker and bundles pyric's in-page adapters, so it
  // is trusted and the scan is skipped (marker present, no real SDK to find).
  const needsSdkScan = !hasSandboxBuildMarker(publicDir);
  if (needsSdkScan) {
    const inlined = scanForInlinedFirebase(publicDir);
    const hasInlinedSdk = inlined.length > 0;
    if (hasInlinedSdk) {
      throw new Error(
        `pyric sandbox: ${inlined[0]} bundles the real Firebase SDK, so this dist cannot be ` +
          `sandboxed — its firebase/* calls would reach LIVE Google endpoints, not the ` +
          `pyric sandbox. Two ways forward:\n` +
          `  (a) \`pyric sandbox -- <command>\` runs the child server with the @pyric/cli/vite ` +
          `plugin swaps firebase/* live) — use \`bun run dev\`;\n` +
          `  (b) rebuild as a self-contained sandbox bundle and serve THAT: ` +
          `\`vite build --mode development\` (or pyric({ swapInBuild: true })) then ` +
          `\`pyric sandbox\`.\n` +
          `A plain \`vite build\` is your production build — deploy it, don't sandbox it.`,
      );
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
  const usesEmbeddedAssets = isStandalone();
  if (usesEmbeddedAssets) {
    bundle = await materializeServeAssets();
    workerVersion = embeddedWorkerVersion();
  } else {
    const usesLiveSdk = opts.live === true;
    const liveProjectRoot = usesLiveSdk ? opts.cwd : undefined;
    bundle = await bundleSdk({
      entries: defaultSdkEntries({ live: usesLiveSdk }),
      liveProjectRoot,
      noCache: opts.noCache,
      cacheRoot: opts.cacheRoot,
    });
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

  const needsBridge = Boolean(opts.bridge || opts.hosted);
  let bridgeMount: ReturnType<typeof createBridgeMount> | null = null;
  if (needsBridge) {
    bridgeMount = createBridgeMount({
        hosted: opts.hosted,
        project: opts.project,
        projectKey: opts.cwd,
        disableAuditLog: opts.disableAuditLog,
        upgradeGuard: { boundHost: opts.host ?? 'localhost', allowedHosts: opts.allowedHosts },
    });
  }
  const mount = bridgeMount;
  const hasBridge = mount !== null;

  // bridgeUrl needs the BOUND port; resolved after listen via this box.
  const origin = { host: opts.host ?? 'localhost', port: 0 };
  // --ui also serves the unified Astro site under /__pyric/ui/. The dir is
  // resolved by file path (never imported), so a missing build is a clear
  // warning rather than a crash; the data routes still mount.
  let siteUiDir: string | undefined;
  const mountsStudio = Boolean(opts.ui);
  if (mountsStudio) {
    let dir: string | null;
    if (usesEmbeddedAssets) {
      dir = await materializeSiteUi();
    } else {
      dir = resolveSiteUiDir();
    }
    const availableDir = dir;
    const hasSiteBuild = availableDir !== null && availableDir.length > 0;
    if (hasSiteBuild) {
      siteUiDir = availableDir;
    } else {
      logger.note(
        '  ⚠ --ui: built Astro site not found (run the full build first). ' +
          'The data routes are mounted, but /__pyric/ui/ will 404.',
      );
    }
  }
  const usesPersistence = Boolean(opts.persist);
  const persistenceOptions = usesPersistence ? { fresh: opts.fresh } : undefined;
  const studioOptions: Parameters<typeof createSandboxSession>[0]['studio'] = mountsStudio ? { siteUiDir } : false;
  const usesHostedSandbox = opts.hosted === true;
  let session: SandboxSession;
  try {
    session = await createSandboxSession({
      projectDir: opts.cwd,
      firebaseConfig: config,
      sdk: { dir: bundle.outDir, workerVersion },
      seedFile: opts.seed,
      persistence: persistenceOptions,
      capture: opts.capture,
      studio: studioOptions,
      // No CLI flag (design decision): `pyric sandbox` resolves avatars from
      // `PYRIC_AVATARS` only, same precedence as the Vite plugin minus the
      // explicit-option tier.
      avatars: resolveAvatarsConfig(undefined, process.env, opts.cwd),
      bridgeUrl: () => {
        const isListening = origin.port > 0;
        const canAddressBridge = hasBridge && isListening;
        if (canAddressBridge) return mount.wsUrl(origin);
        return null;
      },
      activity: (incident) => logger.note(formatActivityWarning(incident)),
      beaconToken,
      beacon: (report) => {
        beaconsSeen += 1;
        logger.note(formatBeaconReceipt(report));
      },
      permissive: opts.permissive,
      hosted: opts.hosted,
      deployHostedRules: usesHostedSandbox ? mount?.deployHostedRules : undefined,
      logger,
    });
  } catch (error) {
    bundle.dispose?.();
    const isSeedError = error instanceof SandboxSeedError;
    if (isSeedError) {
      const isReadFailure = error.kind === 'read';
      if (isReadFailure) {
        throw new Error(`pyric sandbox: failed to read --seed ${error.path}: ${error.detail}`);
      }
      throw new Error(`pyric sandbox: --seed must be a JSON object of "collection/doc" to fields, ${error.detail}`);
    }
    throw error;
  }
  const resetsPersistedState = Boolean(opts.persist && opts.fresh);
  if (resetsPersistedState) {
    logger.note('  ⓘ --fresh: discarded the existing state file; re-seeding');
    logger.note(
      '  ⚠ --fresh only resets the server-side state file — a browser tab that already has ' +
        'sandbox data in IndexedDB keeps it and will write it straight back on its next flush. ' +
        'For a full reset, also clear the browser store: Studio → Settings → Reset, or open an ' +
        'incognito/private window.',
    );
  }
  const payload = session.payload;
  const hosted = usesHostedSandbox ? { projectKey: opts.cwd } : undefined;
  let namespaceHandler: SandboxSession['handle'] = session.handle;
  if (hasBridge) {
    namespaceHandler = async (req, res, url) => {
      const handledByBridge = await mount.handler(req, res, url);
      if (handledByBridge) return true;
      return session.handle(req, res, url);
    };
  }
  let handle: Awaited<ReturnType<typeof startStaticServer>>;
  try {
    handle = await startStaticServer({
      publicDir,
      port: opts.port ?? 3473,
      host: opts.host ?? 'localhost',
      spaRewrite: wantsSpaRewrite(hosting),
      namespaceHandler,
      // Never force in-page: serve always serves the worker, and the bridge peer
      // routes agent tool-calls THROUGH the worker (see connectBridgePeer), so app
      // + Studio + agent share the one sandbox even under --bridge.
      transformHtml: (html) => injectServeTags(html, { workerVersion, hosted }),
      allowedHosts: opts.allowedHosts,
      logger,
    });
  } catch (error) {
    await mount?.close();
    await session.close();
    bundle.dispose?.();
    throw error;
  }
  origin.port = handle.port;
  // The bridge attachment owns upgrades on every bound family plus discovery.
  // Its explicit close handle is also folded into stop() below, before the
  // sandbox session is released.
  let bridgeAttachment;
  try {
    if (usesHostedSandbox) await mount?.startHostedSandbox(session.payload(), handle.url);
    bridgeAttachment = mount?.attachHost({
      servers: handle.servers,
      lifecycleServer: handle.server,
      projectDir: opts.cwd,
      origin: () => {
        const isListening = origin.port > 0;
        return isListening ? origin : null;
      },
    });
  } catch (error) {
    await mount?.close();
    await session.close();
    await handle.stop().catch(() => undefined);
    bundle.dispose?.();
    throw error;
  }
  const stopServer = handle.stop.bind(handle);
  let closeResources: Promise<void> | null = null;
  const closeOwnedResources = (): Promise<void> => {
    closeResources ??= (async () => {
      await bridgeAttachment?.close();
      await mount?.close();
      await session.close();
      releaseOwnership?.();
    })();
    return closeResources;
  };
  handle = {
    ...handle,
    async stop() {
      // Initiate listener shutdown before terminating upgraded sockets. Bun's
      // node:http compatibility layer can strand close callbacks when an
      // upgraded socket is destroyed first. Resource teardown remains ordered
      // bridge → sandbox, and the server close is awaited last.
      const serverStop = stopServer();
      try {
        await closeOwnedResources();
      } finally {
        await serverStop;
      }
    },
  };
  const disposeBundle = bundle.dispose;
  const needsBundleCleanup = disposeBundle !== undefined;
  if (needsBundleCleanup) handle.server.once('close', disposeBundle);
  handle.server.once('close', () => void closeOwnedResources());
  const hasSiteUi = Boolean(siteUiDir);
  const uiUrl = hasSiteUi ? `${handle.url}/__pyric/ui/studio` : null;
  const docsUrl = hasSiteUi ? `${handle.url}/__pyric/ui/docs/` : null;

  // Hot-reload: the static adapter observes the filesystem; the session owns
  // read/prepare/last-good replacement and event broadcast.
  const rulesSourcePath = session.summary.rules.firestore.sourcePath;
  const isWatchEnabled = opts.watch ?? true;
  const hasRulesPath = rulesSourcePath !== null;
  const watching = isWatchEnabled && hasRulesPath;
  if (watching) {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const watcher = watchFile(rulesSourcePath, () => {
      const pendingReload = debounce;
      const hasPendingReload = pendingReload !== null;
      if (hasPendingReload) clearTimeout(pendingReload);
      debounce = setTimeout(() => {
        void session.reloadFirestoreRules().then((result) => {
          const isReloaded = result.kind === 'reloaded';
          const isRejected = result.kind === 'rejected';
          if (isReloaded) {
            logger.note(`  ↻ rules reloaded (hash ${result.rulesHash}) → ${result.clients} page(s)`);
          } else if (isRejected) {
            logger.note(`  ⚠ rules NOT reloaded (last-good stays live): ${result.error.message}`);
          }
        });
      }, 150);
    });
    watcher.on('error', (error) => {
      const message = serveErrorMessage(error);
      logger.note(`  ⚠ rules watcher failed (hot reload off): ${message}`);
    });
    handle.server.once('close', () => {
      const pendingReload = debounce;
      const hasPendingReload = pendingReload !== null;
      if (hasPendingReload) clearTimeout(pendingReload);
      watcher.close();
    });
  }
  const dbRulesSourcePath = session.summary.rules.database.sourcePath;
  const isDatabaseWatchEnabled = opts.watch !== false;
  const hasDbRulesPath = dbRulesSourcePath !== null;
  const watchingDb = isDatabaseWatchEnabled && hasDbRulesPath;
  if (watchingDb) {
    let debounceDb: ReturnType<typeof setTimeout> | null = null;
    const dbWatcher = watchFile(dbRulesSourcePath, () => {
      const pendingReload = debounceDb;
      const hasDebounceDb = pendingReload !== null;
      if (hasDebounceDb) {
        clearTimeout(pendingReload);
      }
      debounceDb = setTimeout(() => {
        void session.reloadDatabaseRules().then((result) => {
          const isReloaded = result.kind === 'reloaded';
          if (isReloaded) {
            logger.note(`  ↻ rtdb rules reloaded (hash ${result.rulesHash}) → ${result.clients} page(s)`);
          } else {
            const isRejected = result.kind === 'rejected';
            if (isRejected) {
              logger.note(`  ⚠ rtdb rules NOT reloaded (last-good stays live): ${result.error.message}`);
            }
          }
        });
      }, 150);
    });
    dbWatcher.on('error', (error) => {
      const errorMsg = serveErrorMessage(error);
      logger.note(`  ⚠ rtdb rules watcher failed (hot reload off): ${errorMsg}`);
    });
    handle.server.once('close', () => {
      const pendingReload = debounceDb;
      const hasDebounceDb = pendingReload !== null;
      if (hasDebounceDb) {
        clearTimeout(pendingReload);
      }
      dbWatcher.close();
    });
  }

  logger.info(`=== Serving from '${opts.cwd}'...`);
  logger.info('');
  logger.info(`✔ hosting  Serving files from: ${hosting?.public ?? '.'}`);
  logger.info(`✔ hosting  Local server: ${handle.url}`);
  const usedCachedBundle = bundle.cached;
  if (usesEmbeddedAssets) {
    logger.info('✔ sandbox  pyric SDK bundles ready (embedded)');
  } else if (usedCachedBundle) {
    logger.info('✔ sandbox  pyric SDK bundles ready (cache)');
  } else {
    logger.info(`✔ sandbox  pyric SDK bundles built in ${bundleMs}ms`);
  }
  const rulesTarget = usesHostedSandbox ? 'Node sandbox' : 'in-page sandbox';
  const hasFirestoreRules = Boolean(session.payload().rules);
  if (hasFirestoreRules) {
    logger.info(`✔ rules    ${session.summary.rules.firestore.sourcePath} → deployed to the ${rulesTarget} (hash ${session.summary.rules.firestore.hash})`);
  } else {
    logger.info('• rules    no firestore.rules — sandbox runs with default rules');
  }
  const hasDatabaseRules = Boolean(session.payload().databaseRules);
  if (hasDatabaseRules) {
    logger.info(`✔ rules    ${session.summary.rules.database.sourcePath} → deployed to the RTDB sandbox (hash ${session.summary.rules.database.hash})`);
  } else {
    logger.info('• rules    no database.rules — RTDB sandbox runs with default rules');
  }
  const hasStorageRules = Boolean(session.payload().storageRules);
  if (hasStorageRules) {
    logger.info(
      `✔ rules    ${session.summary.rules.storage.sourcePath} → deployed to the storage sandbox (hash ${session.summary.rules.storage.hash}; ` +
      'edits require a restart — storage rules do not hot-reload)',
    );
  } else {
    logger.info('• rules    no storage.rules — storage sandbox denies client operations by default');
  }
  const hasStudioUrl = uiUrl !== null;
  if (hasStudioUrl) {
    logger.info(`✔ studio   Pyric Studio: ${uiUrl}`);
  }
  const hasDocsUrl = docsUrl !== null;
  if (hasDocsUrl) {
    logger.info(`✔ docs     Pyric docs: ${docsUrl}`);
  }
  if (hasBridge) {
    logger.info(`✔ bridge   MCP endpoint: ${mount.mcpUrl(origin)} (sandbox peers over ws at /__pyric/sandbox)`);
  }
  // AI is a mounted service like the bridge: `/__pyric/ai-proxy` answers from
  // the first request on, whether or not anything is configured. `pyric
  // sandbox` has no AI flag, so the ENGINE is always the page's own `getAI()`
  // choice (resolved lazily in the browser, since nothing here instantiates a
  // broker to find out); what this server does decide is where the proxy
  // forwards, and that is what the line reports.
  logger.info(formatAiStatusLine({}));
  let persistSummary: ServeRuntime['persist'] = null;
  const persistence = session.summary.persistence;
  const hasPersistence = persistence !== null;
  if (hasPersistence) {
    const fsDocs = persistence.restoredDocs;
    const users = persistence.restoredUsers;
    persistSummary = { restoredDocs: fsDocs, restoredUsers: users };
    const restoredState = persistence.restored;
    if (restoredState) {
      logger.info(`✔ persist  ${persistence.path} (${fsDocs} doc(s), ${users} user(s) restored; --seed skipped)`);
    } else {
      logger.info(`✔ persist  new state file at ${persistence.path} (first run — seed applies)`);
    }
    const hasRecoveryBackup = existsSync(persistence.backupPath);
    if (hasRecoveryBackup) {
      logger.note(
        `  ⓘ a recovery backup exists at ${persistence.backupPath} (prior non-empty state was ` +
          'replaced by an empty one — e.g. a reset). Restore: mv it back over state.json.',
      );
    }
  } else if (usesHostedSandbox) {
    logger.note('  ⓘ persist  data is held in Node memory and is lost when this process stops.');
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
  const hasStagedSeed = session.summary.seedStaged;
  if (hasStagedSeed) {
    logger.info(`✔ seed     ${session.summary.seedLabel} staged for page init`);
  }
  const hasCapture = Boolean(session.summary.capturePath);
  if (hasCapture) {
    logger.info(`✔ capture  session → ${session.summary.capturePath} (run \`pyric verify\` to replay it)`);
  }
  if (watching) {
    logger.info(`✔ watch    hot-reloading ${rulesSourcePath} over /__pyric/events`);
  }
  if (watchingDb) {
    logger.info(`✔ watch    hot-reloading ${dbRulesSourcePath} over /__pyric/events`);
  }
  // Browser-honesty: the sandbox is browser-resident — firestore/auth and
  // persistence run IN the served page. With no page open, data ops silently
  // no-op. This warning (paired with auto-open in runServe) is the fix for the
  // "I ran serve and nothing happened" surprise. Always printed.
  logger.note('');
  if (usesHostedSandbox) {
    logger.note('  ⓘ the pyric sandbox executes in this Node process.');
  } else {
    logger.note('  ⚠ the pyric sandbox runs IN the served page — keep the browser tab open.');
    logger.note('    Firestore/auth data and persistence stop when no page is open.');
  }
  let mcpUrl: string | null = null;
  if (hasBridge) mcpUrl = mount.mcpUrl(origin);
  return { handle, publicDir, payload, uiUrl, mcpUrl, persist: persistSummary, beaconCount, beaconToken };
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
 * `pyric sandbox -- <cmd>` breaks its own
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
 * request/WS interaction must never take `pyric sandbox` down. Node kills the
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
      `  ✖ pyric sandbox: unhandled rejection. The server was kept alive. Please report this:\n` +
        `    ${describe(reason).split('\n').join('\n    ')}`,
    );
  };
  const onException = (err: unknown): void => {
    log(
      `  ✖ pyric sandbox: uncaught exception. The server was kept alive. Please report this:\n` +
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

function resolveServePort(flagPort: unknown, configPort?: number): number {
  if (typeof flagPort === 'string') return Number(flagPort);
  if (typeof flagPort === 'number') return flagPort;
  if (typeof configPort === 'number') return configPort;
  return 3473;
}

function resolveProjectIdentifier(
  flagProject?: unknown,
  envProject?: string,
  configProject?: string,
  rcDefault?: string,
): string {
  if (typeof flagProject === 'string' && flagProject.length > 0) return flagProject;
  if (typeof envProject === 'string' && envProject.length > 0) return envProject;
  if (typeof configProject === 'string' && configProject.length > 0) return configProject;
  if (typeof rcDefault === 'string' && rcDefault.length > 0) return rcDefault;
  return 'demo-project';
}

function resolveExplicitCommand(parsed: ParsedArgs): string[] | null {
  if (parsed.passthrough && parsed.passthrough.length > 0) {
    return parsed.passthrough;
  }
  if (parsed.positional.length > 0) {
    return parsed.positional;
  }
  return null;
}

/** CLI entry. Resolves on SIGINT/SIGTERM after a clean stop. */
export async function runServe(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  let pyricConfig: PyricConfig = {};
  try {
    pyricConfig = await readPyricConfig(cwd);
  } catch (error) {
    const message = serveErrorMessage(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }

  const flagPort = parsed.flags.get('port');
  const port = resolveServePort(flagPort, pyricConfig.port);
  const isInvalidPort = !Number.isFinite(port) || port < 0 || port > 65535;
  if (isInvalidPort) {
    process.stderr.write(`pyric: invalid --port '${flagPort}'.\n`);
    return 1;
  }
  const flagHost = parsed.flags.get('host');
  const hasHostFlag = typeof flagHost === 'string';
  const host = hasHostFlag ? flagHost : 'localhost';

  const only = parsed.flags.get('only');
  const requestsUnsupportedService = typeof only === 'string' && only !== 'hosting';
  if (requestsUnsupportedService) {
    process.stderr.write(
      `pyric: --only '${only}' is not supported. pyric sandbox serves hosting with the in-page sandbox standing in for Firestore and Auth.\n`,
    );
    return 1;
  }

  const json = Boolean(parsed.flags.get('json'));
  const usesHumanOutput = !json;

  const explicitUi = Boolean(parsed.flags.get('ui'));
  const uiOn = !parsed.flags.get('no-ui');

  // Resolve the child plan BEFORE the server starts: a planned child implies
  // the bridge (see bridgeEnabledFor) — the child's injected PYRIC_SANDBOX
  // is useless without the /__pyric/sandbox WS mount.
  let discoveredFunctionsProject: FunctionsRtdbProject | null;
  let resolvedFunctionsProjectId: string | null = null;
  try {
    const discovered = discoverFunctionsRtdbProject(cwd);
    discoveredFunctionsProject = discovered;
    const hasFunctionsProject = discovered !== null;
    if (hasFunctionsProject) {
      const flagProject = parsed.flags.get('project');
      const rc = await readFirebaseRc(cwd);
      resolvedFunctionsProjectId = resolveProjectIdentifier(
        flagProject,
        process.env.PYRIC_PROJECT,
        pyricConfig.project,
        rc?.projects?.default,
      );
    }
  } catch (error) {
    const message = serveErrorMessage(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }
  const functionsProject = discoveredFunctionsProject;
  const functionsProjectId = resolvedFunctionsProjectId;

  const explicitCommand = resolveExplicitCommand(parsed);

  const plan = resolveSandboxChild({
    explicitCommand,
    configCommand: pyricConfig.command,
    noRun: Boolean(parsed.flags.get('no-run')),
    json,
  });
  const bridgeOn = bridgeEnabledFor(parsed.flags, plan, functionsProject);

  let runtime: ServeRuntime;
  try {
    const flagSeed = parsed.flags.get('seed');
    const hasSeedFlag = typeof flagSeed === 'string';
    const seed = hasSeedFlag ? flagSeed : undefined;
    const disablesWatch = Boolean(parsed.flags.get('no-watch'));
    const watch = disablesWatch ? false : undefined;
    const capture = !parsed.flags.get('no-capture');
    const flagAllowedHosts = parsed.flags.get('allowed-host');
    const hasAllowedHostsFlag = typeof flagAllowedHosts === 'string';
    let allowedHosts: string[] | undefined;
    if (hasAllowedHostsFlag) {
      allowedHosts = flagAllowedHosts.split(',').map((hostname) => hostname.trim()).filter(Boolean);
    }
    const flagProject = parsed.flags.get('project');
    const hasProjectFlag = typeof flagProject === 'string';
    const environmentProject = process.env.PYRIC_PROJECT;
    const hasEnvironmentProject = environmentProject !== undefined;
    const configuredProject = pyricConfig.project;
    const hasConfiguredProject = configuredProject !== undefined;
    let project: string | undefined;
    if (hasProjectFlag) {
      project = flagProject;
    } else if (hasEnvironmentProject) {
      project = environmentProject;
    } else if (hasConfiguredProject) {
      project = configuredProject;
    } else {
      project = functionsProjectId ?? undefined;
    }
    let logger: Parameters<typeof startServe>[0]['logger'];
    if (json) logger = stderrServeLogger();
    runtime = await startServe({
      cwd: process.cwd(),
      port,
      host,
      logger,
      noCache: Boolean(parsed.flags.get('no-cache')),
      bridge: bridgeOn,
      hosted: Boolean(parsed.flags.get('hosted')),
      live: Boolean(parsed.flags.get('live')),
      seed,
      watch,
      persist: Boolean(parsed.flags.get('persist')),
      fresh: Boolean(parsed.flags.get('fresh')),
      permissive: Boolean(parsed.flags.get('permissive')),
      // --ui mounts the Pyric Studio storage routes (workspace + projects).
      ui: uiOn,
      // --no-capture disables the default-on session capture. The pattern
      // mirrors --no-open: default is true, one flag inverts it.
      capture,
      allowedHosts,
      project,
    });
  } catch (e) {
    const message = serveErrorMessage(e);
    process.stderr.write(`${message}\n`);
    return 2;
  }

  // The server is up: from here on, no single bad request/WS/watcher error
  // may kill the process — log loudly and keep serving (startup errors above
  // still fail fast).
  installServeProcessGuard((m) => process.stderr.write(m + '\n'));

  // The agent contract: with --json, stdout carries exactly this one line
  // (the banner went to stderr). Readiness probe: GET /__pyric/init.json.
  if (json) process.stdout.write(serveJsonLine(runtime) + '\n');

  // A host-only sandbox mounts no MCP bridge unless one is needed.
  // so a `pyric mcp-proxy` in an editor cannot attach. Nudge toward --bridge.
  const shouldSuggestBridge = !bridgeOn && usesHumanOutput;
  if (shouldSuggestBridge) {
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
    // When explicit --ui is passed, open Studio directly; otherwise open the served page.
    const studioUrl = runtime.uiUrl;
    const opensStudio = explicitUi && studioUrl !== null;
    const targetUrl = opensStudio ? studioUrl : runtime.handle.url;
    void openBrowser(targetUrl);
  }

  let devChild: SandboxChildHandle | null = null;
  let beaconWatchdog: BeaconWatchdog | null = null;
  let functionsRuntime: FunctionsDevelopmentRuntime | null = null;
  const { promise: functionsExited, resolve: resolveFunctionsExit } = Promise.withResolvers<number>();
  const { promise: signal, resolve: resolveSignal } = Promise.withResolvers<NodeJS.Signals>();
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
    const output = json ? process.stderr : process.stdout;
    output.write('\nShutting down...\n');
    beaconWatchdog?.stop();
    const activeChild = devChild;
    const hasRunningChild = activeChild !== null && activeChild.child.exitCode === null;
    if (hasRunningChild) activeChild.signal(await signal);
    await functionsRuntime?.close().catch(() => undefined);
    await runtime.handle.stop().catch(() => undefined);
    removeSignalHandlers();
    return 0;
  };

  const hasFunctionsIdentity = functionsProjectId !== null && functionsProjectId.length > 0;
  const canStartFunctions = functionsProject !== null && hasFunctionsIdentity;
  if (canStartFunctions) {
    const info = json ? process.stderr : process.stdout;
    info.write('• functions waiting for the browser tab to connect the sandbox…\n');
    const reportFunctionsEvent = (event: FunctionsDevelopmentEvent): void => {
      const isOutput = event.type === 'output';
      if (isOutput) {
        const isStdout = event.stream === 'stdout';
        const output = isStdout ? info : process.stderr;
        output.write(event.line);
        return;
      }
      const isUnexpectedExit = event.type === 'unexpected-exit';
      if (isUnexpectedExit) {
        resolveFunctionsExit(event.code);
        return;
      }
      const childEvent = event.event;
      const isExecution = childEvent.type === 'execution';
      if (isExecution) {
        const params = Object.entries(childEvent.params)
          .map(([name, value]) => `${name}=${value}`)
          .join(', ');
        const hasParams = params.length > 0;
        const paramsSuffix = hasParams ? ` (${params})` : '';
        const isFulfilled = childEvent.status === 'fulfilled';
        if (isFulfilled) {
          info.write(`✔ function  ${childEvent.exportName} ← /${childEvent.ref}${paramsSuffix}\n`);
        } else {
          process.stderr.write(
            `✖ function  ${childEvent.exportName} ← /${childEvent.ref}${paramsSuffix}: ${childEvent.error.message}\n`,
          );
        }
      } else {
        process.stderr.write(
          `✖ functions delivery for ${childEvent.exportName}: ${childEvent.error.message}\n`,
        );
      }
    };
    functionsRuntime = createFunctionsDevelopmentRuntime({
      sourceDir: functionsProject.sourceDir,
      entry: functionsProject.entry,
      baseEnv: process.env,
      serveUrl: runtime.handle.url,
      registerUrl: registerModuleUrl(),
      beaconToken: runtime.beaconToken,
      instance: `${functionsProjectId}-default-rtdb`,
      location: process.env.PYRIC_FUNCTIONS_RTDB_REGION ?? 'us-central1',
      projectId: functionsProjectId ?? 'demo-project',
      readiness: createHttpFunctionsPeerReadiness(runtime.handle.url),
      onEvent: reportFunctionsEvent,
    });
    const startOutcome = await waitOrSignal(functionsRuntime.start());
    const interruptedStartup = 'signal' in startOutcome;
    if (interruptedStartup) return stopAfterSignal();
    const result = startOutcome.value;
    const isMissingPeer = result.kind === 'no-peer';
    const failedStartup = result.kind === 'failed';
    if (isMissingPeer) {
      process.stderr.write(
        `  ⚠ functions not started — no browser tab connected after 30s. ` +
          `Open ${runtime.handle.url} and restart pyric sandbox.\n`,
      );
    } else if (failedStartup) {
      process.stderr.write(`${result.error.message}\n`);
      await functionsRuntime.close();
      await runtime.handle.stop();
      removeSignalHandlers();
      return 2;
    } else {
      const ready = result.ready;
      const hasSingleTrigger = ready.triggerCount === 1;
      const triggerSuffix = hasSingleTrigger ? '' : 's';
      info.write(
        `✔ functions ${ready.triggerCount} onValueCreated trigger${triggerSuffix} ` +
          `from ${relative(cwd, functionsProject.entry)}\n`,
      );
      for (const unsupported of ready.unsupportedTriggers) {
        process.stderr.write(
          `  ⚠ functions export ${unsupported.exportName} uses unsupported trigger ` +
            `${unsupported.eventType}; it will not run in pyric sandbox.\n`,
        );
      }
    }
  }

  // Run the explicit or configured command with the sandbox environment.
  // `--no-run` forces host-only. `--json` skips the configured command, but an
  // explicit command still runs.
  // (`plan` was resolved above so it could imply the bridge mount.)
  const hasChildPlan = plan !== null;
  if (hasChildPlan) {
    const info = json ? process.stderr : process.stdout;
    // First-run race guard: we just opened the tab ourselves, so wait
    // (bounded) for it to register as the sandbox peer before the child's
    // first op can lose the race and die on the no-tab fail-fast. Skipped
    // when nothing was opened (CI/--no-open/--json): no tab is coming, and
    // stalling would only delay the honest failure.
    if (opened) {
      info.write('• run      waiting for the browser tab to connect the sandbox…\n');
      const connectedOutcome = await waitOrSignal(waitForSandboxPeer(runtime.handle.url));
      const interruptedConnection = 'signal' in connectedOutcome;
      if (interruptedConnection) return stopAfterSignal();
      const connected = connectedOutcome.value;
      const missingPeer = !connected;
      if (missingPeer) {
        info.write(
          `  ⚠ no browser tab connected after 30s — starting your command anyway; sandbox ops will fail until ${runtime.handle.url} is open.\n`,
        );
      }
    } else if (usesHumanOutput) {
      info.write(
        `  ⓘ Auto-open is disabled (--no-open/CI). The pyric sandbox is browser-resident: ` +
          `open ${runtime.handle.url} to connect if your command performs Firebase operations.\n`,
      );
    }
    info.write(
      `✔ run      \`${plan.label}\` — firebase-admin/firebase imports are routed to the sandbox at ${runtime.handle.url}\n`,
    );
    const childEnv = buildChildEnv(process.env, {
      serveUrl: runtime.handle.url,
      registerUrl: registerModuleUrl(),
      beaconToken: runtime.beaconToken,
    });
    // What we are handing the child, stated before it starts: the interlock
    // line and the unsupported-runtime check.
    const interlock = reportLaunchChecks({
      childEnv,
      registerUrl: registerModuleUrl(),
      argv: plan.argv,
      write: (line) => info.write(line),
    });

    devChild = spawnSandboxChild(plan, { cwd, json, env: childEnv });
    // A child still alive well after launch that never posted a beacon is very
    // likely not intercepted. `startBeaconWatchdog` says why this only warns.
    const beaconsAtSpawn = runtime.beaconCount();
    beaconWatchdog = startBeaconWatchdog({
      label: plan.label,
      beacon: interlock.beacon,
      sawBeacon: () => runtime.beaconCount() > beaconsAtSpawn,
      isAlive: () => devChild !== null && devChild.child.exitCode === null,
      warn: (line) => void process.stderr.write(`${line}\n`),
    });
  } else if (usesHumanOutput) {
    process.stdout.write(
      formatStartupEnvExport({
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
        beaconToken: runtime.beaconToken,
      }),
    );
  }

  return await new Promise<number>((resolveExit) => {
    let settled = false;
    let shuttingDown = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      void (async () => {
        beaconWatchdog?.stop();
        await functionsRuntime?.close().catch(() => undefined);
        const activeChild = devChild;
        const hasRunningChild = activeChild !== null && activeChild.child.exitCode === null;
        if (hasRunningChild) {
          activeChild.signal('SIGTERM');
          await activeChild.exited.catch(() => undefined);
        }
        await runtime.handle.stop().catch(() => undefined);
        removeSignalHandlers();
        resolveExit(code);
      })();
    };
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      const output = json ? process.stderr : process.stdout;
      output.write('\nShutting down...\n');
      void functionsRuntime?.close();
      const activeChild = devChild;
      const hasRunningChild = activeChild !== null && activeChild.child.exitCode === null;
      if (hasRunningChild) {
        // Forward the signal; the child's exit (below) closes the host.
        // (The terminal delivers Ctrl-C to the whole group too — the
        // forward makes non-TTY / programmatic signals behave the same.)
        activeChild.signal(signal);
      } else {
        finish(0);
      }
    };
    // Child exits → close the host and propagate its code (Ctrl-C → 0).
    const activeChild = devChild;
    const hasChild = activeChild !== null;
    if (hasChild) void activeChild.exited.then((code) => finish(code));
    const hasFunctionsRuntime = functionsRuntime !== null;
    if (hasFunctionsRuntime) {
      void functionsExited.then((code) => {
        const exitedUnexpectedly = !settled && !shuttingDown;
        if (exitedUnexpectedly) {
          process.stderr.write(`pyric sandbox: Functions child exited unexpectedly (code ${code}).\n`);
          const exitedSuccessfully = code === 0;
          const failureCode = exitedSuccessfully ? 1 : code;
          finish(failureCode);
        }
      });
    }
    void signal.then(shutdown);
  });
}
