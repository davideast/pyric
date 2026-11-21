import { stampHostedTarget } from './runtime/hosted-target.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { AppPorts } from './app-ports.js';
import {
  effectiveRequestScheme,
  isAdmittedPeer,
  isLoopbackHostHeader,
  isTrustedProxyPeer,
  parseAllowPeersSetting,
  parseTrustProxySetting,
  type RemoteAccessOptions,
} from './guard-policy.js';
import { parseHostHeader } from './host-pattern.js';
import {
  appendSetCookieHeader,
  canBootstrapHtmlSession,
  formatSessionCookie,
  getHeader,
  isAllowedHost,
  isAllowedOriginOnPorts,
  isAllowedSessionToken,
  isLocalPeer,
} from './loopback-guard.js';
import {
  contentTypeFor,
  decodeStaticPathname,
  pipeFileToResponse,
  resolveStaticFile,
  resolveStaticPath,
} from './server.js';

interface StudioRoutesManifest {
  routes: string[];
}

interface RequestWithOriginalUrl extends IncomingMessage {
  originalUrl?: string;
}

const SITE_TREE_MOUNT_PATH = '/__pyric/ui';
const SITE_TREE_DESCENDANT_PREFIX = `${SITE_TREE_MOUNT_PATH}/`;

function studioRoutesFromSite(root: string): ReadonlySet<string> {
  const manifestPath = join(root, 'studio-routes.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as StudioRoutesManifest;
  if (!Array.isArray(parsed.routes) || parsed.routes.some((route) => typeof route !== 'string')) {
    throw new Error(`pyric: invalid Studio route manifest at ${manifestPath}`);
  }
  return new Set(parsed.routes);
}

function rawRequestPathname(request: RequestWithOriginalUrl, parsedUrl: URL): string {
  let requestTarget = request.originalUrl;

  if (requestTarget === undefined) {
    requestTarget = request.url;
  }

  if (requestTarget === undefined) {
    return parsedUrl.pathname;
  }

  const queryStringStart = requestTarget.indexOf('?');

  if (queryStringStart === -1) {
    return requestTarget;
  }

  return requestTarget.slice(0, queryStringStart);
}

/** The raw query string (with its `?`), or `''`. A redirect has to carry it:
 *  Studio reads its deep link out of the query, and dropping it on the way to
 *  the trailing-slash form loses the tab the link named. */
function rawRequestSearch(request: RequestWithOriginalUrl, parsedUrl: URL): string {
  const requestTarget = request.originalUrl ?? request.url;

  if (requestTarget === undefined) {
    return parsedUrl.search;
  }

  const queryStringStart = requestTarget.indexOf('?');

  if (queryStringStart === -1) {
    return '';
  }

  return requestTarget.slice(queryStringStart);
}

function isSiteTreePath(pathname: string): boolean {
  if (pathname === SITE_TREE_MOUNT_PATH) {
    return true;
  }

  return pathname.startsWith(SITE_TREE_DESCENDANT_PREFIX);
}

function withWorkerVersion(html: string, workerVersion: string | undefined): string {
  if (!workerVersion || html.includes('name="pyric-worker-v"')) return html;
  if (!/^[a-f0-9]{16}$/.test(workerVersion)) {
    throw new Error(`pyric: invalid SharedWorker epoch '${workerVersion}'`);
  }
  const meta = `<meta name="pyric-worker-v" content="${workerVersion}" data-pyric-serve>`;
  const head = html.match(/<head[^>]*>/i);
  if (!head || head.index === undefined) return meta + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + meta + html.slice(at);
}

/** Serve the one Astro tree with SPA fallback limited to generated Studio entries. */
export function createSiteTreeHandler(
  root: string,
  workerVersion?: string,
  hostedProjectKey?: string,
  sessionToken?: string,
  boundHost?: string,
  appPorts?: AppPorts,
  allowedHosts?: string[],
  requireSessionToken?: boolean,
  remoteAccess?: RemoteAccessOptions,
) {
  const studioRoutes = studioRoutesFromSite(root);
  const allowPeers = parseAllowPeersSetting(remoteAccess?.allowPeers);
  const trustProxy = parseTrustProxySetting(remoteAccess?.trustProxy);
  const remoteAccessEnabled = remoteAccess !== undefined;
  const mergedAllowedHosts: string[] = [];
  for (const host of allowedHosts ?? []) {
    if (!mergedAllowedHosts.includes(host)) mergedAllowedHosts.push(host);
  }
  for (const host of remoteAccess?.allowedHosts ?? []) {
    if (!mergedAllowedHosts.includes(host)) mergedAllowedHosts.push(host);
  }

  return (
    req: RequestWithOriginalUrl,
    res: ServerResponse,
    url: URL,
  ): boolean => {
    const rawPathname = rawRequestPathname(req, url);
    const isOutsideSite = !isSiteTreePath(rawPathname);
    if (isOutsideSite) {
      return false;
    }
    const effectiveBoundHost = boundHost ?? 'localhost';
    const hasPeerContext =
      req.socket !== undefined || getHeader(req, 'x-pyric-remote-peer') !== undefined;
    const peerLocal = !hasPeerContext || isLocalPeer(req);
    const peerRemote = hasPeerContext && !peerLocal;
    if (peerRemote && !isAdmittedPeer(req, { allowPeers })) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(
        'Forbidden: local loopback route',
      );
      return true;
    }
    const authenticated = isAllowedSessionToken(req, url, sessionToken);
    const requiresToken = requireSessionToken === true;
    const hostHeader = getHeader(req, 'host');
    const originHeader = getHeader(req, 'origin');
    const effectiveScheme = effectiveRequestScheme(req, trustProxy);
    const isLocalHost = isAllowedHost(hostHeader, effectiveBoundHost, []);
    const isExtraHost =
      !isLocalHost && isAllowedHost(hostHeader, effectiveBoundHost, mergedAllowedHosts);
    if (!isLocalHost && !isExtraHost) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(
        'Forbidden: invalid host or origin',
      );
      return true;
    }
    if (isExtraHost && !remoteAccessEnabled && !(requiresToken && authenticated)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(
        'Forbidden: invalid host or origin',
      );
      return true;
    }
    const basePorts = appPorts?.forRequest(req);
    const ports: number[] = [];
    if (basePorts !== undefined) {
      for (const port of basePorts) ports.push(port);
    } else if (req.socket?.localPort !== undefined) {
      ports.push(req.socket.localPort);
    }
    if (isTrustedProxyPeer(req, trustProxy) && hostHeader !== undefined) {
      const parsedHost = parseHostHeader(hostHeader);
      if (parsedHost?.port !== undefined && !ports.includes(parsedHost.port)) {
        ports.push(parsedHost.port);
      }
    }
    const originPorts = ports.length > 0 ? ports : undefined;
    const originAllowedHosts = isExtraHost ? mergedAllowedHosts : [];
    if (
      !isAllowedOriginOnPorts(
        originHeader,
        effectiveBoundHost,
        originAllowedHosts,
        originPorts,
        effectiveScheme,
      )
    ) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(
        'Forbidden: invalid host or origin',
      );
      return true;
    }
    const secFetchSite = getHeader(req, 'sec-fetch-site')?.trim().toLowerCase();
    const secFetchMode = getHeader(req, 'sec-fetch-mode')?.trim().toLowerCase();
    if (
      (secFetchSite === 'cross-site' || secFetchSite === 'same-site') &&
      secFetchMode !== 'navigate'
    ) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(
        'Forbidden: cross-site request rejected',
      );
      return true;
    }
    const isRemoteRequest = peerRemote || !isLoopbackHostHeader(hostHeader);
    if (isRemoteRequest && !authenticated) {
      if (remoteAccessEnabled && remoteAccess?.browserUnlock !== false) {
        const nextParam = encodeURIComponent(`${rawPathname}${rawRequestSearch(req, url)}`);
        res.writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        }).end(
          `pyric: session unlock required. Open /__pyric/unlock?next=${nextParam} to pair this browser.`,
        );
        return true;
      }
      res.writeHead(401, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      }).end('Unauthorized: invalid session capability token');
      return true;
    }
    const rawSearch = rawRequestSearch(req, url);
    const isMountRoot = rawPathname === SITE_TREE_MOUNT_PATH;
    if (isMountRoot) {
      res.writeHead(301, { location: `${SITE_TREE_DESCENDANT_PREFIX}${rawSearch}` }).end();
      return true;
    }

    let relativePath = rawPathname.slice(SITE_TREE_MOUNT_PATH.length);

    const hasNoRelativePath = relativePath === '';
    if (hasNoRelativePath) {
      relativePath = '/';
    }

    const decodedRel = decodeStaticPathname(relativePath);
    const invalidPath = decodedRel === null || decodedRel.includes('\\');
    if (invalidPath) {
      res.writeHead(404).end('not found');
      return true;
    }
    const decodedSegments = decodedRel.split('/').filter(Boolean);
    const containsTraversal = decodedSegments.some((segment) => segment === '.' || segment === '..');
    if (containsTraversal) {
      res.writeHead(404).end('not found');
      return true;
    }
    const mayBeDirectory = !relativePath.endsWith('/') && extname(relativePath) === '';
    if (mayBeDirectory) {
      const dir = resolveStaticPath(root, relativePath);
      const isDirectory = dir !== null && existsSync(dir) && statSync(dir).isDirectory();
      if (isDirectory) {
        res.writeHead(301, { location: `${rawPathname}/${rawSearch}` }).end();
        return true;
      }
    }

    const first = decodedSegments[0];
    const studioRequest = first === undefined || studioRoutes.has(first);
    let file = resolveStaticFile(root, relativePath);
    // Storage object names commonly contain extensions (logo.png), while the
    // other Studio routes reserve extension-bearing misses for static assets.
    const allowsDottedState = first === 'storage';
    const hasDottedStateSegment = decodedSegments
      .slice(1)
      .some((segment) => segment.includes('.'));
    const allowsSpaFallback = !file && studioRequest && (allowsDottedState || !hasDottedStateSegment);
    if (allowsSpaFallback) {
      const isSiteRoot = first === undefined;
      const entry = isSiteRoot ? '/index.html' : `/${first}/index.html`;
      file = resolveStaticFile(root, entry);
    }
    const resolvedFile = file;
    const isMissingFile = resolvedFile === null;
    if (isMissingFile) {
      res.writeHead(404).end('not found');
      return true;
    }

    const contentType = contentTypeFor(resolvedFile);
    const isStudioHtml = studioRequest && contentType.includes('text/html');
    const canBootstrap =
      isStudioHtml &&
      canBootstrapHtmlSession(req, effectiveBoundHost, appPorts?.forRequest(req));
    if (requiresToken && !authenticated && !canBootstrap) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized: invalid session capability token');
      return true;
    }
    if (canBootstrap && sessionToken) {
      appendSetCookieHeader(res, formatSessionCookie(sessionToken), { effectiveScheme });
    }
    const responseHeaders: Record<string, string> = {
      'content-type': contentType,
      'cache-control': 'no-store',
    };
    if (isStudioHtml) {
      responseHeaders['x-frame-options'] = 'SAMEORIGIN';
    }
    res.writeHead(200, responseHeaders);
    if (isStudioHtml) {
      const canStampIdentity = canBootstrap || authenticated;
      const stampProject = canStampIdentity ? hostedProjectKey : undefined;
      const stampToken = canBootstrap ? sessionToken : undefined;
      const stampOptions = hostedProjectKey !== undefined ? { hosted: true } : undefined;
      res.end(
        stampHostedTarget(
          withWorkerVersion(readFileSync(resolvedFile, 'utf8'), workerVersion),
          stampProject,
          undefined,
          undefined,
          stampToken,
          stampOptions,
        ),
      );
    } else {
      pipeFileToResponse(resolvedFile, res);
    }
    return true;
  };
}
