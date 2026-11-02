/**
 * Refuse a Vite dev server request whose file really is project state.
 *
 * Vite serves files under its root and follows symlinks, and
 * `server.fs.deny` matches the path a request names, not the file it opens.
 * So a symlink inside the root that points at `.pyric/state` or at `.env`
 * would hand those bytes out. This middleware runs before Vite's own: it
 * resolves the file a request names (under the root, the public directory, or
 * an `/@fs/` absolute path) to its real path, and answers 403 when that real
 * path is inside `.pyric/` or is a `.env*` file.
 */
import { realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative } from 'node:path';
import { isPyricStateOrEnvPath } from './project-secret-paths.js';

const FS_PREFIX = '/@fs/';

type Next = (error?: unknown) => void;

/** The decoded pathname of a request URL, without its query or hash; null when it does not decode. */
function decodedPathname(rawUrl: string | undefined): string | null {
  const pathname = (rawUrl ?? '/').replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/** The files a request could open: an `/@fs/` path names one, any other path is tried under each root. */
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

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

/**
 * Inside a root, only the part below that root counts, so a project that lives
 * under a directory with a denied name still serves its own files. Outside
 * every root, as with a link to another project's state, the whole path counts.
 */
function isDeniedRealPath(realPath: string, realRoots: readonly string[]): boolean {
  const containing = realRoots.filter((root) => isInside(root, realPath));
  const isOutsideRoots = containing.length === 0;
  if (isOutsideRoots) return isPyricStateOrEnvPath(realPath);
  return containing.some((root) => isPyricStateOrEnvPath(relative(root, realPath)));
}

/**
 * Connect middleware for Vite's dev server. `roots` gives the Vite root, its
 * public directory and the Firebase project directory, read on each request
 * so a restarted server's config is used.
 */
export function viteRealPathDeny(roots: () => readonly string[]) {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const pathname = decodedPathname(req.url);
    const undecodable = pathname === null;
    if (undecodable) {
      next();
      return;
    }
    const rootList = roots();
    const realRoots = rootList.map((root) => realPathOf(root) ?? root);
    const realFiles = candidateFiles(pathname, rootList).map(realPathOf);
    const isDenied = realFiles.some((file) => file !== null && isDeniedRealPath(file, realRoots));
    if (isDenied) {
      res.statusCode = 403;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('pyric: this path is project state or an env file, which the dev server does not serve.');
      return;
    }
    next();
  };
}
