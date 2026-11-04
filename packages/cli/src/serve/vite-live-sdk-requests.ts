/**
 * Under open live rows, the page's requests for an installed SDK file the
 * rows loaded. A browser keys its module map by URL, so the same file under
 * another URL is a second, unwrapped copy of the SDK: page code that reads a
 * loaded SDK URL back (from `performance.getEntriesByType('resource')`) and
 * imports it with an extra query gets the raw module, which can open what
 * the rows refuse, such as a named database. Vite drops some queries (`t=`)
 * before its plugins see the request, so the check runs here, ahead of
 * Vite's own middleware, on the URL the browser sent.
 *
 * A request for one of those files passes only at a URL Vite itself wrote
 * into an importer, compared raw. Vite records each one in the client
 * module graph when it rewrites the importer's imports, before the importer
 * reaches the browser: the path, the `?v=` hash that importer was given, and
 * `t=` once the file has an HMR timestamp. Reading the URLs back from there,
 * rather than rebuilding them from the optimizer's current hash, keeps the
 * gate right when Vite reruns the optimizer without a reload and keeps the
 * hash it already wrote. Every other URL for the file gets a module that
 * throws the rows' refusal.
 *
 * The exact URL the rows loaded never reaches the dev server again: the
 * browser answers it from its module map. Nor does a fragment, which the
 * browser keeps to itself. Both are known limits of live mode, documented
 * on its page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { packageNameOf } from '../register/package-identity.js';
import { stopModule, stopModuleExports } from './vite-ssr-routing.js';
import { realFileUrlOf, type SuppliedRows } from './vite-supplied-rows.js';

const FS_PREFIX = '/@fs/';
const ORIGIN = 'http://request.invalid';

type Next = (error?: unknown) => void;
type GateServer = Pick<ViteDevServer, 'config' | 'middlewares'>;

/** The parts of a Vite module node the gate reads. */
interface GraphNode {
  readonly url?: unknown;
  readonly lastHMRTimestamp?: unknown;
}

/** The parts of a Vite client module graph the gate reads: Vite 5's `server.moduleGraph`, or Vite 6's client environment's. */
interface ClientGraph {
  readonly urlToModuleMap?: ReadonlyMap<string, GraphNode>;
  getModulesByFile?(file: string): ReadonlySet<GraphNode> | undefined;
}

function clientGraphOf(server: GateServer): ClientGraph | null {
  const shaped = server as unknown as { environments?: { client?: { moduleGraph?: ClientGraph } }; moduleGraph?: ClientGraph };
  return shaped.environments?.client?.moduleGraph ?? shaped.moduleGraph ?? null;
}

/** Vite's `base` as a path with a trailing slash. */
function basePrefix(base: string): string {
  return new URL(base, 'http://base.invalid').pathname.replace(/\/?$/, '/');
}

