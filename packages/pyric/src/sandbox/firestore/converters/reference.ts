/**
 * Item 3 — DocumentReference converter.
 *
 * Wraps `firebase-admin` `DocumentReference` instances into our
 * {@link Reference} wrapper at the write boundary. Without this, a
 * rule like `resource.data.author is reference` returns false because
 * the evaluator detects references via `instanceof Reference`, not
 * via the admin SDK's class.
 *
 * Detection strategy — duck typing on the admin SDK shape:
 *   - has a `_path` private member (set in DocumentReference.constructor)
 *   - exposes a `path` getter that returns a string
 *   - exposes an `id` getter that returns a string
 *   - has a `_firestore` reference back to the Firestore client
 *
 * We don't `import { DocumentReference } from 'firebase-admin/firestore'`
 * and use `instanceof` because:
 *   1. The simulator package shouldn't take a hard dependency on
 *      firebase-admin (it's not a runtime requirement — only the
 *      consumer that seeds the simulator may choose to use admin
 *      types); and
 *   2. Multiple admin SDK versions can coexist in a workspace and
 *      `instanceof` would miss instances from a different copy.
 *
 * Idempotency: the converter only matches the admin SDK shape, never
 * our own {@link Reference} wrapper (which has no `_path` field), so
 * a second resolver pass is a no-op.
 */
import { KEEP, type ValueConverter } from '../value-resolver.js';
import { Reference } from 'pyric/rules/internal';

/** Minimal duck-type for admin SDK DocumentReference. */
interface AdminDocumentReferenceLike {
  readonly path: string;
  readonly id: string;
  readonly _path: unknown;
  readonly _firestore: unknown;
}

function isAdminDocumentReference(v: unknown): v is AdminDocumentReferenceLike {
  if (v === null || typeof v !== 'object') return false;
  // Must NOT be one of our own wrappers — those are already converted.
  if (v instanceof Reference) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.path === 'string' &&
    typeof o.id === 'string' &&
    o._path !== undefined &&
    o._firestore !== undefined
  );
}

export const documentReferenceConverter: ValueConverter = {
  name: 'document-reference',
  convert(value) {
    if (!isAdminDocumentReference(value)) return KEEP;
    return new Reference(value.path);
  },
};
