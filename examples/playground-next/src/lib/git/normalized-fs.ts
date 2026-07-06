/**
 * Path-normalizing + content-addressed stat wrapper for isomorphic-git
 * over the playground VFS. Shared by checkpoint commits and GitHub push.
 */
import type { OPFSAdapter } from '~/lib/vfs';

/** Resolve `.`/`..` segments the way the OPFS adapter does internally. */
export function normalizeGitPath(input: string): string {
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

/** FNV-1a (32-bit) over file bytes — staleness detection, not security. */
function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isGitInternal(path: string): boolean {
  return path.includes('/.git/') || path.endsWith('/.git');
}

export function normalizedAdapter(adapter: OPFSAdapter): OPFSAdapter {
  const p = adapter.promises;

  async function statWithContentIno(path: string, kind: 'stat' | 'lstat') {
    const st = await p[kind](path);
    if (!st.isFile() || isGitInternal(path)) return st;
    try {
      const data = await p.readFile(path);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      return { ...st, ino: fnv1a(bytes) };
    } catch {
      return st;
    }
  }

  return {
    promises: {
      readFile: (path, opts) => p.readFile(normalizeGitPath(path), opts),
      writeFile: (path, data, opts) => p.writeFile(normalizeGitPath(path), data, opts),
      unlink: (path) => p.unlink(normalizeGitPath(path)),
      readdir: (path) => p.readdir(normalizeGitPath(path)),
      mkdir: (path, opts) => p.mkdir(normalizeGitPath(path), opts),
      rmdir: (path, opts) => p.rmdir(normalizeGitPath(path), opts),
      stat: (path) => statWithContentIno(normalizeGitPath(path), 'stat'),
      lstat: (path) => statWithContentIno(normalizeGitPath(path), 'lstat'),
      symlink: (target, path) => p.symlink(target, normalizeGitPath(path)),
      readlink: (path) => p.readlink(normalizeGitPath(path)),
      chmod: (path, mode) => p.chmod(normalizeGitPath(path), mode),
    },
  };
}
