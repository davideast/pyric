import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import {
  observeSyncAuthAttempt,
  withClientAuthProbeSession,
} from '../../src/auth-user-probe-session.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'initializeAuth(app, deps?) returns a live Auth handle shared with getAuth(app), while repeated initializeAuth calls (or initializeAuth with deps after getAuth) throw auth/already-initialized.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ authSdk, createAuxiliaryClientApp, createProbeUser, nextEmail, nextUid }) => {
        const uid = nextUid('initauth');
        const email = nextEmail('initauth');
        const password = 'ProbePassword!123';
        await createProbeUser({ uid, email, password });

        const appInitFirst = createAuxiliaryClientApp('init-first');
        const initializedHandle = authSdk.initializeAuth(appInitFirst, {
          persistence: authSdk.inMemoryPersistence,
        });
        const getAfterInit = authSdk.getAuth(appInitFirst);

        const cred = await authSdk.signInWithEmailAndPassword(
          initializedHandle,
          email,
          password,
        );
        const liveHandleWorks = {
          appMatches: initializedHandle.app === appInitFirst,
          getAuthReturnsSameHandle: getAfterInit === initializedHandle,
          currentUserMatchesSignedIn: initializedHandle.currentUser === cred.user,
          uidMatchesCreatedUser: cred.user.uid === uid,
        };
        await authSdk.signOut(initializedHandle);

        const secondInitNoDeps = observeSyncAuthAttempt(
          () => authSdk.initializeAuth(appInitFirst),
          FirebaseError,
        );
        const secondInitWithDeps = observeSyncAuthAttempt(
          () =>
            authSdk.initializeAuth(appInitFirst, {
              persistence: authSdk.inMemoryPersistence,
            }),
          FirebaseError,
        );

        const appGetFirstNoDeps = createAuxiliaryClientApp('get-first-nodeps');
        const getFirstA = authSdk.getAuth(appGetFirstNoDeps);
        let initAfterGetNoDepsSameHandle = false;
        const initAfterGetNoDeps = observeSyncAuthAttempt(() => {
          const result = authSdk.initializeAuth(appGetFirstNoDeps);
          initAfterGetNoDepsSameHandle = result === getFirstA;
        }, FirebaseError);

        const appGetFirstWithDeps = createAuxiliaryClientApp('get-first-deps');
        authSdk.getAuth(appGetFirstWithDeps);
        const initAfterGetWithDeps = observeSyncAuthAttempt(
          () =>
            authSdk.initializeAuth(appGetFirstWithDeps, {
              persistence: authSdk.inMemoryPersistence,
            }),
          FirebaseError,
        );

        return {
          liveHandleWorks,
          secondInitNoDeps,
          secondInitWithDeps,
          initAfterGetNoDeps: {
            ...initAfterGetNoDeps,
            returnsSameHandleAsGetAuth: initAfterGetNoDepsSameHandle,
          },
          initAfterGetWithDeps,
        };
      },
    );
  },
};
