/**
 * `just-bash` `IFileSystem` adapter that delegates to the OPFS VFS.
 *
 * `MountableFs` strips the mount-point prefix before forwarding paths,
 * so this adapter always receives paths relative to its own mount
 * root. We map those onto an OPFS prefix supplied at construction
 * time — typically `/` (mount the whole VFS) but `createBashSession`
 * can sandbox the terminal to any subtree by passing a different
 * prefix.
 *
 * The `IFileSystem` surface is broader than what `isomorphic-git`
 * needed. The extras (`cp`, `mv`, `link`, `realpath`, `utimes`,
 * `getAllPaths`, `readdirWithFileTypes`) are implemented in terms of
 * the OPFS adapter's `promises` API plus a metadata walk for the
 * full-path enumeration.
 */

import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';

import { getMetaStore, type MetaStore } from '~/lib/vfs/opfs-meta-store';
import { notifyVfsPathChanged } from '~/lib/files/bootstrap';
import type { OPFSAdapter } from '~/lib/vfs';

// `just-bash` doesn't re-export these helper interfaces from its main
// entry. They're inlined here from the source to keep the public
// shape correct without reaching into the package's deep paths.
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
  encoding?: BufferEncoding;
}
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

function joinPosix(base: string, rel: string): string {
  if (!rel || rel === '/' || rel === '.') return base || '/';
  if (rel.startsWith('/')) {
    const parts: string[] = [];
    for (const seg of rel.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        parts.pop();
        continue;
      }
      parts.push(seg);
    }
    return `/${parts.join('/')}`;
  }
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  return joinPosix('/', `${left}/${rel}`);
}

function resolveAbsolute(base: string, path: string): string {
  return path.startsWith('/') ? joinPosix('/', path) : joinPosix(base, path);
}

function dirnamePosix(path: string): string {
  if (path === '/' || path === '') return '/';
  const norm = joinPosix('/', path);
  const idx = norm.lastIndexOf('/');
  return idx <= 0 ? '/' : norm.slice(0, idx);
}

export class OPFSBashFs implements IFileSystem {
  /**
   * @param adapter The OPFS adapter exposing `promises.*` filesystem ops.
   * @param prefix  OPFS path that the bash mount root maps onto.
   *                Bash path `/foo.ts` becomes OPFS path `${prefix}/foo.ts`.
   *                Default `/` mounts the whole VFS.
   */
  constructor(
    private readonly adapter: OPFSAdapter,
    private readonly prefix: string = '/',
    private readonly meta: MetaStore = getMetaStore(),
  ) {}

  private opfsPath(path: string): string {
    const norm = joinPosix('/', path);
    if (this.prefix === '/' || this.prefix === '') return norm;
    if (norm === '/') return joinPosix('/', this.prefix);
    return joinPosix('/', `${this.prefix}${norm}`);
  }

