import { scrubFirestoreOracleRunPath } from './firestore-probe-outcomes.ts';

interface FirestoreConstructorErrorShape {
  [key: string]: unknown;
  threw: boolean;
  errorName: string | null;
  isTypeError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  message: string | null;
}

export function observeFirestoreConstructorCall(
  fn: () => unknown,
  firebaseErrorCtor: abstract new (...args: never[]) => Error,
): FirestoreConstructorErrorShape {
  try {
    fn();
    return {
      threw: false,
      errorName: null,
      isTypeError: false,
      isFirebaseError: false,
      code: null,
      message: null,
    };
  } catch (err) {
    const candidate = err as { name?: unknown; code?: unknown; message?: unknown };
    let errorName: string | null = null;
    if (typeof candidate?.name === 'string') {
      errorName = candidate.name;
    }
    let code: string | null = null;
    if (typeof candidate?.code === 'string') {
      code = candidate.code;
    }
    let rawMessage = String(err);
    if (err instanceof Error) {
      rawMessage = err.message;
    }
    return {
      threw: true,
      errorName,
      isTypeError: err instanceof TypeError,
      isFirebaseError: err instanceof firebaseErrorCtor,
      code,
      message: scrubFirestoreOracleRunPath(rawMessage),
    };
  }
}

const AUTO_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

export function isFirestoreAutoIdShape(id: string): boolean {
  return AUTO_ID_PATTERN.test(id);
}
