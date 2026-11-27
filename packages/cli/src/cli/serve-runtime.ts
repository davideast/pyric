/**
 * Programmatic runtime orchestration for `pyric sandbox` (`startServe`).
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LocalSandbox } from 'pyric/sandbox';
import {
  extractHosting,
  readFirebaseJson,
  resolveHostingSite,
  wantsSpaRewrite,
  type FirebaseJson,
} from './firebase-json.js';
import { resolveFirebaseProject, type FirebaseProjectResolution } from './firebase-project.js';
import { scanForInlinedFirebase } from './inlined-sdk-scanner.js';
import { readPyricConfig } from './pyric-config.js';
import { applyPyricRuleOverrides, attachServeRulesWatchers } from './serve-rules-watchers.js';
import { logServeStartupBanner } from './serve-startup-banner.js';
import type { FunctionsHttpGateway } from '../functions/http/gateway.js';
import { captureHostedSandbox } from '../functions/http/host-events.js';
import { formatActivityWarning } from '../serve/activity-warning.js';
import { injectServeAiEngineTag } from '../serve/ai-engine-wire.js';
import { createAppPorts } from '../serve/app-ports.js';
import { resolveAvatarsConfig } from '../serve/avatars-config.js';
import { formatBeaconReceipt } from '../serve/beacon-route.js';
import { createBridgeMount } from '../serve/bridge-mount.js';
import { bundleSdk, bundleWorker, defaultSdkEntries, planProjectFirebase, resolveSiteUiDir } from '../serve/bundler.js';
import { geminiProxyConfig } from '../serve/gemini-proxy.js';
import {
  effectiveRequestScheme,
  parseTrustProxySetting,
  type RemoteAccessOptions,
} from '../serve/guard-policy.js';
import { refuseOwnWrite, type PyricWriteRefusal } from '../serve/hosted/own-writes.js';
import { injectServeTags } from '../serve/html-injection.js';
import type { WorkerInitPayload } from '../serve/init-payload.js';
import { liveHostPageImportMap } from '../serve/live-host-pages.js';
import { createLiveHostState } from '../serve/live-host-state.js';
import { requireLiveProject } from '../serve/live-project.js';
import { rulesFilesOf } from '../serve/live-terminal-lines.js';
import { writeOwnedSessionFile } from '../serve/local-session-token.js';
import type { InitPayload } from '../serve/namespace.js';
import { resolveOwnersConfig } from '../serve/owners-config.js';
import { opaqueProjectKey } from '../serve/project-key.js';
import { resolveRemoteAccessConfig, type RemoteAccessSetting } from '../serve/remote-access-config.js';
import { workerInitPayload } from '../serve/runtime/hosted-target.js';
import { hasSandboxBuildMarker } from '../serve/sandbox-marker.js';
import {
  createSandboxSession,
  SandboxSeedError,
  type SandboxSession,
} from '../serve/sandbox-session.js';
import {
  consoleServeLogger,
  getHeader,
  isAllowedOriginOnPorts,
  isForeignFetchSite,
  requestSocketScheme,
  startStaticServer,
  type ServeHandle,
} from '../serve/server.js';
import {
  assertStandaloneSupportsAiMode,
  embeddedWorkerVersion,
  isStandalone,
  materializeServeAssets,
  materializeSiteUi,
} from '../serve/standalone-assets.js';
import {
  browserAiEngineWire,
  hasIgnoredBrowserGeminiKey,
  loadViteAiEnv,
  resolveViteAiConfig,
  type PyricAiOptions,
} from '../serve/vite-ai-config.js';

/** What only `@pyric/live`'s seam (`serve/live-host.ts`) sets on a run. */
export interface LiveServeStart {
  project: FirebaseProjectResolution;
  writeRefusal: PyricWriteRefusal;
  allowRemotePeers?: boolean;
  passThrough?: readonly string[];
  deployedRules?: boolean;
}

