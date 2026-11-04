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
 * A request for one of those files passes only at the URL Vite itself
 * writes into its importers: the path Vite names the real file by, under
 * the root or `/@fs/`, with the optimizer's `?v=` hash and nothing else.
 * Every other URL for it gets a module that throws the rows' refusal.
 *
 * The exact URL the rows loaded never reaches the dev server again: the
 * browser answers it from its module map, so that route is a known limit of
 * live mode, documented on its page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { packageNameOf } from '../register/package-identity.js';
import { stopModule, stopModuleExports } from './vite-ssr-routing.js';
import { realFileUrlOf, type SuppliedRows } from './vite-supplied-rows.js';

const FS_PREFIX = '/@fs/';
const VERSION_PARAM = 'v';

type Next = (error?: unknown) => void;
type GateServer = Pick<ViteDevServer, 'config' | 'middlewares'>;

/** The optimizer hash Vite writes as `?v=` on each SDK file's URL, or null when this Vite does not say. */
function browserHashOf(server: GateServer): string | null {
  const shaped = server as unknown as {
    environments?: { client?: { depsOptimizer?: { metadata?: { browserHash?: unknown } } } };
    _depsOptimizer?: { metadata?: { browserHash?: unknown } };
  };
  const metadata = shaped.environments?.client?.depsOptimizer?.metadata ?? shaped._depsOptimizer?.metadata;
  const hash = metadata?.browserHash;
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

/** The pathname below Vite's `base`, decoded, or null when it does not decode. */
function servedPathname(url: URL, base: string): string | null {
  const prefix = new URL(base, 'http://base.invalid').pathname.replace(/\/?$/, '/');
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

/** The pathname Vite names a real file by: below the root, else under `/@fs/`. */
function vitePathnameOf(realFile: string, root: string): string {
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  const isUnderRoot = realFile.startsWith(rootPrefix);
  return isUnderRoot ? realFile.slice(root.length) : `${FS_PREFIX.slice(0, -1)}${realFile}`;
}

/** Whether a query is the one Vite writes on an SDK file's URL: `v=<hash>`, or any `v` when the hash is unknown. */
function isViteQuery(params: URLSearchParams, hash: string | null): boolean {
  const keys = [...params.keys()];
  const hasOnlyVersion = keys.every((key) => key === VERSION_PARAM);
  if (!hasOnlyVersion) return false;
  if (hash === null) return true;
  return keys.length === 1 && params.get(VERSION_PARAM) === hash;
}

/** The real file URL of a loaded SDK file this request names under a URL Vite did not write, or null. */
function unwrittenSdkFile(server: GateServer, supplied: SuppliedRows, rawUrl: string | undefined): string | null {
  if (rawUrl === undefined || supplied.package() === null) return null;
  const url = new URL(rawUrl, 'http://request.invalid');
  const pathname = servedPathname(url, server.config.base ?? '/');
  if (pathname === null) return null;
  const real = realFileUrlOf(fileOf(pathname, server.config.root));
  const isLoadedSdkFile = real !== null && supplied.liveSdkUrls.has(real);
  if (!isLoadedSdkFile) return null;
  const isVitePath = pathname === vitePathnameOf(fileURLToPath(real), server.config.root);
  const isWritten = isVitePath && isViteQuery(url.searchParams, browserHashOf(server));
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
