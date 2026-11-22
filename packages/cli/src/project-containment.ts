/**
 * Canonical realpath containment checks for project-scoped directories.
 *
 * Resolves path segments left-to-right (matching POSIX symlink resolution
 * while preserving non-existent terminal segments and failing closed on
 * `..` across missing/non-directory components, symlink cycles, and NUL
 * bytes) so symlinks or traversal segments that leave the root are rejected
 * consistently across Studio workspace routes, MCP path arguments, the
 * static file server, and modular rules imports.
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';

/** Maximum symlink expansions before treating a path as a cycle (POSIX SYMLOOP_MAX). */
const MAX_SYMLINK_DEPTH = 40;

const SEGMENT_SPLIT = sep === '\\' ? /[/\\]+/ : /\/+/;

/** Thrown when resolving a path encounters a symbolic link cycle (`ELOOP`). */
export class PathContainmentCycleError extends Error {
  constructor(targetPath: string) {
    super(`symbolic link cycle while resolving path: '${targetPath}'`);
    this.name = 'PathContainmentCycleError';
  }
}

/**
 * Thrown when resolving a path encounters a NUL byte, empty symlink target,
 * or traversal across a non-existent or non-directory component.
 */
export class PathContainmentTraversalError extends Error {
  constructor(targetPath: string) {
    super(`invalid path traversal while resolving path: '${targetPath}'`);
    this.name = 'PathContainmentTraversalError';
  }
}

const UNRESOLVABLE_CONTAINMENT_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EINVAL',
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

function splitRawSegments(
  rawPath: string,
  originalTarget: string,
): { root: string; segments: string[] } {
  if (rawPath.includes('\0')) {
    throw new PathContainmentTraversalError(originalTarget);
  }
  if (isAbsolute(rawPath)) {
    const parsedRoot = parse(rawPath).root;
    const tail = rawPath.slice(parsedRoot.length);
    const segments = tail.split(SEGMENT_SPLIT).filter((part) => part.length > 0);
    return { root: parsedRoot, segments };
  }
  const segments = rawPath.split(SEGMENT_SPLIT).filter((part) => part.length > 0);
  return { root: '', segments };
}

function pushSegmentsReversed(stack: string[], segments: readonly string[]): void {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const part = segments[i];
    if (part !== undefined) stack.push(part);
  }
}

function inspectPathState(canonicalPath: string): { missing: boolean; nonDir: boolean } {
  try {
    const stat = lstatSync(canonicalPath);
    return { missing: false, nonDir: !stat.isDirectory() };
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    if (code === 'ENOENT') return { missing: true, nonDir: false };
    if (code === 'ENOTDIR') return { missing: false, nonDir: true };
    throw error;
  }
}

function walkCanonicalSegments(
  startDir: string,
  startMissing: boolean,
  startNonDir: boolean,
  rawSegments: readonly string[],
  originalTarget: string,
): string {
  let current = startDir;
  let crossedMissing = startMissing;
  let currentIsNonDir = startNonDir;
  let symlinkDepth = 0;
  const stack: string[] = [];
  pushSegmentsReversed(stack, rawSegments);

  while (stack.length > 0) {
    const segment = stack.pop();
    if (segment === undefined || segment === '') {
      continue;
    }
    if (segment === '.') {
      if (currentIsNonDir) {
        throw new PathContainmentTraversalError(originalTarget);
      }
      continue;
    }
    if (segment === '..') {
      if (crossedMissing || currentIsNonDir) {
        throw new PathContainmentTraversalError(originalTarget);
      }
      current = dirname(current);
      continue;
    }
    if (currentIsNonDir) {
      throw new PathContainmentTraversalError(originalTarget);
    }

    const next = join(current, segment);
    if (crossedMissing) {
      current = next;
      continue;
    }

    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(next);
    } catch (error: unknown) {
      const code = errorCodeOf(error);
      if (code === 'ENOENT') {
        crossedMissing = true;
        current = next;
        continue;
      }
      if (code === 'ENOTDIR') {
        throw new PathContainmentTraversalError(originalTarget);
      }
      if (code === 'ELOOP') {
        throw new PathContainmentCycleError(originalTarget);
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      symlinkDepth += 1;
      if (symlinkDepth > MAX_SYMLINK_DEPTH) {
        throw new PathContainmentCycleError(originalTarget);
      }
      const linkTarget = readlinkSync(next);
      if (linkTarget.length === 0) {
        throw new PathContainmentTraversalError(originalTarget);
      }
      const parsedLink = splitRawSegments(linkTarget, originalTarget);
      if (parsedLink.root !== '') {
        current = parsedLink.root;
        crossedMissing = false;
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

function resolveFromCanonicalRoot(canonicalRoot: string, candidate: string): string {
  if (candidate.includes('\0')) {
    throw new PathContainmentTraversalError(candidate);
  }
  if (isAbsolute(candidate)) {
    return getCanonicalPath(candidate);
  }
  const rootState = inspectPathState(canonicalRoot);
  const parsed = splitRawSegments(candidate, candidate);
  return walkCanonicalSegments(
    canonicalRoot,
    rootState.missing,
    rootState.nonDir,
    parsed.segments,
    candidate,
  );
}

/**
 * Resolve the canonical realpath of `targetPath` using POSIX left-to-right
 * segment resolution, following symbolic links without pre-collapsing `..`
 * across symlinks and preserving non-existent terminal segments.
 */
export function getCanonicalPath(targetPath: string): string {
  const parsed = splitRawSegments(targetPath, targetPath);
  if (parsed.root !== '') {
    return walkCanonicalSegments(parsed.root, false, false, parsed.segments, targetPath);
  }
  const canonicalCwd = getCanonicalPath(process.cwd());
  const cwdState = inspectPathState(canonicalCwd);
  return walkCanonicalSegments(
    canonicalCwd,
    cwdState.missing,
    cwdState.nonDir,
    parsed.segments,
    targetPath,
  );
}

/**
 * Resolve `candidate` relative to `rootDir` (or as an absolute path) using
 * POSIX left-to-right symlink resolution without collapsing `..` before
 * symlinks.
 */
export function resolveCanonicalPath(rootDir: string, candidate: string): string {
  if (rootDir.includes('\0') || candidate.includes('\0')) {
    throw new PathContainmentTraversalError(candidate);
  }
  const canonicalRoot = getCanonicalPath(rootDir);
  return resolveFromCanonicalRoot(canonicalRoot, candidate);
}

/** Check whether canonical `target` is `root` itself or strictly inside `root`. */
export function isContained(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

/**
 * Resolve `candidate` (absolute or relative to `root`) through POSIX
 * left-to-right realpath resolution and return its canonical path when it
 * stays within canonical `root`, or `null` when it escapes, contains NUL
 * bytes, traverses `..` through a missing/non-dir segment, loops, or cannot
 * be resolved.
 */
export function realPathWithin(root: string, candidate: string): string | null {
  if (root.includes('\0') || candidate.includes('\0')) {
    return null;
  }
  try {
    const canonicalRoot = getCanonicalPath(root);
    const canonicalTarget = resolveFromCanonicalRoot(canonicalRoot, candidate);
    if (!isContained(canonicalRoot, canonicalTarget)) {
      return null;
    }
    return canonicalTarget;
  } catch (error: unknown) {
    if (
      error instanceof PathContainmentCycleError ||
      error instanceof PathContainmentTraversalError
    ) {
      return null;
    }
    const code = errorCodeOf(error);
    if (code !== undefined && UNRESOLVABLE_CONTAINMENT_CODES.has(code)) {
      return null;
    }
    throw error;
  }
}
