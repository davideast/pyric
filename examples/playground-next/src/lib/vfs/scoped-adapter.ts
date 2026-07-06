/**
 * Session-scoped VFS adapter — mounts a virtual `/` onto a real
 * subdirectory of the underlying adapter.
 *
 * This is THE isolation seam for playground sessions: every existing
 * caller keeps using virtual paths like `/workspace/src/App.tsx`
 * unchanged, while the bytes land at
 * `{realRoot}/workspace/src/App.tsx` (e.g.
 * `/sessions/{sessionId}/workspace/src/App.tsx`) in OPFS. Two session
 * ids → two disjoint real subtrees → no cross-session or cross-tab
 * file pollution.
 *
 * Also carries the per-tab write gate: when `canWrite()` returns
 * false (this tab lost the session writer-lock election, see
 * `lib/sessions/writer-lock.ts`), every mutating call rejects with an
 * `EROFS` error. Reads keep working — a read-only tab can still view
 * files, compile the preview, etc.
 *
 * Path translation details:
 *   - Virtual paths are normalized (`.`/`..` resolved) BEFORE the
 *     prefix is applied, so `..` can never escape the mount.
 *   - Absolute symlink targets are translated on `symlink()` and
 *     reverse-translated on `readlink()` so links round-trip in
 *     virtual coordinates and resolve inside the container.
 *   - Errors thrown by the inner adapter have their `path` + message
 *     rewritten back to virtual coordinates so tool output / UI
 *     surfaces never leak the real mount point.
 */

import type { OPFSAdapter, OPFSPromisesAPI } from './opfs-adapter';

export interface ScopedVFSOptions {
  /** Absolute real path of the container the virtual `/` mounts onto,
   *  e.g. `/sessions/abc123`. Must not be `/`. */
  realRoot: string;
  /** Write gate — checked at call time on every mutating operation.
   *  Defaults to always-writable. */
  canWrite?: () => boolean;
}

/** Resolve `.`/`..`/empty segments; result is always absolute. */
export function normalizeVirtualPath(input: string): string {
  if (!input || input === '/') return '/';
  const parts: string[] = [];
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

interface ErrnoLike extends Error {
  code?: string;
  path?: string;
}

function erofs(syscall: string, path: string): ErrnoLike {
  const err = new Error(
    `EROFS: read-only file system (session is open in another tab), ${syscall} '${path}'`,
  ) as ErrnoLike;
  err.code = 'EROFS';
  err.path = path;
  return err;
}

function isEnoent(err: unknown): boolean {
  return (err as ErrnoLike | null)?.code === 'ENOENT';
}

export function createScopedVFSAdapter(
  inner: OPFSAdapter,
  options: ScopedVFSOptions,
): OPFSAdapter {
  const realRoot = normalizeVirtualPath(options.realRoot);
  if (realRoot === '/') {
    throw new Error('[vfs] scoped adapter realRoot must not be "/"');
  }
  const canWrite = options.canWrite ?? (() => true);
  const fs = inner.promises;

  const toReal = (virtual: string): string => {
    const norm = normalizeVirtualPath(virtual);
    return norm === '/' ? realRoot : `${realRoot}${norm}`;
  };

  const fromReal = (real: string): string => {
    if (real === realRoot) return '/';
    if (real.startsWith(`${realRoot}/`)) return real.slice(realRoot.length);
    return real;
  };

  /** Rewrite inner-adapter errors back into virtual coordinates —
   *  both the structured `path` field and any real paths embedded in
   *  the message (some inner adapters only set the message). */
  const unscope = (err: unknown): unknown => {
    const e = err as ErrnoLike | null;
    if (!e) return err;
    if (typeof e.path === 'string' && e.path.startsWith(realRoot)) {
      e.path = fromReal(e.path);
    }
    if (typeof e.message === 'string' && e.message.includes(realRoot)) {
      e.message = e.message.split(`${realRoot}/`).join('/').split(realRoot).join('/');
    }
    return err;
  };

  const guardWrite = (syscall: string, virtual: string): void => {
    if (!canWrite()) throw erofs(syscall, normalizeVirtualPath(virtual));
  };

  /** Materialise the container root once so non-recursive mkdir /
   *  writes near the virtual root don't ENOENT on a fresh container.
   *  Memoized; re-armed if the ensure itself failed. */
  let containerReady: Promise<void> | null = null;
  const ensureContainer = (): Promise<void> => {
    if (!containerReady) {
      containerReady = fs.mkdir(realRoot, { recursive: true }).catch((err) => {
        containerReady = null;
        throw err;
      });
    }
    return containerReady;
  };

  const promises: OPFSPromisesAPI = {
    async readFile(path, opts) {
      try {
        return await fs.readFile(toReal(path), opts);
      } catch (err) {
        throw unscope(err);
      }
    },

    async writeFile(path, data, opts) {
      guardWrite('open', path);
      try {
        await ensureContainer();
        await fs.writeFile(toReal(path), data, opts);
      } catch (err) {
        throw unscope(err);
      }
    },

    async unlink(path) {
      guardWrite('unlink', path);
      try {
        await fs.unlink(toReal(path));
      } catch (err) {
        throw unscope(err);
      }
    },

    async readdir(path) {
      try {
        return await fs.readdir(toReal(path));
      } catch (err) {
        // A container that has never been written to has no real root
        // directory yet — the virtual root still "exists" (it's the
        // mount), so listing it yields an empty tree, not ENOENT.
        if (isEnoent(err) && normalizeVirtualPath(path) === '/') return [];
        throw unscope(err);
      }
    },

    async mkdir(path, opts) {
      guardWrite('mkdir', path);
      try {
        await ensureContainer();
        if (normalizeVirtualPath(path) === '/') return; // mount root === container
        await fs.mkdir(toReal(path), opts);
      } catch (err) {
        throw unscope(err);
      }
    },

    async rmdir(path, opts) {
      guardWrite('rmdir', path);
      try {
        await fs.rmdir(toReal(path), opts);
      } catch (err) {
        throw unscope(err);
      }
    },

    async stat(path) {
      try {
        return await fs.stat(toReal(path));
      } catch (err) {
        if (isEnoent(err) && normalizeVirtualPath(path) === '/') {
          // Same reasoning as readdir: the mount root exists even
          // before the first write. Create it for real so the inner
          // adapter can vend honest stats from here on.
          await ensureContainer();
          return fs.stat(realRoot);
        }
        throw unscope(err);
      }
    },

    async lstat(path) {
      try {
        return await fs.lstat(toReal(path));
      } catch (err) {
        if (isEnoent(err) && normalizeVirtualPath(path) === '/') {
          await ensureContainer();
          return fs.lstat(realRoot);
        }
        throw unscope(err);
      }
    },

    async symlink(target, path) {
      guardWrite('symlink', path);
      // Absolute targets are virtual-coordinate; store them in real
      // coordinates so the inner adapter's symlink resolution lands
      // inside the container. Relative targets resolve against the
      // (already-scoped) parent directory and pass through unchanged.
      const realTarget = target.startsWith('/') ? toReal(target) : target;
      try {
        await ensureContainer();
        await fs.symlink(realTarget, toReal(path));
      } catch (err) {
        throw unscope(err);
      }
    },

    async readlink(path) {
      try {
        const target = await fs.readlink(toReal(path));
        return target.startsWith('/') ? fromReal(target) : target;
      } catch (err) {
        throw unscope(err);
      }
    },

    async chmod(path, mode) {
      guardWrite('chmod', path);
      try {
        await fs.chmod(toReal(path), mode);
      } catch (err) {
        throw unscope(err);
      }
    },
  };

  return { promises };
}
