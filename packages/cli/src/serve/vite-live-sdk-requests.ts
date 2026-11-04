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
 * A request for one of those files passes only at the exact URL Vite itself
 * writes into its importers, compared raw: the path Vite names the real file
 * by, under the root or `/@fs/`, with the optimizer's `?v=` hash and nothing
 * else. Every other URL for it gets a module that throws the rows' refusal.
 *
 * The exact URL the rows loaded never reaches the dev server again: the
 * browser answers it from its module map. Nor does a fragment, which the
 * browser keeps to itself. Both are known limits of live mode, documented
 * on its page.
 */
import { readFileSync } from 'node:fs';
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

function hashFrom(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The hash the client optimizer's metadata file records: Vite 5 keeps its optimizer out of reach of the server object. */
function metadataFileHash(cacheDir: string | undefined): string | null {
  if (cacheDir === undefined) return null;
  try {
    const metadata = JSON.parse(readFileSync(path.join(cacheDir, 'deps', '_metadata.json'), 'utf8')) as { browserHash?: unknown };
    return hashFrom(metadata.browserHash);
  } catch {
    return null;
  }
}

/**
 * The optimizer hash Vite writes as `?v=` on each SDK file's URL: the client
 * environment's (Vite 6 and later), else the one the metadata file records
 * (Vite 5). Null when neither says, and then only the URL with no query passes.
 */
function browserHashOf(server: GateServer): string | null {
  const shaped = server as unknown as {
    environments?: { client?: { depsOptimizer?: { metadata?: { browserHash?: unknown } } } };
  };
  const inMemory = hashFrom(shaped.environments?.client?.depsOptimizer?.metadata?.browserHash);
  return inMemory ?? metadataFileHash(server.config.cacheDir);
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

/** The pathname Vite names a real file by: below the root, else under `/@fs/`. */
function vitePathnameOf(realFile: string, root: string): string {
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  const isUnderRoot = realFile.startsWith(rootPrefix);
  return isUnderRoot ? realFile.slice(root.length) : `${FS_PREFIX.slice(0, -1)}${realFile}`;
}

/**
 * The URL Vite writes for a real file, as the WHATWG parser spells it, with
 * nothing decoded: `base`, the file's Vite path, and `?v=<hash>` when the
 * optimizer has one.
 */
function writtenUrlOf(realFile: string, server: GateServer, hash: string | null): string {
  const pathname = `${basePrefix(server.config.base ?? '/')}${vitePathnameOf(realFile, server.config.root).slice(1)}`;
  const query = hash === null ? '' : `?${VERSION_PARAM}=${hash}`;
  const written = new URL(`${pathname}${query}`, 'http://request.invalid');
  return `${written.pathname}${written.search}`;
}

/**
 * The real file URL of a loaded SDK file this request names under a URL Vite
 * did not write, or null. The request's raw pathname and query must equal
 * the written URL exactly: Vite normalizes `?v=x&`, `?%76=x` and an encoded
 * path back to the file, while the browser keys each as its own module.
 */
function unwrittenSdkFile(server: GateServer, supplied: SuppliedRows, rawUrl: string | undefined): string | null {
  if (rawUrl === undefined || supplied.package() === null) return null;
  const url = new URL(rawUrl, 'http://request.invalid');
  const pathname = servedPathname(url, server.config.base ?? '/');
  if (pathname === null) return null;
  const real = realFileUrlOf(fileOf(pathname, server.config.root));
  const isLoadedSdkFile = real !== null && supplied.liveSdkUrls.has(real);
  if (!isLoadedSdkFile) return null;
  const written = writtenUrlOf(fileURLToPath(real), server, browserHashOf(server));
  const isWritten = `${url.pathname}${url.search}` === written;
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
