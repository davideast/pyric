/**
 * Reference wrapper — Item 3 of simulator-prod-parity.md.
 *
 * Reference surface (rules.Reference):
 *   - `.path`   — relative document path string ('users/u1')
 *   - `.id`     — last segment of the path ('u1')
 *   - `.parent` — parent collection path string ('users')
 *   - `is path` — production Firestore CEL type test (`captures.json` `wire-forms`)
 *   - `is reference` — simulator backward-compatibility type test
 *   - `==` / `!=` against another Reference or `/databases/<db>/documents/<path>` Path
 *
 * Per 0.B per-wrapper table:
 *   typeName: 'reference'
 *   valueOf:  NaN          (no meaningful numeric coercion — like Path/LatLng)
 *   toString: 'users/u1'   (relative path; round-trips with the admin SDK
 *                          DocumentReference.path getter)
 *   equals:   databaseId + relative-path equality against Reference, and
 *             segment equality against `/databases/<databaseId>/documents/<path>` Path
 *   binaryOp: NO_OP (== / != route through equals)
 *
 * Why a relative-path-only wrapper rather than a full project/database/doc
 * model: Firestore rules see references as opaque path values. The
 * `referenceValue` wire encoding *does* need a fully-qualified
 * `projects/<p>/databases/<d>/documents/<path>` string for round-trip
 * with discover/wire.ts, but that's a write-out concern — the wire
 * encoder synthesizes a default qualifier on the way out. Inside the
 * simulator, two references are the same reference iff their relative
 * paths match.
 *
 * The admin SDK DocumentReference exposes more (e.g., `.firestore`,
 * `formattedName`); the rules language does not — we deliberately
 * shrink to the rules-visible surface so accidental `ref.firestore`
 * reads in a rule (which production would silently null out) match
 * the simulator.
 */
import { RulesValue, NO_OP, type NoOp } from './base.js';
import { Path } from './path.js';

export class Reference extends RulesValue {
  readonly typeName = 'reference';

  /** Relative document path, e.g. 'users/u1' or 'users/u1/posts/p1'. */
  readonly path: string;

  readonly bindings: Readonly<Record<string, string>> = {};

  /** Database identifier from a fully-qualified path, defaulting to `'(default)'`. */
  readonly databaseId: string;

  constructor(path: string, databaseId?: string) {
    super();
    this.databaseId = databaseId !== undefined && databaseId.length > 0
      ? databaseId
      : extractDatabaseId(path);
    // Normalize: strip any leading slash, trailing slash, or fully-qualified
    // `projects/.../documents/` prefix so internal compares are uniform.
    this.path = normalizeRelativePath(path);
  }

  /** Full rules.Path segments (`/databases/<databaseId>/documents/<path>`). */
  get segments(): readonly string[] {
    const relativeSegments = this.path.length > 0 ? this.path.split('/') : [];
    return ['databases', this.databaseId, 'documents', ...relativeSegments];
  }

  /** Equivalent `Path` wrapper representing `/databases/<databaseId>/documents/<path>`. */
  toPath(): Path {
    return new Path(this.segments, { ...this.bindings });
  }

  /**
   * Construct from an admin-SDK-style fully-qualified resource name like
   * `projects/p/databases/(default)/documents/users/u1`. The fully-
   * qualified form is what `referenceValue` emits on the wire; using this
   * helper at the decode boundary keeps the relative-path invariant.
   */
  static fromResourceName(resourceName: string): Reference {
    return new Reference(resourceName);
  }

  /** Last path segment; '' for an empty path. */
  get id(): string {
    const i = this.path.lastIndexOf('/');
    return i === -1 ? this.path : this.path.slice(i + 1);
  }

  /**
   * Parent collection path as a string. For `users/u1` returns `users`;
   * for `users/u1/posts/p1` returns `users/u1/posts`. An empty string
   * if there is no parent (a root-level reference is degenerate, but
   * we don't throw to keep diagnostics-friendly).
   *
   * Returning a string (not a Reference) matches Firestore rules' lack of
   * a CollectionReference type — collections aren't first-class values in
   * rules. Agents that want to compare against a collection path do so by
   * string equality, which this supports.
   */
  get parent(): string {
    const i = this.path.lastIndexOf('/');
    return i === -1 ? '' : this.path.slice(0, i);
  }

  // ─── RulesValue contract ─────────────────────────────────────────────

  valueOf(): number {
    return NaN; // No meaningful numeric coercion (matches Path, LatLng).
  }

  toString(): string {
    // Relative path matches the admin SDK DocumentReference.path getter
    // exactly, so a rule that does `string(ref) == 'users/u1'` works
    // without needing the fully-qualified form.
    return this.path;
  }

  toJSON(): unknown {
    if (this.databaseId !== '(default)') {
      return { __type: 'reference', path: this.path, databaseId: this.databaseId };
    }
    return { __type: 'reference', path: this.path };
  }

  equals(other: unknown): boolean {
    if (other instanceof Reference) {
      return this.databaseId === other.databaseId && this.path === other.path;
    }
    if (other instanceof Path) {
      return matchesPathSegments(this.databaseId, this.path, other.segments);
    }
    return false;
  }

  /**
   * Property dispatch. Mirrors the admin SDK read surface: `.path`,
   * `.id`, `.parent`. Anything else returns null (Firestore rules
   * "missing map key" shape, consistent with other wrappers).
   */
  field(name: string): unknown {
    switch (name) {
      case 'path': return this.path;
      case 'id': return this.id;
      case 'parent': return this.parent;
      default: return null;
    }
  }

  callMethod(method: string, args: unknown[]): unknown | NoOp {
    if (method === 'bind') {
      return this.toPath().callMethod(method, args);
    }
    return NO_OP;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function matchesPathSegments(
  databaseId: string,
  relPath: string,
  segments: readonly string[],
): boolean {
  const relativeSegments = relPath.length > 0 ? relPath.split('/') : [];
  if (segments.length !== 3 + relativeSegments.length) return false;
  if (segments[0] !== 'databases' || segments[1] !== databaseId || segments[2] !== 'documents') {
    return false;
  }
  for (let i = 0; i < relativeSegments.length; i++) {
    if (segments[3 + i] !== relativeSegments[i]) return false;
  }
  return true;
}

/**
 * Strip leading slash and any `projects/<p>/databases/<d>/documents/`
 * prefix to produce the relative path. Tolerates both forms because
 * agents may seed either shape.
 */
function normalizeRelativePath(path: string): string {
  let p = stripDocumentsPrefix(path);
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function stripDocumentsPrefix(s: string): string {
  const marker = '/documents/';
  const idx = s.indexOf(marker);
  if (idx === -1) return s;
  return s.slice(idx + marker.length);
}

function extractDatabaseId(s: string): string {
  const trimmed = s.replace(/^\/+|\/+$/g, '');
  const match = /^(?:projects\/[^/]+\/)?databases\/([^/]+)\/documents(?:\/|$)/.exec(trimmed);
  return match ? match[1]! : '(default)';
}

/**
 * Build the fully-qualified resource name used by Firestore's
 * `referenceValue` wire field. The simulator doesn't carry a real
 * project ID, so callers (the wire encoder) supply one — defaulting
 * to `'sim'` and database `'(default)'` keeps the round-trip intact
 * without inventing fake projects in the wrapper itself.
 */
export function referenceToResourceName(
  ref: Reference,
  projectId: string = 'sim',
  databaseId: string = '(default)',
): string {
  return `projects/${projectId}/databases/${databaseId}/documents/${ref.path}`;
}
