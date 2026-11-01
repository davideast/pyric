import { isCustomDatabaseHost, parseDatabaseLocationUrl } from '../sandbox/internal/instances.js';
import { joinPath, pathSegments } from './sandbox/data-tree.js';
import { validateReferencePath } from './writable-path.js';
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
 * `refFromURL(db, url)`: build a {@link DatabaseReference} from an absolute
 * database URL (`https://<namespace>.firebaseio.com/path`).
 *
 * The URL is parsed with the SDK's rules, and as in the SDK a URL whose host
 * is not the database's host throws, unless the database's host is custom
 * (any domain but `firebaseio.com` and `firebaseio-demo.com`). A sandbox
 * database opened without a URL has no host, so its URLs are not checked.
 */
export function refFromURL(db: Database, url: string): DatabaseReference {
  const location = parseDatabaseLocationUrl(url);
  const instanceUrl = targetOf(db).instanceUrl;
  if (instanceUrl !== undefined) {
    assertSameHost(location.host, parseDatabaseLocationUrl(instanceUrl).host);
  }
  return ref(db, location.path);
}

function assertSameHost(found: string, expected: string): void {
  const hostsDiffer = found !== expected;
  if (hostsDiffer && !isCustomDatabaseHost(expected)) {
    throw new Error(
      `FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found ${found} but expected ${expected}) `,
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
