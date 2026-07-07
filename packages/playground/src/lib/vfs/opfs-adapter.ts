/**
 * OPFS-backed file system adapter that satisfies the `{ promises }`
 * shape `isomorphic-git` expects.
 *
 * File *content* lives in OPFS (`navigator.storage.getDirectory()`).
 * File *metadata* (mode, ino, ctime/mtime, file-type, symlink target)
 * lives in {@link getMetaStore}, an IndexedDB store keyed by path.
 * Symlinks have no OPFS file — they are metadata-only entries.
 *
 * Path conventions:
 *   - All paths are POSIX absolute (`/a/b/c`). Trailing slashes are
 *     stripped. `.` and `..` segments are resolved at the boundary.
 *   - `/` is the OPFS root.
 *
 * Errors are vended with `code` set to a POSIX-like string
 * (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `EINVAL`, `ELOOP`) —
 * isomorphic-git branches on `err.code`.
 */

import { getMetaStore, type FileMeta, type MetaStore } from './opfs-meta-store';

const MODE_FILE = 0o100644;
const MODE_DIR = 0o40755;
const MODE_SYMLINK = 0o120000;
const SYMLINK_MAX_HOPS = 8;

type ErrnoCode = 'ENOENT' | 'EEXIST' | 'EISDIR' | 'ENOTDIR' | 'EINVAL' | 'ELOOP';

interface ErrnoError extends Error {
  code: ErrnoCode;
  syscall?: string;
  path?: string;
}

function fsError(code: ErrnoCode, syscall: string, path: string): ErrnoError {
  const message =
    code === 'ENOENT'
      ? `ENOENT: no such file or directory, ${syscall} '${path}'`
      : code === 'EEXIST'
      ? `EEXIST: file already exists, ${syscall} '${path}'`
      : code === 'EISDIR'
      ? `EISDIR: illegal operation on a directory, ${syscall} '${path}'`
      : code === 'ENOTDIR'
      ? `ENOTDIR: not a directory, ${syscall} '${path}'`
      : code === 'ELOOP'
      ? `ELOOP: too many symbolic links encountered, ${syscall} '${path}'`
      : `EINVAL: invalid argument, ${syscall} '${path}'`;
  const err = new Error(message) as ErrnoError;
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  return err;
}

function normalize(input: string): string {
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

function splitPath(path: string): { parent: string; name: string } {
  const norm = normalize(path);
  if (norm === '/') return { parent: '/', name: '' };
  const idx = norm.lastIndexOf('/');
  const parent = idx === 0 ? '/' : norm.slice(0, idx);
  const name = norm.slice(idx + 1);
  return { parent, name };
}

function joinPath(base: string, rel: string): string {
  if (rel.startsWith('/')) return normalize(rel);
  if (base === '/') return normalize(`/${rel}`);
  return normalize(`${base}/${rel}`);
}

function isDOMExceptionWithName(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

interface Stats {
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

function buildStats(meta: FileMeta, size: number): Stats {
  return {
    type: meta.type,
    mode: meta.mode,
    size,
    ino: meta.ino,
    mtimeMs: meta.mtimeMs,
    ctimeMs: meta.ctimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => meta.type === 'file',
    isDirectory: () => meta.type === 'dir',
    isSymbolicLink: () => meta.type === 'symlink',
  };
}

type Encoding = 'utf8' | 'utf-8' | undefined;

export interface OPFSPromisesAPI {
  readFile(path: string, options?: { encoding?: Encoding } | Encoding): Promise<string | Uint8Array>;
  writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
    options?: { mode?: number; encoding?: Encoding } | Encoding,
  ): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { mode?: number; recursive?: boolean }): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface OPFSAdapter {
  promises: OPFSPromisesAPI;
}

interface AdapterInternals {
  meta: MetaStore;
  getRoot: () => Promise<FileSystemDirectoryHandle>;
}

async function ensureRoot(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error('OPFS is not available in this environment');
  }
  return navigator.storage.getDirectory();
}

/**
 * Walk `path` segment by segment from the OPFS root, returning the
 * directory handle at the end. `create` controls whether missing
 * intermediates are created. Throws ENOENT (or ENOTDIR if a segment
 * resolves to a file) when `create` is false and the path is missing.
 */
async function resolveDirHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
  syscall: string,
): Promise<FileSystemDirectoryHandle> {
  const norm = normalize(path);
  if (norm === '/') return root;
  const segments = norm.slice(1).split('/');
  let cursor = root;
  for (const seg of segments) {
    try {
      cursor = await cursor.getDirectoryHandle(seg, { create });
    } catch (err) {
      if (isDOMExceptionWithName(err, 'NotFoundError')) {
        throw fsError('ENOENT', syscall, norm);
      }
      if (isDOMExceptionWithName(err, 'TypeMismatchError')) {
        throw fsError('ENOTDIR', syscall, norm);
      }
      throw err;
    }
  }
  return cursor;
}

