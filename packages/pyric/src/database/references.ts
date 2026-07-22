import { joinPath, pathSegments } from './sandbox/data-tree.js';
import { tag, targetOf, type SandboxLiveTarget, type SandboxTarget } from './routing.js';
import type { Database, DatabaseReference } from './types.js';

// ─── Reference constructors ──────────────────────────────────────────

/**
 * Build a {@link DatabaseReference} at `path` (default root).
 *
 * Path normalisation: leading + trailing slashes are stripped;
 * empty path / `'/'` becomes the root.
 */
export function ref(db: Database, path?: string): DatabaseReference {
  const target = targetOf(db);
  return buildSandboxRef(target, path ?? '/');
}

/**
 * Sub-path constructor. `child(ref, 'sub/path')` returns a ref at
 * `<ref>/sub/path`.
 *
 * Mirrors `firebase/database`'s `child(parent, path)` — leading +
 * empty segments stripped; the result inherits the parent's target.
 */
export function child(parent: DatabaseReference, path: string): DatabaseReference {
  const target = targetOf(parent as unknown as object);
  const absSegs = [...pathSegments(parent._path), ...pathSegments(path)];
  return buildSandboxRef(target, joinPath(absSegs));
}

/**
 * `refFromURL(db, url)` — build a {@link DatabaseReference} from an
 * absolute database URL (`https://<namespace>.firebaseio.com/path`).
 *
 * The sandbox is single-database, so only the URL path is honored; unlike the
 * production SDK, the host is not checked against the database namespace.
 */
export function refFromURL(db: Database, url: string): DatabaseReference {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw new Error(
      `pyric/database: refFromURL received a value that is not an absolute URL: ${url}`,
    );
  }
  return ref(db, path);
}

/**
 * Build a sandbox-backed `DatabaseReference`. Cached parent / root
 * pointers are computed lazily so a long chain doesn't materialise
 * every intermediate ref upfront.
 */
export function buildSandboxRef(
  target: SandboxTarget | SandboxLiveTarget,
  path: string,
): DatabaseReference {
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const self: DatabaseReference = {
    key,
    _path: canonical,
    get parent() {
      if (segs.length === 0) return null;
      return buildSandboxRef(target, joinPath(segs.slice(0, -1)));
    },
    get root() {
      return buildSandboxRef(target, '/');
    },
    toString() {
      return `sandbox://rtdb${canonical}`;
    },
  };
  tag(self as unknown as object, target);
  return self;
}
