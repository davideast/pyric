/**
 * Node-side `2+modules` resolver — the disk-reading public API. All the
 * resolution logic lives in `./resolver-core.js` (pure, no node imports);
 * this wrapper supplies the {@link ModuleFileReader} that reads relative
 * imports from `basePath` and stdlib modules from the package's on-disk
 * `stdlib/` directory.
 *
 * NODE-ONLY by construction (static `fs`/`path`/`url` imports). Browser
 * consumers use `./resolver-browser.js`, which binds the core to the
 * inlined stdlib and never touches this file — that separation is the
 * point: these node imports used to leak into browser bundles through
 * `resolver-browser`'s import chain (caught by the pyric-serve P0 validation).
 */
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadModuleWith,
  resolveModulesWith,
  type ModuleFileReader,
  type ResolveOptions,
  type ResolveResult,
} from './resolver-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDLIB_DIR = join(__dirname, 'stdlib');
const MAX_SYMLINK_DEPTH = 40;
const SEGMENT_SPLIT = sep === '\\' ? /[/\\]+/ : /\/+/;

const UNREADABLE_FS_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EINVAL',
  'EISDIR',
  'ELOOP',
  'ENAMETOOLONG',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);

function errorCodeOf(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function splitRawSegments(rawPath: string): { root: string; segments: string[] } | null {
  if (rawPath.includes('\0')) return null;
  if (isAbsolute(rawPath)) {
    const parsedRoot = parse(rawPath).root;
    const tail = rawPath.slice(parsedRoot.length);
    return {
      root: parsedRoot,
      segments: tail.split(SEGMENT_SPLIT).filter((part) => part.length > 0),
    };
  }
  return {
    root: '',
    segments: rawPath.split(SEGMENT_SPLIT).filter((part) => part.length > 0),
  };
}

function pushSegmentsReversed(stack: string[], segments: readonly string[]): void {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const part = segments[i];
    if (part !== undefined) stack.push(part);
  }
}

/**
 * Resolve an existing path left-to-right using `lstatSync` and `readlinkSync`
 * (avoiding runtime-dependent lexical `..` collapse in `realpathSync`).
 */
function walkExistingCanonical(
  startDir: string,
  rawSegments: readonly string[],
): string | null {
  let current = startDir;
  let currentIsNonDir = false;
  let symlinkDepth = 0;
  const stack: string[] = [];
  pushSegmentsReversed(stack, rawSegments);

  while (stack.length > 0) {
    const segment = stack.pop();
    if (segment === undefined || segment === '') continue;
    if (segment === '.') {
      if (currentIsNonDir) return null;
      continue;
    }
    if (segment === '..') {
      if (currentIsNonDir) return null;
      current = dirname(current);
      continue;
    }
    if (currentIsNonDir) return null;

    const next = join(current, segment);
    const stat = lstatSync(next);
    if (stat.isSymbolicLink()) {
      symlinkDepth += 1;
      if (symlinkDepth > MAX_SYMLINK_DEPTH) return null;
      const linkTarget = readlinkSync(next);
      if (linkTarget.length === 0) return null;
      const parsedLink = splitRawSegments(linkTarget);
      if (parsedLink === null) return null;
      if (parsedLink.root !== '') {
        current = parsedLink.root;
        currentIsNonDir = false;
      }
      pushSegmentsReversed(stack, parsedLink.segments);
      continue;
    }

    current = next;
    if (!stat.isDirectory()) {
      currentIsNonDir = true;
    }
  }

  return current;
}

function resolveExistingPath(targetPath: string): string | null {
  const parsed = splitRawSegments(targetPath);
  if (parsed === null) return null;
  if (parsed.root !== '') {
    return walkExistingCanonical(parsed.root, parsed.segments);
  }
  const canonicalCwd = resolveExistingPath(process.cwd());
  if (canonicalCwd === null) return null;
  return walkExistingCanonical(canonicalCwd, parsed.segments);
}

/**
 * Read `relativePath` beneath `rootDir` only when its POSIX left-to-right
 * realpath stays within canonical `rootDir`. Refuses `..` escapes, symlinks
 * pointing outside `rootDir`, symlink+`..` tricks, NUL bytes, and unreadable
 * entries by returning `null`.
 */
function readContainedRulesFile(rootDir: string, relativePath: string): string | null {
  if (rootDir.includes('\0') || relativePath.includes('\0') || isAbsolute(relativePath)) {
    return null;
  }
  try {
    const realRoot = resolveExistingPath(rootDir);
    if (realRoot === null || !lstatSync(realRoot).isDirectory()) {
      return null;
    }
    const parsedRel = splitRawSegments(relativePath);
    if (parsedRel === null) return null;
    const realTarget = walkExistingCanonical(realRoot, parsedRel.segments);
    if (realTarget === null) return null;
    const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
    if (realTarget !== realRoot && !realTarget.startsWith(prefix)) {
      return null;
    }
    return readFileSync(realTarget, 'utf-8');
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    if (code !== undefined && UNREADABLE_FS_CODES.has(code)) {
      return null;
    }
    throw error;
  }
}

const diskReader: ModuleFileReader = {
  readRelative(basePath, moduleName) {
    const fileName = moduleName.endsWith('.rules') ? moduleName : `${moduleName}.rules`;
    return readContainedRulesFile(basePath, fileName);
  },
  readStdlib(moduleName) {
    return readContainedRulesFile(STDLIB_DIR, `${moduleName}.rules`);
  },
};

/** Resolve a `2+modules` source, reading relative + stdlib modules from disk. */
export function resolveModules(source: string, options?: ResolveOptions): ResolveResult {
  return resolveModulesWith(diskReader, source, options);
}

/** Load one module with the disk reader (exposed for `rules/node` consumers). */
export function loadModule(moduleName: string, options?: ResolveOptions) {
  return loadModuleWith(diskReader, moduleName, options);
}

export {
  sanitizeModuleName,
  prefixPrivateFunctions,
  rewriteCalls,
  resolveAuthoredSourceLoc,
} from './resolver-core.js';
export type { ResolveOptions, ResolveResult, ModuleFileReader, AuthoredSourceLoc } from './resolver-core.js';
