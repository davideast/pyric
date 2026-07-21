import { FirebaseError } from '../sandbox/internal/firebase-error.js';

interface CodedError extends Error {
  code: string;
  denialContext?: unknown;
  remediation?: unknown;
}

function isCodedError(error: unknown): error is CodedError {
  return error instanceof Error
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string';
}

/** Translate sandbox-layer errors at the modular Firestore boundary. */
export function toFirestoreFirebaseError(error: unknown): unknown {
  if (error instanceof FirebaseError || !isCodedError(error)) return error;
  const customData: Record<string, unknown> = {};
  if (error.denialContext !== undefined) customData.denialContext = error.denialContext;
  if (error.remediation !== undefined) customData.remediation = error.remediation;
  return new FirebaseError(
    error.code,
    error.message,
    Object.keys(customData).length === 0 ? undefined : customData,
  );
}

export async function withFirestoreFirebaseError<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toFirestoreFirebaseError(error);
  }
}