export interface ServeRuntime {
  handle: ServeHandle;
  /** `hosting.public`, resolved; `null` when no `hosting.public` directory is configured. */
  publicDir: string | null;
  payload: () => InitPayload;
  /** HTTP MCP endpoint when `--bridge` is on; null otherwise. */
  mcpUrl: string | null;
  /** The Studio hub URL (`/__pyric/ui/studio`) when `--ui` is on and the build is present; null otherwise. */
  uiUrl: string | null;
  /** Persistence summary (null when `--persist` is off). */
  persist: { restoredDocs: number; restoredUsers: number } | null;
  /** Handshake beacons posted to `/__pyric/beacon` so far. */
  beaconCount: () => number;
  /** The per-launch secret a beacon must present, placed in every child's `PYRIC_BEACON_TOKEN`. */
  beaconToken: string;
  /** The per-boot capability token required on `/__pyric/*` routes. */
  sessionToken: string;
  /** The bridge's host identity; undefined without the bridge mount. */
  instanceId: string | undefined;
  /** The transport selection this host stamps into served HTML. */
  workerInit: WorkerInitPayload;
  /** The Node-hosted sandbox when `hosted` is enabled; null otherwise or after stop. */
  hostedSandbox?: LocalSandbox | null;
}

export interface StartServeOptions {
  cwd: string;
  port?: number;
  host?: string;
  noCache?: boolean;
  cacheRoot?: string;
  bridge?: boolean;
  hosted?: boolean;
  project?: string;
  firebaseProject?: FirebaseProjectResolution;
  disableAuditLog?: boolean;
  seed?: string;
  watch?: boolean;
  persist?: boolean;
  fresh?: boolean;
  allowedHosts?: string[];
  remoteAccess?: RemoteAccessSetting;
  capture?: boolean;
  ui?: boolean;
  permissive?: boolean;
  ai?: PyricAiOptions;
  logger?: Parameters<typeof startStaticServer>[0]['logger'];
  functionsHandler?: FunctionsHttpGateway['handle'];
  hasChildCommand?: boolean;
  sessionToken?: boolean;
  liveHost?: LiveServeStart;
}

/**
 * The `--json` stdout contract -- one line, keep stable; agents parse this.
 * Readiness probe: GET {url}/__pyric/init.json -> 200.
 */
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
 * Programmatic entry -- everything but flag parsing and process lifecycle.
 * Exported so integration tests drive a real server without a subprocess.
 */
export async function startServe(opts: StartServeOptions): Promise<ServeRuntime> {
  const usesHostedSandbox = opts.hosted === true;
  const usesBrowserPersistence = opts.persist === true;
  if (usesHostedSandbox || usesBrowserPersistence) {
    const { claimProjectState } = await import('../serve/hosted/project-ownership.js');
    const scope = usesHostedSandbox ? 'host' : 'browser-state';
    const owner = await claimProjectState(opts.cwd, scope);
    try {
      return await startServeRuntime(opts, owner.close);
    } catch (error) {
      owner.close();
      throw error;
    }
  }
  return startServeRuntime(opts);
}

