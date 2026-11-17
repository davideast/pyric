/**
 * Observation canonicalization and `observations/**`-only diff guard shared by
 * `oracle-drift-report.ts` and `oracle-capture-pr.ts`.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const OBSERVATIONS_PREFIX = 'packages/conformance/observations/';
const SAFE_OBSERVATION_REL_PATH =
  /^packages\/conformance\/observations\/([a-z0-9-]+)\/([a-z0-9][a-z0-9._-]*)\.json$/;
const ROOT_GHA_CREDS_FILE = /^gha-creds-[A-Za-z0-9._-]+\.json$/;

export interface CollectedObservationChange {
  path: string;
  kind: 'added' | 'modified';
}

function stripObservedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripObservedAt);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'observedAt') continue;
      out[k] = stripObservedAt(v);
    }
    return out;
  }
  return value;
}

function sortedKeyReplacer() {
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((k) => [k, record[k]]),
      );
    }
    return value;
  };
}

/**
 * Parse an observation JSON string, drop volatile `observedAt` timestamps at
 * every nesting level, and re-serialize with sorted object keys. Non-JSON text
 * is returned verbatim so malformed captures surface as differences.
 */
export function canonicalizeObservation(content: string | null): string | null {
  if (content === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  return `${JSON.stringify(stripObservedAt(parsed), sortedKeyReplacer(), 2)}\n`;
}

export function validateObservationRelativePath(relPath: string): {
  surface: string;
  stem: string;
} {
  if (
    relPath.includes('..') ||
    relPath.includes('\\') ||
    relPath.includes('\0') ||
    relPath.startsWith('/')
  ) {
    throw new Error(`Unsafe observation path rejected: ${relPath}`);
  }
  const match = SAFE_OBSERVATION_REL_PATH.exec(relPath);
  if (!match) {
    throw new Error(
      `Path '${relPath}' is outside packages/conformance/observations/<surface>/<safe-name>.json`,
    );
  }
  const surface = match[1] ?? '';
  const stem = match[2] ?? '';
  if (stem.startsWith('gha-creds-')) {
    throw new Error(`Refusing credential filename stem '${stem}' in observation path '${relPath}'`);
  }
  return { surface, stem };
}

export function assertValidObservationEnvelope(relPath: string, content: string): void {
  const { stem } = validateObservationRelativePath(relPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    let reason = '';
    if (err instanceof Error) {
      reason = err.message;
    } else {
      reason = String(err);
    }
    throw new Error(`Invalid JSON in observation '${relPath}': ${reason}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Observation '${relPath}' must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.name !== stem) {
    throw new Error(
      `Observation '${relPath}' internal name '${String(record.name)}' does not match filename stem '${stem}'`,
    );
  }
  if (!Array.isArray(record.rowIds) || !record.rowIds.every((id) => typeof id === 'string')) {
    throw new Error(`Observation '${relPath}' must have a string[] rowIds field`);
  }
  if (typeof record.observedAt !== 'string' || !record.observedAt.trim()) {
    throw new Error(`Observation '${relPath}' must have a non-empty observedAt string`);
  }
  if (
    typeof record.behavior !== 'object' ||
    record.behavior === null ||
    Array.isArray(record.behavior)
  ) {
    throw new Error(`Observation '${relPath}' must have an object behavior field`);
  }
}

interface StatusRecord {
  xy: string;
  path: string;
  previousPath?: string;
}

function parsePorcelainZ(cwd: string): StatusRecord[] {
  const raw = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall', '-z'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const parts = raw.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const records: StatusRecord[] = [];
  for (let i = 0; i < parts.length; ) {
    const entry = parts[i] ?? '';
    i += 1;
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.includes('R') || xy.includes('C')) {
      const previousPath = parts[i] ?? '';
      i += 1;
      records.push({ xy, path, previousPath });
    } else {
      records.push({ xy, path });
    }
  }
  return records;
}

function headContentAt(cwd: string, relPath: string): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function isRegularRootGhaCredsFile(cwd: string, relPath: string): boolean {
  if (!ROOT_GHA_CREDS_FILE.test(relPath)) {
    return false;
  }
  try {
    const stat = lstatSync(join(cwd, relPath));
    return !stat.isSymbolicLink() && stat.isFile();
  } catch {
    return false;
  }
}

function assertValidRootGhaCredsEntries(cwd: string): void {
  for (const entry of readdirSync(cwd)) {
    if (!entry.startsWith('gha-creds-')) {
      continue;
    }
    if (!isRegularRootGhaCredsFile(cwd, entry)) {
      throw new Error(
        `Working tree contains invalid or non-regular root gha-creds entry '${entry}'`,
      );
    }
  }
}

function isEphemeralRootGhaCreds(cwd: string, record: StatusRecord): boolean {
  return (
    record.xy === '??' &&
    record.previousPath === undefined &&
    isRegularRootGhaCredsFile(cwd, record.path)
  );
}

/**
 * Asserts that the working tree in `cwd` has zero modified, staged, renamed,
 * deleted, or untracked files before capture starts, explicitly tolerating only
 * an untracked regular root `gha-creds-*.json` written by
 * `google-github-actions/auth@v2` even if `.gitignore` were absent or changed.
 */
export function assertCleanWorkingTreeForCapture(cwd: string): void {
  assertValidRootGhaCredsEntries(cwd);
  const dirty = parsePorcelainZ(cwd).filter((record) => !isEphemeralRootGhaCreds(cwd, record));
  if (dirty.length > 0) {
    const summary = dirty.map((record) => `${record.xy} ${record.path}`).join('\n');
    throw new Error(`Working tree must be clean before capture starts:\n${summary}`);
  }
}

/**
 * Inspects the working tree in `cwd` after a capture run:
 *   1. Fails closed if ANY modified, deleted, renamed, or untracked path is
 *      outside `packages/conformance/observations/<surface>/<safe-name>.json`,
 *      or if an observation was deleted, or is a symlink, or fails JSON
 *      envelope validation.
 *   2. Reverts modified observation files whose only difference vs `HEAD` is
 *      `observedAt` / object key ordering.
 *   3. Copies remaining genuine added/modified observation files into
 *      `bundleOutDir/<relPath>` and returns their sorted manifest records.
 */
export function collectTimestampCleanObservations(
  cwd: string,
  bundleOutDir: string,
): CollectedObservationChange[] {
  assertValidRootGhaCredsEntries(cwd);
  const statusRecords = parsePorcelainZ(cwd);
  const collected: CollectedObservationChange[] = [];

  for (const record of statusRecords) {
    if (isEphemeralRootGhaCreds(cwd, record)) {
      continue;
    }
    if (record.previousPath !== undefined) {
      throw new Error(
        `Unexpected rename '${record.previousPath}' -> '${record.path}' outside allowed observation writes`,
      );
    }
    if (!record.path.startsWith(OBSERVATIONS_PREFIX)) {
      throw new Error(
        `Capture modified or created path '${record.path}' outside packages/conformance/observations/**`,
      );
    }
    validateObservationRelativePath(record.path);
    if (record.xy.includes('D')) {
      throw new Error(`Capture unexpectedly deleted committed observation '${record.path}'`);
    }

    const absPath = join(cwd, record.path);
    const stat = lstatSync(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Capture produced non-regular file or symlink at '${record.path}'`);
    }

    const workText = readFileSync(absPath, 'utf8');
    assertValidObservationEnvelope(record.path, workText);

    const headText = headContentAt(cwd, record.path);
    if (headText !== null) {
      if (canonicalizeObservation(headText) === canonicalizeObservation(workText)) {
        execFileSync('git', ['checkout', '--', record.path], { cwd });
        continue;
      }
    }

    const dest = join(bundleOutDir, record.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(absPath, dest);
    collected.push({
      path: record.path,
      kind: headText === null ? 'added' : 'modified',
    });
  }

  return collected.sort((a, b) => a.path.localeCompare(b.path));
}
