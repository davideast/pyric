import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

export const probe: Probe = {
  description:
    "firebase/app FirebaseError is a real Error subclass: new FirebaseError(code, message) has name 'FirebaseError', constructor.name 'FirebaseError', a readable .code, the given .message verbatim (no wrapper when constructed directly), is an instanceof Error, and an instanceof FirebaseError.",
  matrixRow: 'app #12',
  rowIds: ['app#12'],
  async observe() {
    const e = new FirebaseError('app/probe-code', 'probe message');
    return {
      errorName: e.name,
      ctorName: e.constructor.name,
      code: e.code,
      message: e.message,
      isError: e instanceof Error,
      isFirebaseError: e instanceof FirebaseError,
    };
  },
};
