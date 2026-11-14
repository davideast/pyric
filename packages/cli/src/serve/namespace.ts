import { createDiagnostics } from './diagnostics.js';
import { DIAGNOSTICS_PATH } from './runtime/diagnostics-report.js';
import { handleRateCaptures } from './rate-capture-route.js';
import { handleThresholdConfig } from './threshold-config-route.js';
/**
 * The `/__pyric/` reserved namespace -- pyric's analog of firebase serve's
 * `/__/firebase/` namespace:
 *
 *   /__pyric/sdk/<file>.js   the bundled SDK files (import-map targets +
 *                            the injected init script + shared chunks)
 *   /__pyric/init.json       the page init payload (rules, bridge URL) --
 *                            fetched by the runtime chunk at module init
 *   /__pyric/beacon          the handshake beacon a pyric-launched child
 *                            POSTs once its interception is installed
 *   /__pyric/assets/avatar/<uid>
 *                            the image behind a sandbox user's photoURL,
 *                            mounted only when an avatar resolver is wired
 *
 * Bridge routes (`/__pyric/mcp`, `/__pyric/sandbox`) mount here in P2.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { handleIndexConfig } from './index-config-route.js';
import type { StateStore } from './state-store.js';
import { createWriterLock } from './writer-lock.js';
import { createStudioRoutes, type StudioRouteOptions } from './studio/index.js';
import { registerSessionTokenRequirement } from './local-session-token.js';
import {
  appendSetCookieHeader,
  formatSessionCookie,
  isAllowedSessionToken,
  isLocalPeer,
  pipeFileToResponse,
  type ServeLogger,
} from './server.js';
import {
  canBootstrapSdkSession,
  guardAvatarLoopback,
  guardLoopback,
  guardSdkRequest,
  remotePeerInitPayload,
  unauthenticatedInitPayload,
} from './namespace-guards.js';
import type { InitPayload } from './init-payload.js';
import type { AppPorts } from './app-ports.js';
import { handleActivity } from './activity-route.js';
import { handleAiProxy, AI_PROXY_ROUTE } from './ai-proxy.js';
import { createGeminiProxy, isGeminiProxyPath, type GeminiProxyConfig } from './gemini-proxy.js';
import { createSiteTreeHandler } from './site-tree.js';
import { handleAvatar } from './assets/avatar-route.js';
import { ASSETS_ROUTE_PREFIX } from './assets/avatar-url.js';
import type { AssetResolver } from './assets/resolver.js';
import { BEACON_PATH, type BeaconReport } from '../register/beacon.js';
import { handleBeacon } from './beacon-route.js';
import { createEventHub, type ServeEventHub } from './event-hub.js';
import {
  createDenialThrottle,
  DENIAL_BODY_LIMIT_BYTES,
  formatDenialBlock,
  handleDenials,
  noteAiDiagnostic,
  type DenialThrottle,
} from './denial-route.js';
import {
  handleCapture,
  handleState,
  handleStateObject,
  STATE_OBJECTS_PREFIX,
} from './state-capture-route.js';

export type { InitPayload } from './init-payload.js';
export { createEventHub, type ServeEventHub };
export {
  createDenialThrottle,
  DENIAL_BODY_LIMIT_BYTES,
  formatDenialBlock,
  noteAiDiagnostic,
  type DenialThrottle,
};

export interface NamespaceOptions {
  rateCaptures?: import('./rate-capture-store.js').RateCaptureStore;
  indexes?: import('./index-config-store.js').IndexConfigStore;
  thresholds?: import('./threshold-config-store.js').ThresholdConfigStore;
  /** The bundle output dir (`BundleResult.outDir`). */
  sdkDir: string;
  /** Producer for `/__pyric/init.json` -- a function so hot-reload serves
   *  the latest rules without server restart. */
  initPayload: () => InitPayload;
  /** Hot-reload channel; serves `/__pyric/events` when present. */
  events?: ServeEventHub;
  /** Default-on Firebase Activity Guard sink. The served worker posts bounded,
   *  deduplicated incidents here so the host can surface them in its terminal. */
  activity?: (incident: ActivityIncident) => void;
  /** Mounts the state channel for browser mirroring or hosted inspection. */
  state?: StateStore;
  /** Hosted state can be read here; its runtime owns all writes. */
  stateOwner?: 'browser' | 'host';
  persistenceStatus?: () => import('./hosted/persistence/commits.js').PersistenceStatus;
  /** `--capture`: mounts GET/POST /__pyric/capture. */
  capture?: { write(json: string): void; read(): string | null };
  /** Resolves the image behind a sandbox user's `photoURL`; mounts
   *  `GET /__pyric/assets/avatar/<uid>`. */
  avatars?: AssetResolver;
  /** Unified Astro documentation + Studio tree, built for `/__pyric/ui/`. */
  siteUiDir?: string;
  /** Served SharedWorker epoch stamped only into Studio entry documents. */
  workerVersion?: string;
  /** `--ui` (Pyric Studio): mounts `/__pyric/workspace` + `/__pyric/projects`. */
  studio?: StudioRouteOptions;
  /** Per-boot session capability token required on workspace, project, and AI proxy endpoints (and all routes when `requireSessionToken` is true). */
  sessionToken?: string;
  /** Require `sessionToken` on every namespace route instead of only workspace/project and AI proxy routes. */
  requireSessionToken?: boolean;
  /** Bound host for DNS rebinding guard. */
  boundHost?: string;
  /** Extra allowed hostnames. */
  allowedHosts?: string[];
  /** Under `pyric sandbox`, the app's ports, including the port of a dev
   *  server that proxies `/__pyric/*` here (`withPyric` under `next dev`). */
  appPorts?: AppPorts;
  /** The OpenAI-compatible upstream `/__pyric/ai-proxy` forwards to. */
  aiProxyUpstream?: string;
  /** The gemini engine `/__pyric/ai-proxy/gemini` sends for a browser engine. */
  aiGemini?: GeminiProxyConfig;
  /** Receives one handshake beacon per pyric-launched child (`POST /__pyric/beacon`). */
  beacon?: (report: BeaconReport) => void;
  /** The per-launch secret a beacon must present in `x-pyric-beacon-token`. */
  beaconToken?: string;
  /** Where hot-reload/diagnostic lines print. */
  logger?: ServeLogger;
}

