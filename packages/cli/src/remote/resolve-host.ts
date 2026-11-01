/**
 * Which host a Node process attaches to: an explicit url, a configured url
 * from `PYRIC_SANDBOX=remote:<url>` checked against this project's host, or
 * the project's running host found through `.pyric/serve.json`.
 *
 * Shared by the Node remote client (`connectRemoteSandbox`, which
 * `pyric-admin` uses) and the client SDK bootstrap that `@pyric/cli/register`
 * installs (#1082), so both pick the same host for the same process.
 *
 * Discovery reads the project's `.pyric/serve.json` and probes the port it
 * names, without the port scan `discoverServe` falls back to: a host found
 * only by the scan is never attached to (`selectProjectHost`), and on a
 * machine where closed ports never answer the scan takes seconds. A process
 * resolves again at each reconnect, so a scan there would spend the window
 * its held calls wait in (#1219).
 */
import {
  discoverServe,
  selectExplicitHost,
  selectProjectHost,
  type AnsweringHost,
  type Discovered,
} from '../serve/discovery.js';

export interface ResolveRemoteHostOptions {
  /** Project root for `.pyric/serve.json` discovery. */
  cwd: string;
  /** Explicit serve base URL; skips discovery. */
  url?: string;
  /** Serve base URL from configuration, which may be stale. Ignored when `url` is set. */
  configuredUrl?: string;
  /** Host identity the launcher that set `configuredUrl` pinned. */
  instanceId?: string;
  discover?: (cwd: string) => Promise<Discovered | null>;
  probe?: (url: string) => Promise<AnsweringHost | null>;
  /** Where the stale-URL fallback warning goes. Default: stderr. */
  warn?: (message: string) => void;
}

export interface ResolvedRemoteHost {
  /** The canonical url guidance names (`http://localhost:<port>` for the default host). */
  serveUrl: string;
  /** The loopback base the health probe reached; sockets dial it. */
  wsBase: string;
}

function hostError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** Explicit URLs whose stale-URL fallback this process has already reported. */
const reportedStaleUrls = new Set<string>();

function warnOncePerUrl(url: string, message: string, warn?: (message: string) => void): void {
  const key = url.replace(/\/$/, '');
  if (reportedStaleUrls.has(key)) return;
  reportedStaleUrls.add(key);
  if (warn) warn(message);
  else process.stderr.write(`${message}\n`);
}

/** The project's host as its `.pyric/serve.json` names it; no port scan. */
export function discoverProjectPointer(cwd: string): Promise<Discovered | null> {
  return discoverServe(cwd, () => {}, []);
}

async function resolveConfiguredHost(configuredUrl: string, options: ResolveRemoteHostOptions): Promise<ResolvedRemoteHost> {
  const choice = await selectExplicitHost({
    url: configuredUrl,
    cwd: options.cwd,
    launcherInstanceId: options.instanceId,
    discover: options.discover ?? discoverProjectPointer,
    probe: options.probe,
  });
  if (choice.kind === 'stale') throw hostError('not-found', choice.message);
  if (choice.kind === 'refused') throw hostError('failed-precondition', choice.message);
  if (choice.kind === 'project') {
    warnOncePerUrl(configuredUrl, `pyric: ${choice.notice}`, options.warn);
    return { serveUrl: choice.host.url, wsBase: choice.host.base };
  }
  return { serveUrl: choice.serveUrl, wsBase: choice.base };
}

async function discoverProjectHost(options: ResolveRemoteHostOptions): Promise<ResolvedRemoteHost> {
  const refused: string[] = [];
  const found = selectProjectHost(await (options.discover ?? discoverProjectPointer)(options.cwd), (m) => refused.push(m));
  const hasNoDiscovery = found === null;
  if (hasNoDiscovery) {
    throw hostError(
      'not-found',
      'no running `pyric sandbox --bridge` found (looked for .pyric/serve.json in ' +
        `${options.cwd}) — start your dev server with the bridge enabled and retry.` +
        (refused.length > 0 ? ` ${refused.join(' ')}` : ''),
    );
  }
  return { serveUrl: found.url, wsBase: found.base };
}

export async function resolveRemoteHost(options: ResolveRemoteHostOptions): Promise<ResolvedRemoteHost> {
  const requestedUrl = options.url;
  const hasExplicitUrl = requestedUrl !== undefined && requestedUrl.length > 0;
  if (hasExplicitUrl) {
    const serveUrl = requestedUrl.replace(/\/$/, '');
    return { serveUrl, wsBase: serveUrl };
  }
  const configuredUrl = options.configuredUrl;
  const hasConfiguredUrl = configuredUrl !== undefined && configuredUrl.length > 0;
  if (hasConfiguredUrl) return resolveConfiguredHost(configuredUrl, options);
  return discoverProjectHost(options);
}
