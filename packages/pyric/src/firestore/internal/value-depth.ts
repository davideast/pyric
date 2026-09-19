import { FirebaseError } from '../../sandbox/internal/firebase-error.js';

const MAX_ENCODED_DOCUMENT_DEPTH = 64;

/** Count encoded containers, including the root, before recursive value decoding. */
export function assertEncodedDocValueDepth(value: unknown): void {
  checkContainerDepth(value, 0);
}

function checkContainerDepth(value: unknown, parentDepth: number): void {
  const isScalar = value === null || typeof value !== 'object';
  if (isScalar) return;
  const depth = parentDepth + 1;
  const exceedsLimit = depth > MAX_ENCODED_DOCUMENT_DEPTH;
  if (exceedsLimit) {
    throw new FirebaseError('invalid-argument', 'Encoded document nesting exceeds 64 containers.');
  }
  for (const child of Object.values(value)) checkContainerDepth(child, depth);
}
