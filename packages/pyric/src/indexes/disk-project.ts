/**
 * Browser-clean lazy disk project loader for `ExtractFirestoreIndexesHandler`.
 *
 * Resolves target `paths` against an optional `projectDir`, rejects symbolic
 * links via `lstatSync`, locates a single unified project root, loads all
 * non-symlink `tsconfig*.json` files and project sources relative to that root,
 * and computes `clientRoots` so sibling helpers and path aliases resolve.
 */
import {
  posixDirname,
  posixJoin,
  posixNormalize,
  posixRelative,
  toPosixPath,
} from '../assurance-surface/code/posix-path.js';
import { isExcludedPath } from '../assurance-surface/code/program.js';

const MAX_SOURCE_BYTES = 400_000;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TSCONFIG_NAME = /^tsconfig(?:\.[\w-]+)?\.json$/;
const PROJECT_MARKERS = ['tsconfig.json', 'jsconfig.json', 'firebase.json', 'package.json'];
const EXCLUDED_DIR_SEGMENT = /^(?:__tests__|__mocks__|test|tests)$/;
const EXCLUDED_TEST_EXT = /\.(?:test|spec|pw)\.([cm]?[jt]sx?)$/;
const EXCLUDED_MIN_EXT = /\.min\.([cm]?js)$/;
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.output',
  '.turbo',
  '.vercel',
  '.firebase',
  '.pyric',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
]);

interface RawStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

interface RawFs {
  lstatSync(path: string): RawStat;
  readdirSync(dir: string): string[];
  readFileSync(path: string, encoding: 'utf-8'): string;
  realpathSync?: (path: string) => string;
}

interface RawPath {
  resolve(...paths: string[]): string;
}

interface RawOs {
  tmpdir(): string;
}

interface DiskBuiltins {
  fs: RawFs;
  path: RawPath;
  os: RawOs | undefined;
  homeDir: string | undefined;
}

export interface LoadedDiskFile {
  readonly name: string;
  readonly source: string;
  readonly displayName: string;
}