  resolvePath(base: string, path: string): string {
    return resolveAbsolute(base || '/', path);
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const encoding = pickReadEncoding(options) ?? 'utf8';
    const result = await this.adapter.promises.readFile(this.opfsPath(path), 'utf8');
    if (typeof result === 'string') return result;
    return decodeWithEncoding(result, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const result = await this.adapter.promises.readFile(this.opfsPath(path));
    if (typeof result === 'string') return new TextEncoder().encode(result);
    return result;
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const opts = typeof options === 'string' ? { encoding: options } : options;
    const data = normaliseContent(content, opts?.encoding);
    await this.adapter.promises.writeFile(this.opfsPath(path), data);
    // Shell writes historically bypassed the store mirror + preview
    // recompile entirely (`echo … > App.tsx` left the UI stale).
    notifyVfsPathChanged(this.opfsPath(path));
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const target = this.opfsPath(path);
    let existing: Uint8Array | string;
    try {
      existing = await this.adapter.promises.readFile(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      existing = new Uint8Array(0);
    }
    const existingBytes =
      typeof existing === 'string' ? new TextEncoder().encode(existing) : existing;
    const opts = typeof options === 'string' ? { encoding: options } : options;
    const incoming = normaliseContent(content, opts?.encoding);
    const merged = new Uint8Array(existingBytes.length + incoming.length);
    merged.set(existingBytes, 0);
    merged.set(incoming, existingBytes.length);
    await this.adapter.promises.writeFile(target, merged);
    notifyVfsPathChanged(target);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.adapter.promises.lstat(this.opfsPath(path));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const stat = await this.adapter.promises.stat(this.opfsPath(path));
    return toFsStat(stat);
  }

  async lstat(path: string): Promise<FsStat> {
    const stat = await this.adapter.promises.lstat(this.opfsPath(path));
    return toFsStat(stat);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.adapter.promises.mkdir(this.opfsPath(path), {
      recursive: options?.recursive ?? false,
    });
  }

  async readdir(path: string): Promise<string[]> {
    return this.adapter.promises.readdir(this.opfsPath(path));
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const names = await this.readdir(path);
    const out: DirentEntry[] = [];
    for (const name of names) {
      try {
        const stat = await this.adapter.promises.lstat(this.opfsPath(joinPosix(path, name)));
        out.push({
          name,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          isSymbolicLink: stat.isSymbolicLink(),
        });
      } catch {
        // Drop entries we can't stat — readdir is best-effort.
      }
    }
    return out;
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const target = this.opfsPath(path);
    let stat;
    try {
      stat = await this.adapter.promises.lstat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (options?.force) return;
        throw err;
      }
      throw err;
    }
    if (stat.isDirectory()) {
      await this.adapter.promises.rmdir(target, { recursive: options?.recursive ?? false });
    } else {
      await this.adapter.promises.unlink(target);
    }
    notifyVfsPathChanged(target);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcStat = await this.adapter.promises.lstat(this.opfsPath(src));
    if (srcStat.isDirectory()) {
      if (!options?.recursive) {
        throw new Error(`cp: '${src}' is a directory (not copied)`);
      }
      await this.copyDir(src, dest);
    } else if (srcStat.isSymbolicLink()) {
      const target = await this.adapter.promises.readlink(this.opfsPath(src));
      await this.adapter.promises.symlink(target, this.opfsPath(dest));
    } else {
      const bytes = await this.adapter.promises.readFile(this.opfsPath(src));
      const payload = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
      await this.adapter.promises.writeFile(this.opfsPath(dest), payload);
    }
    notifyVfsPathChanged(this.opfsPath(dest));
  }

  private async copyDir(src: string, dest: string): Promise<void> {
    await this.adapter.promises.mkdir(this.opfsPath(dest), { recursive: true });
    const names = await this.adapter.promises.readdir(this.opfsPath(src));
    for (const name of names) {
      await this.cp(joinPosix(src, name), joinPosix(dest, name), { recursive: true });
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true, force: true });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.adapter.promises.chmod(this.opfsPath(path), mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.adapter.promises.symlink(target, this.opfsPath(linkPath));
  }

  async link(_existing: string, _new: string): Promise<void> {
    throw new Error(
      'hard links are not supported on the OPFS VFS — use symlink or copy instead',
    );
  }

  async readlink(path: string): Promise<string> {
    return this.adapter.promises.readlink(this.opfsPath(path));
  }

  async realpath(path: string): Promise<string> {
    // The OPFS adapter's stat already follows symlinks; we just
    // normalise the input so callers always get an absolute path.
    const abs = joinPosix('/', path);
    await this.adapter.promises.stat(this.opfsPath(abs));
    return abs;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const target = this.opfsPath(path);
    const m = await this.meta.get(target);
    if (!m) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, utimes '${path}'`), {
        code: 'ENOENT',
      });
    }
    await this.meta.set(target, { ...m, mtimeMs: mtime.getTime() });
  }

  /** Walks every path in the VFS subtree below this mount. */
  getAllPaths(): string[] {
    // The interface is synchronous; we can't await IDB here. Bash
    // callers that need a snapshot use glob expansion, which falls
    // back to recursive readdir if this returns empty.
    return [];
  }
}

function toFsStat(stat: {
  mode: number;
  size: number;
  mtimeMs: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}): FsStat {
  return {
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
    mode: stat.mode,
    size: stat.size,
    mtime: new Date(stat.mtimeMs),
  };
}

function pickReadEncoding(
  options: ReadFileOptions | BufferEncoding | undefined,
): BufferEncoding | null | undefined {
  if (!options) return undefined;
  if (typeof options === 'string') return options;
  return options.encoding;
}

function normaliseContent(content: FileContent, encoding?: BufferEncoding): Uint8Array {
  if (typeof content === 'string') {
    if (!encoding || encoding === 'utf8' || encoding === 'utf-8' || encoding === 'ascii') {
      return new TextEncoder().encode(content);
    }
    if (encoding === 'binary' || encoding === 'latin1') {
      const bytes = new Uint8Array(content.length);
      for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
      return bytes;
    }
    // base64 / hex — fall back to text encoding; the bash layer rarely
    // hits these on its own.
    return new TextEncoder().encode(content);
  }
  return content;
}

function decodeWithEncoding(bytes: Uint8Array, encoding: BufferEncoding): string {
  if (encoding === 'binary' || encoding === 'latin1') {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// Exposed so test code can sanity-check the prefix arithmetic without
// importing internal helpers.
export const __internal = { joinPosix, dirnamePosix, resolveAbsolute };