/** The pathname below Vite's `base`, decoded, to find the file it opens; null when it does not decode. */
function servedPathname(url: URL, base: string): string | null {
  const prefix = basePrefix(base);
  const isUnderBase = url.pathname.startsWith(prefix);
  const pathname = isUnderBase ? `/${url.pathname.slice(prefix.length)}` : url.pathname;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/** The file a served pathname opens: an `/@fs/` path names it, any other is under the root. */
function fileOf(pathname: string, root: string): string {
  const isFsPath = pathname.startsWith(FS_PREFIX);
  return isFsPath ? pathname.slice(FS_PREFIX.length - 1) : path.join(root, pathname);
}

/** A module graph URL as the browser requests it: under `base`, spelled by the WHATWG parser, nothing decoded. */
function requestSpelling(graphUrl: string, base: string): string {
  const parsed = new URL(`${basePrefix(base)}${graphUrl.replace(/^\//, '')}`, ORIGIN);
  return `${parsed.pathname}${parsed.search}`;
}

/** A graph URL with the `t=` Vite puts first in the query of a file with an HMR timestamp. */
function withTimestamp(graphUrl: string, timestamp: number): string {
  const [pathname, query] = graphUrl.split('?', 2);
  return `${pathname}?t=${timestamp}${query === undefined ? '' : `&${query}`}`;
}

/** The graph URLs one module node is written under: its own, with `t=` too once it has an HMR timestamp. */
function nodeUrls(graphUrl: string, node: GraphNode): string[] {
  const timestamp = node.lastHMRTimestamp;
  const hasTimestamp = typeof timestamp === 'number' && timestamp > 0;
  return hasTimestamp ? [graphUrl, withTimestamp(graphUrl, timestamp)] : [graphUrl];
}

/** Every URL Vite wrote for `realFile` into an importer, as the browser requests it. */
function writtenUrlsOf(server: GateServer, realFile: string): Set<string> {
  const graph = clientGraphOf(server);
  const nodes = graph?.getModulesByFile?.(realFile) ?? new Set<GraphNode>();
  const graphUrls: Array<[string, GraphNode]> = [];
  for (const node of nodes) {
    if (typeof node.url === 'string') graphUrls.push([node.url, node]);
  }
  for (const [url, node] of graph?.urlToModuleMap ?? new Map<string, GraphNode>()) {
    if (nodes.has(node)) graphUrls.push([url, node]);
  }
  const base = server.config.base ?? '/';
  return new Set(graphUrls.flatMap(([url, node]) => nodeUrls(url, node).map((each) => requestSpelling(each, base))));
}

/**
 * The real file URL of a loaded SDK file this request names under a URL Vite
 * did not write, or null. The request's raw pathname and query must equal a
 * written URL exactly: Vite normalizes `?v=x&`, `?%76=x` and an encoded path
 * back to the file, while the browser keys each as its own module.
 */
function unwrittenSdkFile(server: GateServer, supplied: SuppliedRows, rawUrl: string | undefined): string | null {
  if (rawUrl === undefined || supplied.package() === null) return null;
  const url = new URL(rawUrl, ORIGIN);
  const pathname = servedPathname(url, server.config.base ?? '/');
  if (pathname === null) return null;
  const real = realFileUrlOf(fileOf(pathname, server.config.root));
  const isLoadedSdkFile = real !== null && supplied.liveSdkUrls.has(real);
  if (!isLoadedSdkFile) return null;
  const isWritten = writtenUrlsOf(server, fileURLToPath(real)).has(`${url.pathname}${url.search}`);
  return isWritten ? null : real;
}

/** The refusal for a second copy of `real`, in the words of the rows' own refusal of its package. */
function secondCopyRefusal(supplied: SuppliedRows, real: string, rawUrl: string): Error {
  const name = packageNameOf(real) ?? fileURLToPath(real);
  const refusal = supplied.refusal(name, 'page');
  const route = `This page imported ${rawUrl}, the installed SDK file the live rows loaded, under another URL, ` +
    "which gives the page a second copy of the SDK without the live rows' wrapper, so pyric would not see its calls.";
  return Object.assign(new Error(`${refusal.message} ${route}`), { code: (refusal as { code?: unknown }).code });
}

async function answerRefusal(response: ServerResponse, supplied: SuppliedRows, real: string, rawUrl: string): Promise<void> {
  const file = fileURLToPath(real);
  const source = stopModule(secondCopyRefusal(supplied, real, rawUrl), await stopModuleExports(file, path.dirname(file)));
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/javascript');
  response.setHeader('Cache-Control', 'no-store');
  response.end(source);
}

/** Installs the check ahead of Vite's own middleware. */
export function attachLiveSdkRequestGate(server: GateServer, supplied: SuppliedRows): void {
  server.middlewares.use((request: IncomingMessage, response: ServerResponse, next: Next) => {
    const rawUrl = request.url;
    const real = unwrittenSdkFile(server, supplied, rawUrl);
    if (real === null || rawUrl === undefined) return next();
    answerRefusal(response, supplied, real, rawUrl).catch(next);
  });
}