export type LoadDiskProjectResult =
  | {
      readonly ok: true;
      readonly root: string;
      readonly files: LoadedDiskFile[];
      readonly configs: { name: string; source: string }[];
      readonly clientRoots: string[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly recoverable: boolean;
    };

interface ResolvedTarget {
  readonly rawPath: string;
  readonly abs: string;
  readonly isDir: boolean;
  readonly source?: string;
}

function acquireBuiltins(): DiskBuiltins | null {
  const proc = (
    globalThis as {
      process?: {
        getBuiltinModule?: (id: string) => unknown;
        env?: Record<string, string | undefined>;
      };
    }
  ).process;
  const get = proc?.getBuiltinModule;
  if (typeof get !== 'function') return null;
  const fs = get.call(proc, 'node:fs') as RawFs | undefined;
  const path = get.call(proc, 'node:path') as RawPath | undefined;
  if (!fs || !path || typeof fs.lstatSync !== 'function') return null;
  const os = get.call(proc, 'node:os') as RawOs | undefined;
  return { fs, path, os, homeDir: proc?.env?.HOME };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function posixBasename(p: string): string {
  const norm = posixNormalize(p);
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return norm;
  return norm.slice(idx + 1);
}

function commonAncestorDir(dirs: readonly string[]): string {
  let acc = posixNormalize(dirs[0]!);
  for (let i = 1; i < dirs.length; i += 1) {
    const other = posixNormalize(dirs[i]!);
    while (acc !== '/' && other !== acc && !other.startsWith(`${acc}/`)) {
      acc = posixDirname(acc);
    }
  }
  return acc;
}

function hasExcludedDirBetween(ancestor: string, descendant: string): boolean {
  const rel = posixRelative(ancestor, descendant);
  if (rel === '' || rel.startsWith('..')) return false;
  return rel.split('/').some((seg) => EXCLUDED_DIR_SEGMENT.test(seg));
}

function sanitizeExplicitFileRel(relPath: string): string {
  const parts = relPath.split('/');
  const lastIdx = parts.length - 1;
  if (lastIdx >= 0) {
    parts[lastIdx] = parts[lastIdx]!
      .replace(EXCLUDED_TEST_EXT, '._pyric_case.$1')
      .replace(EXCLUDED_MIN_EXT, '._pyric_bundle.$1');
  }
  return parts.join('/');
}

function chooseProjectRoot(
  commonDir: string,
  absProjectDir: string | undefined,
  builtins: DiskBuiltins,
): string {
  const { fs, os, homeDir } = builtins;
  const tempRoots = new Set<string>(['/tmp', '/private/tmp', '/var/tmp']);
  if (os) {
    const rawTmp = posixNormalize(toPosixPath(os.tmpdir()));
    tempRoots.add(rawTmp);
    if (typeof fs.realpathSync === 'function') {
      try {
        tempRoots.add(posixNormalize(toPosixPath(fs.realpathSync(rawTmp))));
      } catch {
        // Keep rawTmp only when realpath fails.
      }
    }
  }
  const stopRoots = new Set<string>(['/', '/private', '/var', '/home', '/Users', '/usr', ...tempRoots]);
  if (homeDir) stopRoots.add(posixNormalize(toPosixPath(homeDir)));

  const hasMarker = (dir: string): boolean => {
    for (const marker of PROJECT_MARKERS) {
      try {
        const st = fs.lstatSync(posixJoin(dir, marker));
        if (st.isFile() && !st.isSymbolicLink()) return true;
      } catch {
        // Marker absent.
      }
    }
    return false;
  };

  let cur = commonDir;
  let topWalked = commonDir;
  while (!stopRoots.has(cur)) {
    topWalked = cur;
    if (absProjectDir !== undefined && cur === absProjectDir) return absProjectDir;
    if (hasMarker(cur)) return cur;
    if (EXCLUDED_DIR_SEGMENT.test(posixBasename(cur))) break;
    const parent = posixDirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  if (absProjectDir !== undefined) {
    const insideExplicit = commonDir === absProjectDir || commonDir.startsWith(`${absProjectDir}/`);
    if (insideExplicit && !hasExcludedDirBetween(absProjectDir, commonDir)) {
      return absProjectDir;
    }
  }

  if (tempRoots.has(posixDirname(topWalked))) return topWalked;
  return commonDir;
}

export function loadDiskProject(
  paths: readonly string[],
  projectDir?: string,
): LoadDiskProjectResult {
  const builtins = acquireBuiltins();
  if (!builtins) {
    return {
      ok: false,
      message:
        'The `paths` option reads from disk and requires a Node runtime; pass `files` with pre-loaded source instead.',
      recoverable: true,
    };
  }
  const { fs, path } = builtins;
  let absProjectDir: string | undefined;
  if (projectDir !== undefined) {
    absProjectDir = posixNormalize(toPosixPath(path.resolve(projectDir)));
  }
  const baseDir = absProjectDir ?? posixNormalize(toPosixPath(path.resolve('.')));

  const targets: ResolvedTarget[] = [];
  for (const rawPath of paths) {
    const abs = posixNormalize(toPosixPath(path.resolve(baseDir, rawPath)));
    let st: RawStat;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      return { ok: false, message: `Failed to read '${rawPath}': ${formatErr(err)}`, recoverable: false };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        message: `Failed to read '${rawPath}': symbolic links are not permitted`,
        recoverable: false,
      };
    }
    if (st.isDirectory()) {
      targets.push({ rawPath, abs, isDir: true });
      continue;
    }
    if (!st.isFile()) {
      return { ok: false, message: `Failed to read '${rawPath}': not a regular file`, recoverable: false };
    }
    try {
      const source = fs.readFileSync(abs, 'utf-8');
      targets.push({ rawPath, abs, isDir: false, source });
    } catch (err) {
      return { ok: false, message: `Failed to read '${rawPath}': ${formatErr(err)}`, recoverable: false };
    }
  }

  const targetDirs = targets.map((t) => {
    if (t.isDir) return t.abs;
    return posixDirname(t.abs);
  });
  const commonDir = commonAncestorDir(targetDirs);
  const root = chooseProjectRoot(commonDir, absProjectDir, builtins);

  const fileMap = new Map<string, LoadedDiskFile>();
  const configs: { name: string; source: string }[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const entry of entries) {
      const full = posixJoin(dir, entry);
      let st: RawStat;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry)) walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = posixRelative(root, full);
      if (isExcludedPath(rel, [])) continue;
      if (TSCONFIG_NAME.test(entry)) {
        try {
          configs.push({ name: rel, source: fs.readFileSync(full, 'utf-8') });
        } catch {
          // Unreadable tsconfig ignored.
        }
      } else if (SOURCE_EXTENSION.test(entry) && st.size <= MAX_SOURCE_BYTES) {
        try {
          fileMap.set(rel, { name: rel, source: fs.readFileSync(full, 'utf-8'), displayName: full });
        } catch {
          // Unreadable source ignored during background walk.
        }
      }
    }
  };

  walk(root);

  const clientRoots: string[] = [];
  for (const t of targets) {
    const rawRel = posixRelative(root, t.abs);
    if (t.isDir) {
      clientRoots.push(rawRel);
      continue;
    }
    const relKey = sanitizeExplicitFileRel(rawRel);
    fileMap.set(relKey, { name: relKey, source: t.source ?? '', displayName: t.rawPath });
    clientRoots.push(relKey);
  }

  return {
    ok: true,
    root,
    files: [...fileMap.values()],
    configs,
    clientRoots,
  };
}
