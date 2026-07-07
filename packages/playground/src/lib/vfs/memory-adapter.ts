/**
 * In-memory VFS adapter — a server-side stand-in for the OPFS adapter.
 *
 * The OPFS adapter (`opfs-adapter.ts`) backs the workspace file tools in
 * the browser via `navigator.storage.getDirectory()` + IndexedDB. Neither
 * exists in Node, so the same file tools (`write_file`, `read_file`,
 * `list_files`, `delete_file`) can't run headlessly against it.
 *
 * This adapter implements the same `OPFSPromisesAPI` over plain in-memory
 * maps, so the real, unmodified file tools work from a `bun`/Node harness.
 * It is intentionally ephemeral (fresh per process / per `resetVFS()`),
 * which is exactly what eval isolation wants — each run starts with a
 * clean workspace. `getVFS()` selects this when OPFS is absent.
 *
 * Semantics mirror the OPFS adapter where the tools depend on it:
 *   - `readFile(path, 'utf8')` returns a string; otherwise a Uint8Array.
 *   - missing paths throw an Error whose `.code === 'ENOENT'` (the tools
 *     branch on that exact code).
 *   - `writeFile` auto-creates parent directories.
 */
import type { OPFSAdapter, OPFSPromisesAPI } from './opfs-adapter';

type Encoding = 'utf8' | 'utf-8' | undefined;
type EncodingOpt = { encoding?: Encoding } | Encoding;

// Reuse the adapter interface's own (module-private) Stats type rather than
// redeclaring it — a second interface named `Stats` is a distinct, unrelated
// type and won't satisfy `OPFSPromisesAPI.lstat`.
type Stats = Awaited<ReturnType<OPFSPromisesAPI['lstat']>>;

type NodeKind = 'file' | 'dir' | 'symlink';
interface Node {
  kind: NodeKind;
  bytes?: Uint8Array; // file
  target?: string; // symlink
  mode: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: 'ENOENT',
  }) as NodeJS.ErrnoException;
}
function enotdir(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOTDIR: not a directory, '${path}'`), {
    code: 'ENOTDIR',
  }) as NodeJS.ErrnoException;
}

function wantsUtf8(options?: EncodingOpt): boolean {
  const enc = typeof options === 'string' ? options : options?.encoding;
  return enc === 'utf8' || enc === 'utf-8';
}

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function normalize(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}
function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function createMemoryVFSAdapter(): OPFSAdapter {
  const nodes = new Map<string, Node>();
  let inoSeq = 1;
  const now = () => Date.now();

  // Root always exists.
  nodes.set('/', { kind: 'dir', mode: 0o755, ino: inoSeq++, mtimeMs: now(), ctimeMs: now() });

  function ensureDir(path: string): void {
    const norm = normalize(path);
    if (norm === '/') return;
    if (nodes.has(norm)) return;
    ensureDir(parentOf(norm));
    nodes.set(norm, { kind: 'dir', mode: 0o755, ino: inoSeq++, mtimeMs: now(), ctimeMs: now() });
  }

  function buildStats(n: Node): Stats {
    return {
      type: n.kind,
      mode: n.mode,
      size: n.kind === 'file' ? (n.bytes?.length ?? 0) : 0,
      ino: n.ino,
      mtimeMs: n.mtimeMs,
      ctimeMs: n.ctimeMs,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => n.kind === 'file',
      isDirectory: () => n.kind === 'dir',
      isSymbolicLink: () => n.kind === 'symlink',
    };
  }

  const promises: OPFSPromisesAPI = {
    async readFile(path, options) {
      const norm = normalize(path);
      const n = nodes.get(norm);
      if (!n || n.kind === 'dir') throw enoent(norm);
      const bytes = n.bytes ?? new Uint8Array();
      return wantsUtf8(options) ? new TextDecoder().decode(bytes) : bytes;
    },

    async writeFile(path, data) {
      const norm = normalize(path);
      const existing = nodes.get(norm);
      if (existing && existing.kind === 'dir') throw enotdir(norm);
      ensureDir(parentOf(norm));
      nodes.set(norm, {
        kind: 'file',
        bytes: toBytes(data),
        mode: existing?.mode ?? 0o644,
        ino: existing?.ino ?? inoSeq++,
        mtimeMs: now(),
        ctimeMs: existing?.ctimeMs ?? now(),
      });
    },

    async unlink(path) {
      const norm = normalize(path);
      const n = nodes.get(norm);
      if (!n || n.kind === 'dir') throw enoent(norm);
      nodes.delete(norm);
    },

    async readdir(path) {
      const norm = normalize(path);
      const n = nodes.get(norm);
      if (!n) throw enoent(norm);
      if (n.kind !== 'dir') throw enotdir(norm);
      const prefix = norm === '/' ? '/' : norm + '/';
      const children = new Set<string>();
      for (const key of nodes.keys()) {
        if (key === norm) continue;
        if (!key.startsWith(prefix)) continue;
        if (parentOf(key) === norm) children.add(basename(key));
      }
      return [...children].sort();
    },

    async mkdir(path, options) {
      const norm = normalize(path);
      if (nodes.has(norm)) return;
      if (options?.recursive) ensureDir(norm);
      else {
        const parent = parentOf(norm);
        if (parent !== '/' && !nodes.has(parent)) throw enoent(parent);
        nodes.set(norm, { kind: 'dir', mode: options?.mode ?? 0o755, ino: inoSeq++, mtimeMs: now(), ctimeMs: now() });
      }
    },

    async rmdir(path, options) {
      const norm = normalize(path);
      const n = nodes.get(norm);
      if (!n) throw enoent(norm);
      if (n.kind !== 'dir') throw enotdir(norm);
      const prefix = norm + '/';
      const descendants = [...nodes.keys()].filter((k) => k.startsWith(prefix));
      if (descendants.length > 0 && !options?.recursive) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, '${norm}'`), { code: 'ENOTEMPTY' });
      }
      for (const k of descendants) nodes.delete(k);
      nodes.delete(norm);
    },

    async stat(path) {
      const norm = normalize(path);
      const n = nodes.get(norm);
      if (!n) throw enoent(norm);
      return buildStats(n);
    },

    async lstat(path) {
      const norm = normalize(path);
      const n = nodes.get(norm);
      if (!n) throw enoent(norm);
      return buildStats(n);
    },

    async symlink(target, path) {
      const norm = normalize(path);
      ensureDir(parentOf(norm));
      nodes.set(norm, { kind: 'symlink', target, mode: 0o777, ino: inoSeq++, mtimeMs: now(), ctimeMs: now() });
    },

    async readlink(path) {
      const norm = normalize(path);
      const n = nodes.get(norm);
      if (!n || n.kind !== 'symlink') throw enoent(norm);
      return n.target ?? '';
    },

    async chmod(path, mode) {
      const norm = normalize(path);
      const n = nodes.get(norm);
      if (!n) throw enoent(norm);
      n.mode = mode;
    },
  };

  return { promises };
}
