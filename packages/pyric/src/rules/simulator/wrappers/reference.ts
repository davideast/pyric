/**
 * Reference wrapper — Item 3 of simulator-prod-parity.md.
 *
 * Reference surface (rules.Reference):
 *   - `.path`   — relative document path string ('users/u1')
 *   - `.id`     — last segment of the path ('u1')
 *   - `.parent` — parent collection path string ('users')
 *   - `is reference` — type test
 *   - `==` / `!=` against another Reference
 *
 * Per 0.B per-wrapper table:
 *   typeName: 'reference'
 *   valueOf:  NaN          (no meaningful numeric coercion — like Path/LatLng)
 *   toString: 'users/u1'   (relative path; round-trips with the admin SDK
 *                          DocumentReference.path getter)
 *   equals:   path-string equality (project/database not significant in
 *             the simulator — every Reference lives in the same logical DB)
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

export class Reference extends RulesValue {
  readonly typeName = 'reference';

  /** Relative document path, e.g. 'users/u1' or 'users/u1/posts/p1'. */
  readonly path: string;

  constructor(path: string) {
    super();
    // Normalize: strip any leading slash, trailing slash, or fully-qualified
    // `projects/.../documents/` prefix so internal compares are uniform.
    this.path = normalizeRelativePath(path);
  }

  /**
   * Construct from an admin-SDK-style fully-qualified resource name like
   * `projects/p/databases/(default)/documents/users/u1`. The fully-
   * qualified form is what `referenceValue` emits on the wire; using this
   * helper at the decode boundary keeps the relative-path invariant.
   */
  static fromResourceName(resourceName: string): Reference {
    return new Reference(stripDocumentsPrefix(resourceName));
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
    return { __type: 'reference', path: this.path };
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Reference)) return false;
    return this.path === other.path;
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

  callMethod(_method: string, _args: unknown[]): unknown | NoOp {
    // References have no callable methods in the rules language — the
    // admin SDK's get/set/update aren't exposed to rules. Returning
    // NO_OP triggers UnsupportedError so a rule like `ref.get()` fails
    // loudly rather than silently denying.
    return NO_OP;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

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
