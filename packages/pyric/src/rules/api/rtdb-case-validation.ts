/**
 * Whether one public {@link RtdbCase} describes a request the client SDK
 * would send. A case the SDK refuses before any rule runs is not evaluated:
 * `simulate` reports it UNSUPPORTED with the SDK's error text where a capture
 * records it. `rtdbRules(...).simulate`, the CLI's `rules.simulate` and
 * `rtdb_simulate_access`, and Studio's re-run all evaluate cases through
 * here.
 */

import { validateReferencePath, validateUpdatePaths } from '../../database/writable-path.js';
import { jsonEqual } from '../../sandbox/branches/state-diff.js';
import { simulationQueryProblem } from '../rtdb/simulation/spec.js';
import type { RtdbCase } from './case-types.js';

/** The message `check` throws, or null when it returns. */
function thrownMessage(check: () => void): string | null {
  try {
    check();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A path's segments. Unlike the sandbox's tree, any valid key is one,
 *  `__proto__` included, as production stores it (capture
 *  rules-rtdb-r52-prototype-named-keys). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function canonicalPath(path: string): string {
  return `/${segmentsOf(path).join('/')}`;
}

function isPatch(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type UpdateEntry = { path: string; value: unknown };

function isAbsoluteUpdateEntry(entry: unknown): entry is UpdateEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const path = (entry as { path?: unknown }).path;
  return typeof path === 'string' && path.length > 0 && path.startsWith('/');
}

/**
 * Paths written together, checked as the SDK checks `update()` keys: every
 * segment a valid key, and no path an ancestor or duplicate of another
 * (capture rtdb-modular-write-return-validation, `behavior.overlapping`).
 */
function writtenPathsProblem(paths: readonly string[]): string | null {
  const canonical = paths.map(canonicalPath);
  const repeated = canonical.find((path, index) => canonical.indexOf(path) !== index);
  if (repeated !== undefined) {
    return `update failed: values argument contains a path ${repeated} that is ancestor of another path ${repeated}`;
  }
  return thrownMessage(() => validateUpdatePaths(Object.fromEntries(paths.map((path) => [path, null])), segmentsOf));
}

function queryProblem(c: RtdbCase): string | null {
  if (c.query === undefined) return null;
  if (c.operation !== 'read') {
    return `a query applies to a 'read' case, and this case is '${c.operation}'.`;
  }
  return simulationQueryProblem(c.query);
}

/**
 * A write or validate case's `updates`: well formed, valid paths, and
 * naming the case's own `path` with the case's `newData`, since the case
 * evaluates `path`'s rules as one of the paths written.
 */
function updatesProblem(c: RtdbCase): string | null {
  if (c.updates === undefined) return null;
  if (c.operation !== 'write' && c.operation !== 'validate') {
    return `'updates' applies to a 'write' or 'validate' case, and this case is '${c.operation}'.`;
  }
  const updates: unknown = c.updates;
  if (!Array.isArray(updates)) return "'updates' must be an array of { path, value } entries.";
  if (!updates.every(isAbsoluteUpdateEntry)) {
    return "each 'updates' entry needs an absolute 'path' starting with '/'.";
  }
  const pathsProblem = writtenPathsProblem(updates.map((update) => update.path));
  if (pathsProblem !== null) return pathsProblem;
  const own = updates.find((update) => canonicalPath(update.path) === canonicalPath(c.path));
  if (own === undefined) {
    return `'updates' must list the case's path '${c.path}': the case evaluates that path's rules as one of the paths written. Use an 'update' case for the verdict on the whole update.`;
  }
  if (c.newData !== undefined && !jsonEqual(c.newData, own.value)) {
    return `newData differs from the value 'updates' writes at '${c.path}'. Give one value, or omit newData.`;
  }
  return null;
}

/** An `update` case's patch: an object of relative paths, checked as the SDK checks `update()`. */
function patchProblem(c: RtdbCase): string | null {
  if (c.operation !== 'update') return null;
  if (!isPatch(c.newData)) {
    return "an 'update' case needs newData to be an object keyed by the paths it writes.";
  }
  const keys = Object.keys(c.newData);
  if (keys.length === 0) return "an 'update' case needs newData to name at least one path.";
  return writtenPathsProblem(keys);
}

/**
 * Why the SDK would refuse `c` before sending it, or null when it would
 * send it. The case path is checked as `ref()` checks a path (capture
 * rtdb-modular-reference-shape-url, `referenceValidation.invalidRefPaths`).
 */
export function rtdbCaseProblem(c: RtdbCase): string | null {
  return thrownMessage(() => validateReferencePath(c.path, false))
    ?? queryProblem(c)
    ?? updatesProblem(c)
    ?? patchProblem(c);
}
