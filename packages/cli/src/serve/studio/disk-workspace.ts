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
  mkdirSync,
  watch as fsWatch,
  type FSWatcher,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import {
  getCanonicalPath,
  isContained,
  PathContainmentCycleError,
  PathContainmentTraversalError,
  resolveCanonicalPath,
} from '../../project-containment.js';
import { isProjectSecretPath } from '../project-secret-paths.js';
import { readBranches } from './branch-store-reading.js';

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
 * Thrown when a request path, or the real path it resolves to, is project
 * state, an env file or a dependency (`.pyric/`, `.env*`, `node_modules`).
 * The workspace never reads, writes, lists or removes those.
 */
export class WorkspaceDeniedPathError extends WorkspacePathError {
  constructor(path: string) {
    super(path);
    this.message = `workspace path is not served: '${path}'`;
    this.name = 'WorkspaceDeniedPathError';
  }
}

/**
 * Resolve a project-relative POSIX path to an absolute OS path inside `root`,
 * or throw {@link WorkspacePathError} if it would escape. Leading slashes are
 * stripped (treated as project-root-relative); empty / `.` resolves to the
 * root itself.
 */
export function resolveWorkspacePath(root: string, rel: string): string {
  if (rel.includes('\0')) {
    throw new WorkspacePathError(rel);
  }
  const cleaned = rel.replace(/^\/+/, '');
  const rawRel = cleaned === '' ? '.' : cleaned;
  if (isAbsolute(rawRel)) {
    throw new WorkspacePathError(rel);
  }
  // Normalize via POSIX semantics to check lexical traversal and secret path
  // names, while resolving containment left-to-right on the raw segments so
  // `symlink/../outside` cannot be collapsed before the symlink is expanded.
  const normalized = posix.normalize(rawRel);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new WorkspacePathError(rel);
  }
  const abs = resolve(root, normalized.split('/').join(sep));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new WorkspacePathError(rel);
  }

  // Canonical realpath containment check:
  // Reject symlinks and symlink+.. traversals that escape the workspace root.
  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    canonicalRoot = getCanonicalPath(root);
    canonicalTarget = resolveCanonicalPath(canonicalRoot, rawRel.split('/').join(sep));
  } catch (err: unknown) {
    if (
      err instanceof PathContainmentCycleError ||
      err instanceof PathContainmentTraversalError
    ) {
      throw new WorkspacePathError(rel);
    }
    throw err;
  }

  if (!isContained(canonicalRoot, canonicalTarget)) {
    throw new WorkspacePathError(rel);
  }

  // Both the path asked for and the file it really is, so a symlink inside
  // the project cannot reach `.pyric/` or `.env`.
  const realRelative = relative(canonicalRoot, canonicalTarget);
  const isDenied = isProjectSecretPath(normalized) || isProjectSecretPath(realRelative);
  if (isDenied) {
    throw new WorkspaceDeniedPathError(rel);
  }

  if (rawRel.split('/').includes('..')) {
    return resolve(root, realRelative);
  }
  return abs;
}

/** Convert an absolute OS path under `root` to a project-relative POSIX path. */
function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/** A listed entry is shown only when reading it would be allowed. */
function isServedChild(root: string, childAbs: string): boolean {
  try {
    resolveWorkspacePath(root, toPosixRel(root, childAbs));
    return true;
  } catch (error) {
    return !(error instanceof WorkspaceDeniedPathError);
  }
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
        const isServed = isServedChild(root, childAbs);
        if (!isServed) continue;
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

    async branches() {
      return readBranches(root);
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
          if (!watcher || filename == null) return;
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
