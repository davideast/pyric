import { joinPath, pathSegments } from './sandbox/data-tree.js';
import { emptySpec } from './sandbox/query.js';
import { tag, targetOf, type SandboxLiveTarget, type SandboxTarget } from './routing.js';
import { QUERY_SYMBOL, type Database, type DatabaseReference, type Query } from './types.js';
import { queryIdentifier } from './query-shape.js';

// ─── Reference constructors ──────────────────────────────────────────

/**
 * Build a {@link DatabaseReference} at `path` (default root).
 *
 * Path normalisation: leading + trailing slashes are stripped;
 * empty path / `'/'` becomes the root.
 */
export function ref(db: Database, path?: string): DatabaseReference {
  const target = targetOf(db);
  if (path !== undefined) validateReferencePath(path, true);
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
  validateReferencePath(path, false);
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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `pyric/database: refFromURL received a value that is not an absolute URL: ${url}`,
    );
  }
  if (parsed.hash !== '') {
    throw new Error(
      'refFromURL failed: url argument must be a valid firebase URL and the path can\'t contain ".", "#", "$", "[", or "]".',
    );
  }
  return ref(db, parsed.pathname);
}

function validateReferencePath(path: string, allowEmpty: boolean): void {
  if ((!allowEmpty && path.length === 0) || /[.#$[\]]/.test(path)) {
    throw new Error(
      `child failed: path argument was an invalid path = "${path}". Paths must be non-empty strings and can't contain ".", "#", "$", "[", or "]"`,
    );
  }
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
    _spec: emptySpec(),
    [QUERY_SYMBOL]: true,
    get ref() {
      return self;
    },
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
    toJSON() {
      return self.toString();
    },
    isEqual(other: Query | null) {
      if (!other || typeof other !== 'object' || !('ref' in other) || !('_spec' in other)) return false;
      try {
        return targetOf(other.ref as unknown as object) === target
          && other.ref._path === canonical
          && queryIdentifier(other._spec) === 'default';
      } catch {
        return false;
      }
    },
  };
  tag(self as unknown as object, target);
  return self;
}
