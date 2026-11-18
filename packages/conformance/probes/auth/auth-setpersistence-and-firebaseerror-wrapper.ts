import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';

interface ObservedFirebaseErrorShape {
  readonly threw: boolean;
  readonly isFirebaseError: boolean;
  readonly isError: boolean;
  readonly name: string | null;
  readonly code: string | null;
  readonly startsWithFirebasePrefix: boolean;
  readonly endsWithWrappedCode: boolean;
}

function inspectErrorShape(err: unknown): ObservedFirebaseErrorShape {
  const isFb = err instanceof FirebaseError;
  const isErr = err instanceof Error;
  const candidate = err as { name?: unknown; code?: unknown; message?: unknown };
  let name: string | null = null;
  if (typeof candidate?.name === 'string') {
    name = candidate.name;
  }
  let code: string | null = null;
  if (typeof candidate?.code === 'string') {
    code = candidate.code;
  }
  let startsWithFirebasePrefix = false;
  let endsWithWrappedCode = false;
  if (typeof candidate?.message === 'string') {
    startsWithFirebasePrefix = candidate.message.startsWith('Firebase: ');
    if (code !== null) {
      endsWithWrappedCode = candidate.message.endsWith(`(${code}).`);
    }
  }
  return {
    threw: true,
    isFirebaseError: isFb,
    isError: isErr,
    name,
    code,
    startsWithFirebasePrefix,
    endsWithWrappedCode,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'setPersistence accepts inMemoryPersistence, browserSessionPersistence, and browserLocalPersistence markers returning Promise<void>, and Auth errors are FirebaseError instances formatted with Firebase: <message> (<auth/...>).',
  async observe() {
    return withClientAuthProbeSession(async ({ auth, authSdk }) => {
      const memPromise = authSdk.setPersistence(auth, authSdk.inMemoryPersistence);
      const inMemoryIsPromise = memPromise instanceof Promise;
      const inMemoryResolvesUndefined = (await memPromise) === undefined;

      const sessionPromise = authSdk.setPersistence(auth, authSdk.browserSessionPersistence);
      const sessionIsPromise = sessionPromise instanceof Promise;
      const sessionResolvesUndefined = (await sessionPromise) === undefined;

      const localPromise = authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
      const localIsPromise = localPromise instanceof Promise;
      const localResolvesUndefined = (await localPromise) === undefined;

      let syncErrorShape: ObservedFirebaseErrorShape = {
        threw: false,
        isFirebaseError: false,
        isError: false,
        name: null,
        code: null,
        startsWithFirebasePrefix: false,
        endsWithWrappedCode: false,
      };
      try {
        new authSdk.SAMLAuthProvider('missing-saml-prefix');
      } catch (err) {
        syncErrorShape = inspectErrorShape(err);
      }

      let asyncInvalidEmailShape: ObservedFirebaseErrorShape = {
        threw: false,
        isFirebaseError: false,
        isError: false,
        name: null,
        code: null,
        startsWithFirebasePrefix: false,
        endsWithWrappedCode: false,
      };
      try {
        await authSdk.signInWithEmailAndPassword(auth, 'not-an-email', 'Secret!123');
      } catch (err) {
        asyncInvalidEmailShape = inspectErrorShape(err);
      }

      return {
        setPersistenceMarkers: {
          inMemoryIsPromise,
          inMemoryResolvesUndefined,
          sessionIsPromise,
          sessionResolvesUndefined,
          localIsPromise,
          localResolvesUndefined,
        },
        firebaseErrorShape: {
          syncArgumentError: syncErrorShape,
          asyncInvalidEmail: asyncInvalidEmailShape,
        },
      };
    });
  },
};