async function getFileHandleAt(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
  syscall: string,
): Promise<FileSystemFileHandle> {
  const { parent, name } = splitPath(path);
  if (!name) throw fsError('EINVAL', syscall, path);
  const parentHandle = await resolveDirHandle(root, parent, create, syscall);
  try {
    return await parentHandle.getFileHandle(name, { create });
  } catch (err) {
    if (isDOMExceptionWithName(err, 'NotFoundError')) {
      throw fsError('ENOENT', syscall, path);
    }
    if (isDOMExceptionWithName(err, 'TypeMismatchError')) {
      throw fsError('EISDIR', syscall, path);
    }
    throw err;
  }
}

function asUint8Array(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function pickEncoding(
  options: { encoding?: Encoding } | Encoding | undefined,
): Encoding {
  if (!options) return undefined;
  if (typeof options === 'string') return options;
  return options.encoding;
}

/** Resolve a symlink chain starting at `path`. Returns the final non-symlink target path. */
async function resolveSymlinks(
  meta: MetaStore,
  startPath: string,
  syscall: string,
): Promise<{ path: string; meta: FileMeta | null }> {
  let current = normalize(startPath);
  const visited = new Set<string>();
  for (let i = 0; i < SYMLINK_MAX_HOPS; i++) {
    if (visited.has(current)) throw fsError('ELOOP', syscall, startPath);
    visited.add(current);
    const m = await meta.get(current);
    if (!m || m.type !== 'symlink') return { path: current, meta: m };
    const target = m.symlinkTarget ?? '';
    const { parent } = splitPath(current);
    current = joinPath(parent, target);
  }
  throw fsError('ELOOP', syscall, startPath);
}

export function createOPFSAdapter(): OPFSAdapter {
  const meta = getMetaStore();
  let rootPromise: Promise<FileSystemDirectoryHandle> | null = null;
  const getRoot = (): Promise<FileSystemDirectoryHandle> => {
    if (!rootPromise) rootPromise = ensureRoot();
    return rootPromise;
  };

  const internals: AdapterInternals = { meta, getRoot };
  return { promises: buildPromisesAPI(internals) };
}

function buildPromisesAPI(internals: AdapterInternals): OPFSPromisesAPI {
  const { meta, getRoot } = internals;

  async function ensureRootMeta(): Promise<void> {
    if (await meta.get('/')) return;
    const now = Date.now();
    await meta.set('/', {
      ino: await meta.nextIno(),
      mode: MODE_DIR,
      ctimeMs: now,
      mtimeMs: now,
      type: 'dir',
    });
  }

  async function readMetaOrInfer(path: string, syscall: string): Promise<FileMeta> {
    const norm = normalize(path);
    let m = await meta.get(norm);
    if (m) return m;
    if (norm === '/') {
      await ensureRootMeta();
      m = await meta.get('/');
      if (m) return m;
    }
    // Fall back to probing OPFS: maybe a file/dir was created outside
    // the adapter. Construct a fresh metadata record so future reads
    // are cheap.
    const root = await getRoot();
    const inferred = await probeOPFS(root, norm);
    if (!inferred) throw fsError('ENOENT', syscall, norm);
    const now = Date.now();
    const fresh: FileMeta = {
      ino: await meta.nextIno(),
      mode: inferred === 'dir' ? MODE_DIR : MODE_FILE,
      ctimeMs: now,
      mtimeMs: now,
      type: inferred,
    };
    await meta.set(norm, fresh);
    return fresh;
  }

  return {
    async readFile(path, options) {
      const encoding = pickEncoding(options);
      const resolved = await resolveSymlinks(meta, path, 'open');
      const root = await getRoot();
      const handle = await getFileHandleAt(root, resolved.path, false, 'open');
      const file = await handle.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      if (encoding === 'utf8' || encoding === 'utf-8') return decodeText(buf);
      return buf;
    },

    async writeFile(path, data, options) {
      const norm = normalize(path);
      const root = await getRoot();
      await ensureRootMeta();
      const handle = await getFileHandleAt(root, norm, true, 'open');
      const writable = await handle.createWritable();
      const bytes = asUint8Array(data);
      // FileSystemWritableFileStream.write rejects Uint8Array views
      // whose buffer type isn't strictly `ArrayBuffer`. Copy into a
      // fresh ArrayBuffer-backed view to satisfy the lib.dom typings
      // without paying for a real clone in the common case (the input
      // already shares the buffer we'd otherwise produce).
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      await writable.write(copy);
      await writable.close();
      const now = Date.now();
      const existing = await meta.get(norm);
      const mode =
        typeof options === 'object' && options?.mode != null ? options.mode : existing?.mode ?? MODE_FILE;
      const next: FileMeta = existing
        ? { ...existing, type: 'file', mode, mtimeMs: now }
        : { ino: await meta.nextIno(), mode, ctimeMs: now, mtimeMs: now, type: 'file' };
      await meta.set(norm, next);
      // Ensure intermediate dir metadata exists so readdir surfaces them.
      await ensureAncestorDirMeta(meta, norm);
    },

    async unlink(path) {
      const norm = normalize(path);
      const m = await meta.get(norm);
      if (m?.type === 'symlink') {
        await meta.delete(norm);
        return;
      }
      const { parent, name } = splitPath(norm);
      const root = await getRoot();
      const parentHandle = await resolveDirHandle(root, parent, false, 'unlink');
      try {
        await parentHandle.removeEntry(name);
      } catch (err) {
        if (isDOMExceptionWithName(err, 'NotFoundError')) {
          throw fsError('ENOENT', 'unlink', norm);
        }
        throw err;
      }
      await meta.delete(norm);
    },

    async readdir(path) {
      const norm = normalize(path);
      const m = await readMetaOrInfer(norm, 'scandir');
      if (m.type !== 'dir') throw fsError('ENOTDIR', 'scandir', norm);
      const names = await meta.listChildren(norm);
      if (names.length > 0) return names.sort();
      // Fallback: enumerate OPFS for ground truth (handles entries
      // created outside the adapter, e.g. directly via OPFS APIs).
      const root = await getRoot();
      try {
        const dir = await resolveDirHandle(root, norm, false, 'scandir');
        const out: string[] = [];
        // FileSystemDirectoryHandle is AsyncIterable via .keys() in modern browsers.
        for await (const key of dir.keys()) {
          out.push(key);
        }
        return out.sort();
      } catch (err) {
        if ((err as ErrnoError).code === 'ENOENT') return [];
        throw err;
      }
    },

    async mkdir(path, options) {
      const norm = normalize(path);
      if (norm === '/') {
        await ensureRootMeta();
        return;
      }
      const recursive = options?.recursive ?? false;
      const root = await getRoot();
      await ensureRootMeta();
      const existing = await meta.get(norm);
      if (existing) {
        if (recursive && existing.type === 'dir') return;
        throw fsError('EEXIST', 'mkdir', norm);
      }
      const { parent, name } = splitPath(norm);
      if (recursive) {
        // Walk ancestors, materialise each.
        let acc = '/';
        for (const seg of parent === '/' ? [] : parent.slice(1).split('/')) {
          acc = acc === '/' ? `/${seg}` : `${acc}/${seg}`;
          if (!(await meta.get(acc))) {
            const now = Date.now();
            await meta.set(acc, {
              ino: await meta.nextIno(),
              mode: MODE_DIR,
              ctimeMs: now,
              mtimeMs: now,
              type: 'dir',
            });
          }
        }
      }
      // Materialise OPFS handle (creates intermediate dirs too).
      const parentHandle = await resolveDirHandle(root, parent, recursive, 'mkdir');
      await parentHandle.getDirectoryHandle(name, { create: true });
      const now = Date.now();
      const mode = options?.mode ?? MODE_DIR;
      await meta.set(norm, {
        ino: await meta.nextIno(),
        mode,
        ctimeMs: now,
        mtimeMs: now,
        type: 'dir',
      });
    },

    async rmdir(path, options) {
      const norm = normalize(path);
      if (norm === '/') throw fsError('EINVAL', 'rmdir', norm);
      const { parent, name } = splitPath(norm);
      const root = await getRoot();
      const parentHandle = await resolveDirHandle(root, parent, false, 'rmdir');
      try {
        await parentHandle.removeEntry(name, { recursive: options?.recursive ?? false });
      } catch (err) {
        if (isDOMExceptionWithName(err, 'NotFoundError')) {
          throw fsError('ENOENT', 'rmdir', norm);
        }
        throw err;
      }
      // Sweep metadata for the subtree.
      await deleteSubtreeMeta(meta, norm);
    },

    async stat(path) {
      const resolved = await resolveSymlinks(meta, path, 'stat');
      if (!resolved.meta) {
        const inferred = await readMetaOrInfer(resolved.path, 'stat');
        return computeStats(inferred, resolved.path, getRoot);
      }
      return computeStats(resolved.meta, resolved.path, getRoot);
    },

    async lstat(path) {
      const norm = normalize(path);
      const m = await readMetaOrInfer(norm, 'lstat');
      return computeStats(m, norm, getRoot);
    },

    async symlink(target, path) {
      const norm = normalize(path);
      if (await meta.get(norm)) throw fsError('EEXIST', 'symlink', norm);
      await ensureRootMeta();
      await ensureAncestorDirMeta(meta, norm);
      const now = Date.now();
      await meta.set(norm, {
        ino: await meta.nextIno(),
        mode: MODE_SYMLINK,
        ctimeMs: now,
        mtimeMs: now,
        type: 'symlink',
        symlinkTarget: target,
      });
    },

    async readlink(path) {
      const norm = normalize(path);
      const m = await meta.get(norm);
      if (!m) throw fsError('ENOENT', 'readlink', norm);
      if (m.type !== 'symlink') throw fsError('EINVAL', 'readlink', norm);
      return m.symlinkTarget ?? '';
    },

    async chmod(path, mode) {
      const norm = normalize(path);
      const m = await meta.get(norm);
      if (!m) throw fsError('ENOENT', 'chmod', norm);
      await meta.set(norm, { ...m, mode });
    },
  };
}

async function probeOPFS(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<'file' | 'dir' | null> {
  const norm = normalize(path);
  if (norm === '/') return 'dir';
  const { parent, name } = splitPath(norm);
  let parentHandle: FileSystemDirectoryHandle;
  try {
    parentHandle = await resolveDirHandle(root, parent, false, 'stat');
  } catch {
    return null;
  }
  try {
    await parentHandle.getFileHandle(name);
    return 'file';
  } catch {
    /* fallthrough to directory probe */
  }
  try {
    await parentHandle.getDirectoryHandle(name);
    return 'dir';
  } catch {
    return null;
  }
}

async function computeStats(
  m: FileMeta,
  path: string,
  getRoot: () => Promise<FileSystemDirectoryHandle>,
): Promise<Stats> {
  let size = 0;
  if (m.type === 'file') {
    try {
      const root = await getRoot();
      const handle = await getFileHandleAt(root, path, false, 'stat');
      const file = await handle.getFile();
      size = file.size;
    } catch {
      size = 0;
    }
  }
  return buildStats(m, size);
}

async function ensureAncestorDirMeta(meta: MetaStore, path: string): Promise<void> {
  const norm = normalize(path);
  if (norm === '/') return;
  const segments = norm.slice(1).split('/').slice(0, -1);
  let acc = '';
  for (const seg of segments) {
    acc = `${acc}/${seg}`;
    if (await meta.get(acc)) continue;
    const now = Date.now();
    await meta.set(acc, {
      ino: await meta.nextIno(),
      mode: MODE_DIR,
      ctimeMs: now,
      mtimeMs: now,
      type: 'dir',
    });
  }
}

async function deleteSubtreeMeta(meta: MetaStore, root: string): Promise<void> {
  const norm = normalize(root);
  const stack = [norm];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const children = await meta.listChildren(next);
    for (const child of children) {
      const childPath = next === '/' ? `/${child}` : `${next}/${child}`;
      stack.push(childPath);
    }
    await meta.delete(next);
  }
}
