/**
 * Refuse a Vite dev server request whose file really is project state.
 *
 * Vite serves files under its root and follows symlinks, and
 * `server.fs.deny` matches the path a request names, not the file it opens.
 * So a symlink inside the root that points at `.pyric/state` or at `.env`
 * would hand those bytes out. This middleware runs before Vite's own: it
 * resolves the file a request names (under the root, the public directory, or
 * an `/@fs/` absolute path, each with or without the configured `base`) to its
 * real path, and answers 403 when that real path is inside `.pyric/` or is an
 * env file. A path it cannot decode is refused, because a later layer may
 * still normalize its way to a file this check never saw.
 */
import { realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative } from 'node:path';
import type { ViteDevServer } from 'vite';
import { isPyricStateOrEnvPath } from './project-secret-paths.js';
import { isPathInside } from './path-inside.js';

const FS_PREFIX = '/@fs/';

type Next = (error?: unknown) => void;

export interface ViteDenyScope {
  /** The Vite root and public directory: where a request path can open a file. */
  servedRoots: readonly string[];
  /** The Firebase project directory: its own path does not count against a file inside it. */
  containingRoots: readonly string[];
  /** Vite's `base`. */
  base: string;
}

/** The decoded pathname of a request URL, without its query or hash; null when it does not decode. */
function decodedPathname(rawUrl: string | undefined): string | null {
  const pathname = (rawUrl ?? '/').replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/** A `base` as a path with a trailing slash; a full URL contributes its pathname. */
function basePath(base: string): string {
  const pathname = new URL(base, 'http://base.invalid').pathname;
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

/** The path as named, and the path below `base` when it starts there. */
function withAndWithoutBase(pathname: string, base: string): string[] {
  const prefix = basePath(base);
  const isUnderBase = prefix !== '/' && pathname.startsWith(prefix);
  return isUnderBase ? [pathname, `/${pathname.slice(prefix.length)}`] : [pathname];
}

/** The files a path could open: an `/@fs/` path names one, any other is tried under each root. */
function candidateFiles(pathname: string, roots: readonly string[]): string[] {
  const isFsPath = pathname.startsWith(FS_PREFIX);
  if (isFsPath) return [pathname.slice(FS_PREFIX.length - 1)];
  return roots.map((root) => join(root, pathname));
}

function realPathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Inside a root, only the part below that root counts, so a project that lives
 * under a directory with a denied name still serves its own files. Outside
 * every root, as with a link to another project's state, the whole path counts.
 */
function isDeniedRealPath(realPath: string, realRoots: readonly string[]): boolean {
  const containing = realRoots.filter((root) => isPathInside(root, realPath));
  const isOutsideRoots = containing.length === 0;
  if (isOutsideRoots) return isPyricStateOrEnvPath(realPath);
  return containing.some((root) => isPyricStateOrEnvPath(relative(root, realPath)));
}

function refuse(res: ServerResponse, message: string): void {
  res.statusCode = 403;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}

/** Connect middleware; `scope` is read per request so a restarted server's config is used. */
export function viteRealPathDeny(scope: () => ViteDenyScope) {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const pathname = decodedPathname(req.url);
    const undecodable = pathname === null;
    if (undecodable) {
      refuse(res, 'pyric: this request path does not decode.');
      return;
    }
    const { servedRoots, containingRoots, base } = scope();
    const realRoots = [...servedRoots, ...containingRoots].map((root) => realPathOf(root) ?? root);
    const paths = withAndWithoutBase(pathname, base);
    const realFiles = paths.flatMap((path) => candidateFiles(path, servedRoots)).map(realPathOf);
    const isDenied = realFiles.some((file) => file !== null && isDeniedRealPath(file, realRoots));
    if (isDenied) {
      refuse(res, 'pyric: this path is project state or an env file, which the dev server does not serve.');
      return;
    }
    next();
  };
}

/** The scope one dev server's guard checks: its served directories and the Firebase project around them. */
export function viteDenyScope(config: { root: string; publicDir?: string; base?: string }, projectDir: string): ViteDenyScope {
  const publicDir = config.publicDir;
  const hasPublicDir = typeof publicDir === 'string' && publicDir.length > 0;
  return {
    servedRoots: hasPublicDir ? [config.root, publicDir] : [config.root],
    containingRoots: [projectDir],
    base: config.base ?? '/',
  };
}

/** Installs the guard ahead of Vite's own middleware. */
export function attachViteRealPathDeny(server: Pick<ViteDevServer, 'config' | 'middlewares'>, projectDir: string): void {
  server.middlewares.use(viteRealPathDeny(() => viteDenyScope(server.config, projectDir)));
}
