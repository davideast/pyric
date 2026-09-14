import { FirebaseError } from '../../sandbox/internal/firebase-error.js';
import { isPlainObject } from '../plain-object.js';

/** Reject invalid document roots before an adapter captures or queues a write. */
export function requireDocumentData(value: unknown): Record<string, unknown> {
  const isDocumentData = isPlainObject(value);
  if (isDocumentData) return value;
  throw new FirebaseError('invalid-argument', 'Document data must be a plain object.');
}