export type PyricNamespaceHandler = ((
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => boolean | Promise<boolean>) & {
  readonly sessionToken: string;
};

export function createPyricNamespace(opts: NamespaceOptions): PyricNamespaceHandler {
  const diagnostics = createDiagnostics(
    () => (opts.initPayload().hosted ? 'hosted' : 'browser'),
    opts.persistenceStatus,
  );
  const stateWriterLock = createWriterLock();
  const hostOwnsState = opts.stateOwner === 'host';
  const studioWriterLock = opts.studio?.writerLock ?? createWriterLock();
  const sessionToken = opts.sessionToken ?? randomBytes(24).toString('base64url');
  // Fail closed: with no launcher-supplied secret the generated one is held by
  // nobody, so `/__pyric/beacon` accepts nothing rather than everything.
  const beaconToken = opts.beaconToken ?? randomBytes(24).toString('base64url');
  let studioRoutes: ((req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>) | null = null;
  const studio = opts.studio;
  const hasStudio = studio !== undefined;
  if (hasStudio) {
    const studioOptions: StudioRouteOptions = {
      ...studio,
      sessionToken,
      writerLock: studioWriterLock,
      boundHost: opts.boundHost,
      allowedHosts: opts.allowedHosts,
      appPorts: opts.appPorts,
    };
    studioRoutes = createStudioRoutes(studioOptions);
  }
  const requiresSessionToken = opts.requireSessionToken === true;
  registerSessionTokenRequirement(sessionToken, requiresSessionToken);
  const siteUiDir = opts.siteUiDir;
  const hasSiteTree = siteUiDir !== undefined && siteUiDir.length > 0;
  let siteTree: ReturnType<typeof createSiteTreeHandler> | null = null;
  if (hasSiteTree) {
    siteTree = createSiteTreeHandler(
      siteUiDir,
      opts.workerVersion,
      hostedStudioProject(opts),
      sessionToken,
      opts.boundHost,
      opts.appPorts,
      opts.allowedHosts,
      requiresSessionToken,
    );
  }
  const denialThrottle = createDenialThrottle();
  const geminiProxy = createGeminiProxy(opts.aiGemini, denialThrottle, opts.logger);
  const activityEndpoint = buildActivityEndpoint(opts.activity);
  const handler = (req: IncomingMessage, res: ServerResponse, url: URL): boolean | Promise<boolean> => {
    const isDiagnostics = url.pathname === DIAGNOSTICS_PATH;
    if (isDiagnostics) {
      const refused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (refused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      return diagnostics(req, res).then(() => true);
    }
    const thresholds = opts.thresholds;
    const isThresholdRequest = thresholds !== undefined && url.pathname === '/__pyric/thresholds';
    if (isThresholdRequest) {
      const hostRefused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (hostRefused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: 'The local session has changed. Reload to reconnect.' }),
        );
        return true;
      }
      return handleThresholdConfig(thresholds, req, res);
    }
    const indexes = opts.indexes;
    const isIndexRequest = indexes !== undefined && url.pathname === '/__pyric/indexes';
    if (isIndexRequest) {
      const hostRefused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (hostRefused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: 'The local session has changed. Reload to reconnect.' }),
        );
        return true;
      }
      return handleIndexConfig(indexes, req, res);
    }
    const routes = studioRoutes;
    const hasStudioRoutes = routes !== null;
    if (hasStudioRoutes) {
      const isStudioRequest =
        url.pathname.startsWith('/__pyric/workspace') || url.pathname.startsWith('/__pyric/projects');
      if (isStudioRequest) {
        const hostRefused = !guardLoopback(req, res, opts, true);
        if (hostRefused) return true;
        return routes(req, res, url);
      }
    }
    const state = opts.state;
    const isObjectRequest = state !== undefined && url.pathname.startsWith(STATE_OBJECTS_PREFIX);
    if (isObjectRequest) {
      const hostRefused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (hostRefused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      handleStateObject(state, req, res, url);
      return true;
    }
    const isStateRequest = state !== undefined && url.pathname === '/__pyric/state';
    if (isStateRequest) {
      const hostRefused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (hostRefused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      const isRead = req.method === 'GET';
      const conflictsWithHost = hostOwnsState && !isRead;
      if (conflictsWithHost) {
        res.writeHead(423, { 'content-type': 'text/plain' }).end(
          'The hosted sandbox owns this state. Use its SDK, CLI or MCP interface to change data.',
        );
        return true;
      }
      return handleState(state, stateWriterLock, req, res, url).then(() => true);
    }
    const rateCaptures = opts.rateCaptures;
    const isRateCaptureRequest = rateCaptures !== undefined && url.pathname === '/__pyric/rate-captures';
    if (isRateCaptureRequest) {
      const hostRefused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (hostRefused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401).end('Unauthorized');
        return true;
      }
      return handleRateCaptures(rateCaptures, req, res, url);
    }
    const capture = opts.capture;
    const isCaptureRequest = capture !== undefined && url.pathname === '/__pyric/capture';
    if (isCaptureRequest) {
      const hostRefused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (hostRefused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      return handleCapture(capture, req, res).then(() => true);
    }
    const isActivityRequest = activityEndpoint !== undefined && url.pathname === '/__pyric/activity';
    if (isActivityRequest) {
      return handleActivity(activityEndpoint.sink, req, res, activityEndpoint.token).then(() => true);
    }
    const events = opts.events;
    const isEventsRequest = events !== undefined && url.pathname === '/__pyric/events';
    if (isEventsRequest) {
      const hostRefused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (hostRefused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      events.handle(req, res);
      return true;
    }
    const isGeminiProxyRequest = isGeminiProxyPath(url.pathname);
    if (isGeminiProxyRequest) {
      const hostRefused = !guardLoopback(req, res, opts, true);
      if (hostRefused) return true;
      if (!isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      return geminiProxy(req, res, url).then(() => true);
    }
    const isAiProxyRequest = url.pathname === AI_PROXY_ROUTE || url.pathname.startsWith(`${AI_PROXY_ROUTE}/`);
    if (isAiProxyRequest) {
      const hostRefused = !guardLoopback(req, res, opts, true);
      if (hostRefused) return true;
      if (!isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      return handleAiProxy(opts.aiProxyUpstream, denialThrottle, req, res, url, opts.logger).then(
        () => true,
      );
    }
    const isBeaconRequest = url.pathname === BEACON_PATH;
    if (isBeaconRequest) {
      return handleBeacon({ token: beaconToken, onBeacon: opts.beacon }, req, res).then(() => true);
    }
    const isDenialRequest = url.pathname === '/__pyric/denials';
    if (isDenialRequest) {
      const hostRefused = !guardLoopback(req, res, opts, requiresSessionToken);
      if (hostRefused) return true;
      if (requiresSessionToken && !isAllowedSessionToken(req, url, sessionToken)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
        return true;
      }
      return handleDenials(denialThrottle, opts.logger, req, res).then(() => true);
    }
    const isInitRequest = url.pathname === '/__pyric/init.json';
    if (isInitRequest) {
      const isRemotePeer = !isLocalPeer(req);
      const authenticated = !isRemotePeer && isAllowedSessionToken(req, url, sessionToken);
      if (!isRemotePeer && !guardLoopback(req, res, opts, authenticated)) return true;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('method not allowed');
        return true;
      }
      const isHead = req.method === 'HEAD';
      if (isRemotePeer) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(isHead ? undefined : JSON.stringify(remotePeerInitPayload(opts.initPayload())));
        return true;
      }
      const raw = opts.initPayload();
      if (!authenticated) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        if (requiresSessionToken) {
          res.end(isHead ? undefined : JSON.stringify(unauthenticatedInitPayload(raw)));
          return true;
        }
        const { sessionToken: _omitSessionToken, ...sandboxRaw } = raw;
        const sandboxPayload: Record<string, unknown> = {
          ...sandboxRaw,
          thresholds: Boolean(opts.thresholds),
          rateCaptures: Boolean(opts.rateCaptures),
        };
        if (activityEndpoint !== undefined) {
          sandboxPayload.activityToken = activityEndpoint.token;
        }
        res.end(isHead ? undefined : JSON.stringify(sandboxPayload));
        return true;
      }
      appendSetCookieHeader(res, formatSessionCookie(sessionToken));
      const payload = {
        ...raw,
        sessionToken,
        thresholds: Boolean(opts.thresholds),
        rateCaptures: Boolean(opts.rateCaptures),
      };
      if (activityEndpoint !== undefined) payload.activityToken = activityEndpoint.token;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(isHead ? undefined : JSON.stringify(payload));
      return true;
    }
    const avatars = opts.avatars;
    const isAvatarRequest = avatars !== undefined && url.pathname.startsWith(ASSETS_ROUTE_PREFIX);
    if (isAvatarRequest) {
      if (!guardAvatarLoopback(req, res, opts)) return true;
      return handleAvatar(avatars, req, res, url).then(() => true);
    }
    const isSdkRequest = url.pathname.startsWith('/__pyric/sdk/');
    if (isSdkRequest) {
      if (!guardSdkRequest(req, res, opts)) return true;
      const file = join(opts.sdkDir, basename(url.pathname));
      const missingFile = !existsSync(file);
      if (missingFile) {
        const isRealSdk = basename(url.pathname).startsWith('firebase-sdk-');
        let body = 'not found';
        if (isRealSdk) {
          body =
            'pyric sandbox: the Firebase SDK was not built. Install firebase where pyric starts (production AI mode).';
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(body);
        return true;
      }
      const isSourceMap = file.endsWith('.map');
      const type = isSourceMap ? 'application/json' : 'text/javascript; charset=utf-8';
      if (canBootstrapSdkSession(req, opts)) {
        appendSetCookieHeader(res, formatSessionCookie(sessionToken));
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      pipeFileToResponse(file, res);
      return true;
    }
    const servedSiteFile = siteTree?.(req, res, url) ?? false;
    if (servedSiteFile) return true;
    const requestsStudio = url.pathname === '/__pyric/ui' || url.pathname.startsWith('/__pyric/ui/');
    const hasMissingStudioAssets = opts.studio !== undefined && !siteTree && requestsStudio;
    if (hasMissingStudioAssets) {
      const authenticated = isAllowedSessionToken(req, url, sessionToken);
      if (!guardLoopback(req, res, opts, authenticated)) return true;
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Studio is unavailable</title></head><body><main><h1>Studio is unavailable</h1><p>The Studio assets are missing from this Pyric installation.</p><p>In a source checkout, run the full build with <code>bash scripts/build.sh</code>. Otherwise, reinstall <code>@pyric/cli</code>. Restart the development server afterward.</p><a href="/">Return to app</a></main></body></html>',
      );
      return true;
    }
    return false; // unknown /__pyric/* -> caller 404s
  };
  return Object.assign(handler, { sessionToken });
}

function buildActivityEndpoint(
  activity: ((incident: ActivityIncident) => void) | undefined,
): { sink: (incident: ActivityIncident) => void; token: string } | undefined {
  if (activity === undefined) return undefined;
  return { sink: activity, token: randomBytes(24).toString('base64url') };
}

function hostedStudioProject(options: NamespaceOptions): string | undefined {
  const payload = options.initPayload();
  const isHosted = payload.hosted === true;
  const isBrowserHosted = !isHosted;
  if (isBrowserHosted) return undefined;
  const projectKey = payload.projectKey;
  const missingIdentity = typeof projectKey !== 'string' || projectKey.length === 0;
  if (missingIdentity) throw new Error('Hosted Studio requires a project identity.');
  return projectKey;
}