async function startServeRuntime(
  opts: StartServeOptions,
  releaseOwnership?: () => void,
): Promise<ServeRuntime> {
  const logger = opts.logger ?? consoleServeLogger();
  const pyricConfig = await readPyricConfig(opts.cwd);
  const firebaseProject =
    opts.firebaseProject ??
    resolveFirebaseProject({
      projectDir: opts.cwd,
      option: opts.project,
      configProject: pyricConfig.project,
    });
  const liveStart = opts.liveHost;
  const isLive = liveStart !== undefined;
  let liveHost: ReturnType<typeof createLiveHostState> | undefined;
  if (liveStart !== undefined) {
    liveHost = createLiveHostState({
      configProjectId: requireLiveProject(liveStart.project, opts.cwd),
      configSource: liveStart.project.source,
      optionName: '--project',
      warn: (line) => logger.note(line),
      passThrough: liveStart.passThrough,
      deployedRules: liveStart.deployedRules === true,
    });
  }
  if (isLive && opts.seed !== undefined) {
    refuseOwnWrite(liveStart.writeRefusal, { action: `seed ${opts.seed}`, writer: 'seed' });
  }

  let beaconsSeen = 0;
  const beaconCount = (): number => beaconsSeen;
  const beaconToken = randomBytes(24).toString('base64url');
  const sessionToken = randomBytes(24).toString('base64url');

  if (Boolean(opts.fresh && !opts.persist && !opts.hosted)) {
    throw new Error(
      'pyric sandbox: --fresh requires --hosted or --persist. ' +
        'Browser-stored data is cleared from Studio \u2192 Settings \u2192 Reset, or DevTools \u2192 Clear site data.',
    );
  }

  let config: FirebaseJson | null = null;
  let hasFirebaseJson = true;
  try {
    config = await readFirebaseJson(opts.cwd);
  } catch (e) {
    const isMissingConfig = e instanceof Error && e.message.includes('no firebase.json');
    if (!isMissingConfig) throw e;
    hasFirebaseJson = false;
    logger.note('  \u26a0 no firebase.json found');
  }

  const requireSessionToken =
    isLive ||
    opts.sessionToken === true ||
    (opts.sessionToken === undefined && pyricConfig.sessionToken === true);
  const resolvedRemote = resolveRemoteAccessConfig({
    option: opts.remoteAccess,
    allowedHosts: opts.allowedHosts,
    configAllowedHosts: pyricConfig.allowedHosts,
    configRemoteAccess: pyricConfig.remoteAccess,
    env: process.env,
  });
  const effectiveAllowedHosts = resolvedRemote.allowedHosts;
  const effectiveRemoteAccess: RemoteAccessOptions | undefined = resolvedRemote.remoteAccess;
  const effectiveTrustProxy = parseTrustProxySetting(effectiveRemoteAccess?.trustProxy);
  const owners = resolveOwnersConfig(pyricConfig.owners);
  config = applyPyricRuleOverrides(config, pyricConfig.rules);

  const hosting = extractHosting(config);
  const hostingConfig = config?.hosting;
  if (Array.isArray(hostingConfig) && hostingConfig.length > 1) {
    logger.note('  \u26a0 multiple hosting sites configured. pyric sandbox serves the first entry only');
  }
  const hostingSite = resolveHostingSite(opts.cwd, hosting, { hosted: opts.hosted === true });
  const publicDir = hostingSite.publicDir;
  const publicDirLabel = hostingSite.publicLabel ?? 'hosting.public';

  if (publicDir !== null && !hasSandboxBuildMarker(publicDir)) {
    const scanWarnings: string[] = [];
    const inlined = scanForInlinedFirebase(publicDir, {
      publicDirLabel,
      onWarning: (line) => {
        scanWarnings.push(line);
      },
    });
    if (inlined.length > 0) {
      throw new Error(
        `pyric sandbox: ${inlined[0]} bundles the real Firebase SDK, so this dist cannot be ` +
          `sandboxed - its firebase/* calls would reach LIVE Google endpoints, not the ` +
          `pyric sandbox. Two ways forward:\n` +
          `  (a) \`pyric sandbox -- <command>\` runs the child server with the @pyric/cli/vite ` +
          `plugin swaps firebase/* live) - use \`bun run dev\`;\n` +
          `  (b) rebuild as a self-contained sandbox bundle and serve THAT: ` +
          `\`vite build --mode development\` (or pyric({ swapInBuild: true })) then ` +
          `\`pyric sandbox\`.\n` +
          `A plain \`vite build\` is your production build - deploy it, don't sandbox it.`,
      );
    }
    for (const warning of scanWarnings) {
      logger.note(warning);
    }
  }

  const t0 = performance.now();
  let bundle: { outDir: string; cached: boolean; dispose?: () => void };
  let workerVersion: string;
  const usesEmbeddedAssets = isStandalone();
  const loadedAiEnv = loadViteAiEnv('development', opts.cwd, undefined);
  const resolvedAi = resolveViteAiConfig(opts.ai ?? pyricConfig.ai, loadedAiEnv, 'pyric sandbox');
  const ignoredGeminiKey = hasIgnoredBrowserGeminiKey(loadedAiEnv);
  const aiMode = resolvedAi.mode;
  const browserAiEngine = browserAiEngineWire(resolvedAi.engineWire);
  const sessionAi: InitPayload['ai'] = browserAiEngine !== undefined ? { engine: browserAiEngine } : null;
  if (usesEmbeddedAssets) {
    assertStandaloneSupportsAiMode(aiMode, loadedAiEnv);
  }
  let projectFirebase: { projectDir: string } | undefined;
  if (aiMode === 'production') {
    const firebasePlan = planProjectFirebase(opts.cwd, Boolean(opts.hasChildCommand));
    projectFirebase = firebasePlan.projectFirebase;
    if (firebasePlan.warning) logger.note(firebasePlan.warning);
  }
  if (usesEmbeddedAssets) {
    bundle = await materializeServeAssets({ aiMode });
    workerVersion = embeddedWorkerVersion();
  } else {
    bundle = await bundleSdk({
      entries: defaultSdkEntries(),
      noCache: opts.noCache,
      cacheRoot: opts.cacheRoot,
      projectFirebase,
    });
    try {
      const worker = await bundleWorker({ outDir: bundle.outDir, noCache: opts.noCache });
      workerVersion = worker.epoch;
    } catch (error) {
      bundle.dispose?.();
      throw error;
    }
  }
  const bundleMs = Math.round(performance.now() - t0);

  const appPorts = createAppPorts(opts.host ?? 'localhost', {
    allowedHosts: effectiveAllowedHosts,
    trustProxy: effectiveRemoteAccess?.trustProxy,
  });
  const needsBridge = Boolean(opts.bridge || opts.hosted);
  const mount = needsBridge
    ? createBridgeMount({
        hosted: opts.hosted,
        project: opts.project,
        projectKey: opts.cwd,
        disableAuditLog: opts.disableAuditLog,
        liveHost,
        ownWriteRefusal: liveStart?.writeRefusal,
        upgradeGuard: { boundHost: opts.host ?? 'localhost', allowedHosts: effectiveAllowedHosts },
        learnsProxyPorts: true,
        appPorts,
        sessionToken,
        requireSessionToken,
        remoteAccess: effectiveRemoteAccess,
        upgradeRejectionLogger: (line) => logger.note(line),
      })
    : null;
  const hasBridge = mount !== null;

  const origin = { host: opts.host ?? 'localhost', port: 0 };
  let siteUiDir: string | undefined;
  const mountsStudio = Boolean(opts.ui);
  if (mountsStudio) {
    const dir = usesEmbeddedAssets ? await materializeSiteUi() : resolveSiteUiDir();
    if (dir !== null && dir.length > 0) {
      siteUiDir = dir;
    } else {
      logger.note(
        '  \u26a0 --ui: built Astro site not found (run the full build first). ' +
          'The data routes are mounted, but /__pyric/ui/ will 404.',
      );
    }
  }
  const usesPersistence = Boolean(opts.persist || opts.hosted);
  const persistenceOptions = usesPersistence ? { fresh: opts.fresh } : undefined;
  const studioOptions: Parameters<typeof createSandboxSession>[0]['studio'] = mountsStudio ? { siteUiDir } : false;
  const usesHostedSandbox = opts.hosted === true;
  let session: SandboxSession;
  try {
    session = await createSandboxSession({
      projectDir: opts.cwd,
      boundHost: opts.host ?? 'localhost',
      allowedHosts: effectiveAllowedHosts,
      remoteAccess: effectiveRemoteAccess,
      appPorts,
      firebaseConfig: config,
      sdk: { dir: bundle.outDir, workerVersion },
      seedFile: opts.seed,
      persistence: persistenceOptions,
      capture: opts.capture,
      studio: studioOptions,
      ai: sessionAi,
      aiProxyUpstream: resolvedAi.proxyUpstream,
      aiGemini: geminiProxyConfig(resolvedAi.engineWire),
      avatars: resolveAvatarsConfig(undefined, process.env, opts.cwd),
      bridgeUrl: () => (hasBridge && origin.port > 0 ? mount.wsUrl(origin) : null),
      activity: (incident) => logger.note(formatActivityWarning(incident)),
      beaconToken,
      beacon: (report) => {
        beaconsSeen += 1;
        logger.note(formatBeaconReceipt(report));
      },
      permissive: opts.permissive,
      project: firebaseProject,
      hosted: opts.hosted,
      hostInstanceId: () => mount?.instanceId,
      deployHostedRules: usesHostedSandbox ? mount?.deployHostedRules : undefined,
      sessionToken,
      requireSessionToken,
      logger,
    });
  } catch (error) {
    bundle.dispose?.();
    if (error instanceof SandboxSeedError) {
      if (error.kind === 'read') {
        throw new Error(`pyric sandbox: failed to read --seed ${error.path}: ${error.detail}`);
      }
      throw new Error(`pyric sandbox: --seed must be a JSON object of "collection/doc" to fields, ${error.detail}`);
    }
    throw error;
  }
  const runningSession = session;
  liveHost?.readRulesFiles(() => rulesFilesOf(runningSession, opts.cwd));
  if (Boolean(opts.hosted && opts.fresh)) {
    logger.note('  \u24d8 --fresh: archived hosted state; starting a new store');
  }
  if (Boolean(opts.persist && opts.fresh && !opts.hosted)) {
    logger.note('  \u24d8 --fresh: discarded the existing state file; re-seeding');
    logger.note(
      '  \u26a0 --fresh only resets the server-side state file \u2014 a browser tab that already has ' +
        'sandbox data in IndexedDB keeps it and will write it straight back on its next flush. ' +
        'For a full reset, also clear the browser store: Studio \u2192 Settings \u2192 Reset, or open an ' +
        'incognito/private window.',
    );
  }
  const payload = session.payload;
  const hosted = usesHostedSandbox ? { projectKey: opts.cwd } : undefined;
  const pageImportMap = isLive ? liveHostPageImportMap() : undefined;
  const namespaceHandler: SandboxSession['handle'] = async (req, res, url) => {
    appPorts.learn(req);
    if (hasBridge && await mount.handler(req, res, url)) return true;
    return session.handle(req, res, url);
  };
  const allowsAppOrigin = (req: IncomingMessage): boolean => {
    const boundHost = opts.host ?? 'localhost';
    const ports = appPorts.forRequest(req);
    const scheme = effectiveRequestScheme(req, effectiveTrustProxy) ?? requestSocketScheme(req);
    return (
      isAllowedOriginOnPorts(getHeader(req, 'origin'), boundHost, effectiveAllowedHosts, ports, scheme) &&
      !isForeignFetchSite(req, boundHost, ports, scheme, effectiveAllowedHosts)
    );
  };
  const gatewayHandler = opts.functionsHandler;
  const functionsHandler = gatewayHandler !== undefined
    ? (req: IncomingMessage, res: ServerResponse) => gatewayHandler(req, res, allowsAppOrigin)
    : undefined;
  let handle: Awaited<ReturnType<typeof startStaticServer>>;
  try {
    handle = await startStaticServer({
      publicDir,
      port: opts.port ?? 3473,
      host: opts.host ?? 'localhost',
      spaRewrite: wantsSpaRewrite(hosting),
      namespaceHandler,
      functionsHandler,
      transformHtml: (html, ctx) => {
        let htmlHosted = hosted;
        if (hosted !== undefined && ctx.remoteClient === true) {
          htmlHosted = { projectKey: opaqueProjectKey(hosted.projectKey) };
        }
        const tagged = injectServeTags(html, {
          workerVersion,
          hosted: htmlHosted,
          aiMode,
          owners,
          importMap: pageImportMap,
          sessionToken: ctx.localPeer ? sessionToken : undefined,
          remotePeer: !ctx.localPeer,
        });
        return injectServeAiEngineTag(tagged, browserAiEngine);
      },
      sessionToken,
      allowedHosts: effectiveAllowedHosts,
      remoteAccess: effectiveRemoteAccess,
      logger,
    });
  } catch (error) {
    await mount?.close();
    await session.close();
    bundle.dispose?.();
    throw error;
  }
  origin.port = handle.port;
  const canWriteSessionFile =
    !hasBridge && !isLive && (usesHostedSandbox || Boolean(opts.persist) || opts.capture !== false);
  const removeOwnedSessionFile = canWriteSessionFile
    ? writeOwnedSessionFile(opts.cwd, { port: handle.port, token: sessionToken })
    : undefined;
  const hostedSandboxCapture =
    usesHostedSandbox && !isLive ? captureHostedSandbox(session.hostedPersistence?.checkpoints) : null;
  let bridgeAttachment;
  try {
    if (usesHostedSandbox) {
      let hostedPayload = session.payload();
      if (resolvedAi.engineWire !== undefined) {
        hostedPayload = { ...hostedPayload, ai: { engine: resolvedAi.engineWire } };
      }
      await mount?.startHostedSandbox(hostedPayload, handle.url, {
        proxyUpstream: resolvedAi.proxyUpstream,
        logger,
        persistence: session.hostedPersistence,
        ownWriteRefusal: liveStart?.writeRefusal,
      });
    }
    bridgeAttachment = mount?.attachHost({
      servers: handle.servers,
      lifecycleServer: handle.server,
      projectDir: opts.cwd,
      origin: () => (origin.port > 0 ? origin : null),
    });
  } catch (error) {
    hostedSandboxCapture?.clear();
    removeOwnedSessionFile?.();
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
      hostedSandboxCapture?.clear();
      removeOwnedSessionFile?.();
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
      const serverStop = stopServer();
      try {
        await closeOwnedResources();
      } finally {
        await serverStop;
      }
    },
  };
  if (bundle.dispose !== undefined) handle.server.once('close', bundle.dispose);
  handle.server.once('close', () => void closeOwnedResources());
  const hasSiteUi = Boolean(siteUiDir);
  const uiUrl = hasSiteUi ? `${handle.url}/__pyric/ui/studio` : null;
  const docsUrl = hasSiteUi ? `${handle.url}/__pyric/ui/docs/` : null;

  const isWatchEnabled = opts.watch ?? true;
  if (isWatchEnabled) {
    attachServeRulesWatchers({ session, server: handle.server, live: isLive, logger });
  }

  const persistSummary = logServeStartupBanner({
    cwd: opts.cwd,
    publicDir,
    publicDirLabel,
    hasFirebaseJson,
    hasHosting: hosting !== null,
    url: handle.url,
    usesEmbeddedAssets,
    bundleCached: bundle.cached,
    bundleMs,
    usesHostedSandbox,
    permissive: Boolean(opts.permissive),
    session,
    uiUrl,
    docsUrl,
    hasBridge,
    effectiveRemoteAccess,
    sessionToken,
    resolvedAi,
    ignoredGeminiKey,
    isWatchEnabled,
    logger,
  });

  const mcpUrl = hasBridge ? mount.mcpUrl(origin) : null;
  const workerInit = workerInitPayload(hosted?.projectKey, owners, mount?.instanceId, sessionToken);
  return {
    handle,
    publicDir,
    payload,
    uiUrl,
    mcpUrl,
    persist: persistSummary,
    beaconCount,
    beaconToken,
    sessionToken,
    instanceId: mount?.instanceId,
    workerInit,
    get hostedSandbox() {
      return hostedSandboxCapture?.get() ?? null;
    },
  };
}
