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
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const PROBE_ID = 'auth-signin-empty-password-error';

describe('Auth signInWithEmailAndPassword empty-password probe (sdk-probes)', () => {
  test('registers staged pendingRowLink probe metadata and CLI preview until captured', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(emptyPasswordSignInProbe.rig).toBe('sdk-probes');
    expect(emptyPasswordSignInProbe.requires).toEqual(['web-config', 'admin-auth']);
    expect(emptyPasswordSignInProbe.pendingRowLink).toBe(true);
    expect(emptyPasswordSignInProbe.matrixRow).toBe('');
    expect(emptyPasswordSignInProbe.rowIds).toEqual([]);
    expect(emptyPasswordSignInProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured([PROBE_ID], {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

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

      expect(unknownArm.threw).toBe(true);
      expect(unknownArm.isFirebaseError).toBe(true);
      expect(unknownArm.code).toBe('auth/missing-password');
      expect(unknownArm.currentUserRemainsNull).toBe(true);
      expect(unknownArm.authStateListenerFires).toBe(0);
      expect(unknownArm.idTokenListenerFires).toBe(0);
      expect(String(unknownArm.message)).not.toContain(unknownEmail);

      expect(existingArm.threw).toBe(true);
      expect(existingArm.isFirebaseError).toBe(true);
      expect(existingArm.code).toBe('auth/missing-password');
      expect(existingArm.currentUserRemainsNull).toBe(true);
      expect(existingArm.authStateListenerFires).toBe(0);
      expect(existingArm.idTokenListenerFires).toBe(0);
      expect(String(existingArm.message)).not.toContain(existingEmail);

      expect(parityArm).toEqual({
        sameCode: true,
        sameMessage: true,
      });

      expect(signedInArm.signedInUidMatches).toBe(true);
      expect(signedInArm.threw).toBe(true);
      expect(signedInArm.code).toBe('auth/missing-password');
      expect(signedInArm.remainsSignedInAsExistingUid).toBe(true);
      expect(signedInArm.authStateListenerFires).toBe(0);
      expect(signedInArm.idTokenListenerFires).toBe(0);
    } finally {
      sandbox.dispose();
    }
  });
});
