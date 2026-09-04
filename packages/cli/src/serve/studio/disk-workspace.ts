/**
 * `diskWorkspace(dir)` — a {@link WorkspaceStore} over a real filesystem
 * directory (the Studio `local` mode's project file tree, served at
 * `/__pyric/workspace`).
 *
 * Paths are project-relative POSIX strings (`src/app.tsx`, `firestore.rules`).
 * Every op resolves the path inside `dir` and REFUSES anything that escapes the
 * root (`..` traversal, absolute paths) — the same posture the static server
 * takes for `publicDir`. `watch(cb)` uses a recursive `fs.watch` and reports
 * create/update/delete as {@link WorkspaceChange} events.
 */
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  watch as fsWatch,
  type FSWatcher,
} from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';

import type {
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceStore,
} from './store-types.js';

/** Thrown when a request path escapes the workspace root. */
export class WorkspacePathError extends Error {
  constructor(path: string) {
    super(`workspace path escapes root: '${path}'`);
    this.name = 'WorkspacePathError';
  }
}

/**
 * Resolves the canonical realpath of a path, handling symlinks and non-existent
 * terminal segments by resolving the nearest existing ancestor.
 */
function getCanonicalPath(targetPath: string, seen = new Set<string>()): string {
  const abs = resolve(targetPath);
  if (seen.has(abs)) {
    throw new WorkspacePathError(targetPath);
  }
  seen.add(abs);

  try {
    return realpathSync(abs);
  } catch (err: any) {
    if (err?.code === 'ELOOP') {
      throw new WorkspacePathError(targetPath);
    }
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
      throw err;
    }
  }

  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      const linkTarget = readlinkSync(abs);
      const nextTarget = resolve(dirname(abs), linkTarget);
      return getCanonicalPath(nextTarget, seen);
    }
  } catch {
    // abs does not exist as a directory entry
  }

  const parent = dirname(abs);
  if (parent === abs) {
    return abs;
  }
  const canonicalParent = getCanonicalPath(parent, seen);
  return join(canonicalParent, basename(abs));
}

/** Check whether canonical target is contained within canonical root. */
function isContained(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * Resolve a project-relative POSIX path to an absolute OS path inside `root`,
 * or throw {@link WorkspacePathError} if it would escape. Leading slashes are
 * stripped (treated as project-root-relative); empty / `.` resolves to the
 * root itself.
 */
export function resolveWorkspacePath(root: string, rel: string): string {
  const cleaned = rel.replace(/^\/+/, '');
  // Normalize via POSIX semantics first so `a/../b` collapses predictably,
  // then map separators to the host OS.
  const normalized = posix.normalize(cleaned === '' ? '.' : cleaned);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new WorkspacePathError(rel);
  }
  const abs = resolve(root, normalized.split('/').join(sep));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new WorkspacePathError(rel);
  }

  // Canonical realpath containment check:
  // Reject symlinks that escape the workspace root.
  const canonicalRoot = getCanonicalPath(root);
  let canonicalTarget: string;
  try {
    canonicalTarget = getCanonicalPath(abs);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      throw new WorkspacePathError(rel);
    }
    throw err;
  }

  if (!isContained(canonicalRoot, canonicalTarget)) {
    throw new WorkspacePathError(rel);
  }

  return abs;
}

/** Convert an absolute OS path under `root` to a project-relative POSIX path. */
function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

export function diskWorkspace(dir: string): WorkspaceStore {
  const root = resolve(dir);

  return {
    async read(path) {
      const abs = resolveWorkspacePath(root, path);
      try {
        return await readFile(abs, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        // A directory read errors as EISDIR — treat as "no file content".
        if ((e as NodeJS.ErrnoException).code === 'EISDIR') return null;
        throw e;
      }
    },

    async write(path, content) {
      const abs = resolveWorkspacePath(root, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    },

    async list(dir) {
      const abs = resolveWorkspacePath(root, dir ?? '');
      let names: string[];
      try {
        names = await readdir(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      const entries: WorkspaceEntry[] = [];
      for (const name of names) {
        const childAbs = join(abs, name);
        let isDir = false;
        try {
          isDir = (await stat(childAbs)).isDirectory();
        } catch {
          continue; // raced away between readdir and stat
        }
        entries.push({
          path: toPosixRel(root, childAbs),
          kind: isDir ? 'dir' : 'file',
        });
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return entries;
    },

    async remove(path) {
      const abs = resolveWorkspacePath(root, path);
      if (abs === root) throw new WorkspacePathError(path); // never nuke the root
      await rm(abs, { recursive: true, force: true });
    },

    watch(cb) {
      if (!existsSync(root)) {
        try {
          // best-effort: ensure the dir exists so the watcher can attach.
          mkdirSync(root, { recursive: true });
        } catch {
          /* watcher just won't fire */
        }
      }
      let watcher: FSWatcher | null = null;
      try {
        watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
          if (filename == null) return;
          const relPath = String(filename).split(sep).join('/');
          // fs.watch doesn't tell us create vs update vs delete reliably across
          // platforms; derive it from current existence.
          let abs: string;
          try {
            abs = resolveWorkspacePath(root, relPath);
          } catch {
            return; // ignore anything outside the root
          }
          const type: WorkspaceChange['type'] = existsSync(abs)
            ? 'update'
            : 'delete';
          cb({ path: relPath, type });
        });
      } catch {
        // Recursive watch unsupported here — degrade to no live updates.
        return () => {};
      }
      // Watcher failure (EMFILE, root renamed) must not surface as an
      // unhandled 'error' event — that would kill the serve process.
      // Degrade to no live updates instead.
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
      return () => {
        watcher?.close();
        watcher = null;
      };
    },
  };
}
