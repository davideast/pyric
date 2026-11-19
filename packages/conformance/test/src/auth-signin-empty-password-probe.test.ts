import { describe, expect, test } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
} from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeEmptyPasswordSignInSemantics,
  probe as emptyPasswordSignInProbe,
} from '../../probes/auth/auth-signin-empty-password-error.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';

const PROBE_ID = 'auth-signin-empty-password-error';

describe('Auth signInWithEmailAndPassword empty-password probe (sdk-probes)', () => {
  test('registers linked rowIds for auth#15a and includes probe in default sdk-probes selection', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(emptyPasswordSignInProbe.rig).toBe('sdk-probes');
    expect(emptyPasswordSignInProbe.requires).toEqual(['web-config', 'admin-auth']);
    expect(emptyPasswordSignInProbe.pendingRowLink).toBeUndefined();
    expect(emptyPasswordSignInProbe.matrixRow).toBe('auth#15a');
    expect(emptyPasswordSignInProbe.rowIds).toEqual(['auth#15a']);
    expect(emptyPasswordSignInProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    expect(unfilteredIds.has(PROBE_ID)).toBe(true);

    const explicitSelected = selectModularProbes(loaded, ['--probe', PROBE_ID], 'sdk-probes', {
      includeUncapturedStaged: false,
    }).map((entry) => entry.id);
    expect(explicitSelected).toEqual([PROBE_ID]);

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(lines.some((line) => line.includes(PROBE_ID))).toBe(true);
  });

  test('observes empty-password rejection across unknown and seeded accounts without listener fires or email leaks', async () => {
    const sandbox = initializeSandbox();
    try {
      const auth = getAuth(sandbox);
      const existingUid = 'synthetic-empty-pw-user';
      const existingEmail = 'seeded-empty-pw@example.com';
      const unknownEmail = 'unknown-empty-pw@example.com';
      const validPassword = 'ProbePassword!123';
      authSandbox.seedUsers(auth, [
        { uid: existingUid, email: existingEmail, password: validPassword },
      ]);

      const observed = await observeEmptyPasswordSignInSemantics({
        auth,
        firebaseErrorCtor: FirebaseError,
        unknownEmail,
        existingEmail,
        existingUid,
        validPassword,
        signInWithEmailAndPassword: (inst, email, password) =>
          signInWithEmailAndPassword(inst as never, email, password),
        onAuthStateChanged: (inst, cb) => onAuthStateChanged(inst as never, cb as never),
        onIdTokenChanged: (inst, cb) => onIdTokenChanged(inst as never, cb as never),
        settleListeners: async () => {
          for (let i = 0; i < 4; i += 1) {
            await Promise.resolve();
          }
        },
      });

      const unknownArm = observed.unknownEmailEmptyPassword as Record<string, unknown>;
      const existingArm = observed.existingUserEmptyPassword as Record<string, unknown>;
      const parityArm = observed.unknownMatchesExisting as Record<string, unknown>;
      const signedInArm = observed.whileSignedInEmptyPassword as Record<string, unknown>;

      expect(unknownArm).toEqual({
        threw: true,
        errorName: 'FirebaseError',
        isFirebaseError: true,
        code: 'auth/missing-password',
        message: 'Firebase: Error (auth/missing-password).',
        currentUserRemainsNull: true,
        authStateListenerFires: 0,
        idTokenListenerFires: 0,
      });

      expect(existingArm).toEqual({
        threw: true,
        errorName: 'FirebaseError',
        isFirebaseError: true,
        code: 'auth/missing-password',
        message: 'Firebase: Error (auth/missing-password).',
        currentUserRemainsNull: true,
        authStateListenerFires: 0,
        idTokenListenerFires: 0,
      });

      expect(parityArm).toEqual({
        sameCode: true,
        sameMessage: true,
      });

      expect(signedInArm).toEqual({
        signedInUidMatches: true,
        threw: true,
        errorName: 'FirebaseError',
        isFirebaseError: true,
        code: 'auth/missing-password',
        message: 'Firebase: Error (auth/missing-password).',
        remainsSignedInAsExistingUid: true,
        authStateListenerFires: 0,
        idTokenListenerFires: 0,
      });
    } finally {
      sandbox.dispose();
    }
  });
});
