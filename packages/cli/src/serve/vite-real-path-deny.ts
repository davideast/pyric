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
import { relative } from 'node:path';
import type { ViteDevServer } from 'vite';
import { isPyricStateOrEnvPath } from './project-secret-paths.js';
import { isPathInside } from './path-inside.js';
import { viteCandidateFiles, viteRequestPathnames } from './vite-request-path.js';

type Next = (error?: unknown) => void;

export interface ViteDenyScope {
  /** The Vite root and public directory: where a request path can open a file. */
  servedRoots: readonly string[];
  /** The Firebase project directory: its own path does not count against a file inside it. */
  containingRoots: readonly string[];
  /** Vite's `base`. */
  base: string;
}

function realPathOf(filePath: string): string | null {
  try {
    return realpathSync(filePath);
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
    const { servedRoots, containingRoots, base } = scope();
    const paths = viteRequestPathnames(req.url, base);
    if (paths === null) {
      refuse(res, 'pyric: this request path does not decode.');
      return;
    }
    const realRoots = [...servedRoots, ...containingRoots].map((root) => realPathOf(root) ?? root);
    const candidates = new Set<string>();
    for (const pathname of paths) {
      for (const candidate of viteCandidateFiles(pathname, servedRoots, { includeAbsolute: true })) {
        candidates.add(candidate);
      }
    }
    for (const candidate of candidates) {
      const real = realPathOf(candidate);
      if (real !== null && isDeniedRealPath(real, realRoots)) {
        refuse(res, 'pyric: this path is project state or an env file, which the dev server does not serve.');
        return;
      }
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
