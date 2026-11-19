import { describe, expect, it } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { getAuth, signInWithCustomToken, signOut } from 'pyric/auth';
import { mintCustomTokenFor } from 'pyric/auth/internal';
import {
  get,
  getAdminDatabase,
  getDatabase,
  onChildAdded,
  onValue,
  ref,
  sandbox as rtdbSandbox,
  set,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  AUTH_CHANGE_LIVE_ROUTING_RUN_RULES,
  observeAuthChangeLiveRouting,
  probe as authChangeLiveRoutingProbe,
} from '../../probes/rtdb-modular/rtdb-modular-auth-change-live-routing.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from '../src/staged-capture-assertions.ts';

const PROBE_NAME = 'rtdb-modular-auth-change-live-routing';

describe('rtdb-modular-auth-change-live-routing staged probe', () => {
  it('registers as a staged sdk-probes probe with dedicated-rtdb requirements via expectStagedUntilCaptured', async () => {
    expect(authChangeLiveRoutingProbe.rig).toBe('sdk-probes');
    expect(authChangeLiveRoutingProbe.pendingRowLink).toBe(true);
    expect(authChangeLiveRoutingProbe.rowIds).toEqual([]);
    expect(authChangeLiveRoutingProbe.requires).toEqual(['web-config', 'dedicated-rtdb']);

    const sdkProbes = await loadModularProbes('sdk-probes');
    expect(sdkProbes.map((entry) => entry.id)).toContain(PROBE_NAME);

    expectStagedUntilCaptured(PROBE_NAME, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
    });
  });

  it('executes observeAuthChangeLiveRouting deterministically on a single getDatabase(app) handle without volatile leaks', async () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(
      sandbox,
      { projectId: 'probe-unit' },
      `auth-change-probe-${Math.random()}`,
    );

    try {
      const db = getDatabase(app);
      const adminDb = getAdminDatabase(sandbox);
      const auth = getAuth(app);
      const runId = 'rtdb_unit_run_secret_id';
      const basePath = `/pyric_oracle/${runId}`;
      const aliceUid = 'pyric-unit-alice-secret';
      const bobUid = 'pyric-unit-bob-secret';

      rtdbSandbox.setRules(db, {
        rules: {
          '.read': false,
          '.write': false,
          pyric_oracle: {
            [runId]: AUTH_CHANGE_LIVE_ROUTING_RUN_RULES,
          },
        },
      });

      const observed = await observeAuthChangeLiveRouting({
        db: db as never,
        basePath,
        aliceUid,
        bobUid,
        ref: ref as never,
        get: get as never,
        set: set as never,
        onValue: onValue as never,
        onChildAdded: onChildAdded as never,
        async seedAdminData(subpath, value) {
          await set(ref(adminDb, `${basePath}/${subpath}`), value as never);
        },
        async signInAs(role) {
          let uid = bobUid;
          if (role === 'alice') {
            uid = aliceUid;
          }
          await signInWithCustomToken(auth, mintCustomTokenFor(auth, uid));
        },
        async signOut() {
          await signOut(auth);
        },
      });

      const serialized = JSON.stringify(observed);
      expect(serialized).not.toContain(runId);
      expect(serialized).not.toContain(aliceUid);
      expect(serialized).not.toContain(bobUid);

      expect(observed.initialSignedOut).toEqual({
        readAuthed: { ok: false, errorName: 'Error', code: 'PERMISSION_DENIED', val: null },
        writeAuthed: { ok: false, errorName: 'Error', code: 'PERMISSION_DENIED' },
        readPublic: { ok: true, errorName: null, code: null, val: { a: 1 } },
        initialPublicValues: [{ a: 1 }],
        initialPublicChildren: ['a:1'],
      });

      expect(observed.afterSignInAlice).toEqual({
        spuriousPublicValueDeliveries: 0,
        spuriousPublicChildDeliveries: 0,
        writeAliceOwn: { ok: true, errorName: null, code: null },
        writeBobOther: { ok: false, errorName: 'Error', code: 'PERMISSION_DENIED' },
        readAuthed: { ok: true, errorName: null, code: null, val: { seed: 10 } },
        initialAuthedValues: [{ seed: 10 }],
        initialAuthedChildren: ['seed:10'],
      });

      expect(observed.afterSwitchToBob).toEqual({
        spuriousPublicValueDeliveries: 0,
        spuriousPublicChildDeliveries: 0,
        spuriousAuthedValueDeliveries: 0,
        spuriousAuthedChildDeliveries: 0,
        writeBobOwn: { ok: true, errorName: null, code: null },
        writeAliceOther: { ok: false, errorName: 'Error', code: 'PERMISSION_DENIED' },
        readBobOwn: { ok: true, errorName: null, code: null, val: { role: 'member' } },
        readAliceOther: { ok: false, errorName: 'Error', code: 'PERMISSION_DENIED', val: null },
        authedWriteVisibleToSurvivingListeners: {
          authedValues: [{ seed: 10 }, { fromBob: 20, seed: 10 }],
          authedChildren: ['seed:10', 'fromBob:20'],
        },
      });

      expect(observed.afterSignOut).toEqual({
        authedValueCancelCodes: ['PERMISSION_DENIED'],
        authedChildCancelCodes: ['PERMISSION_DENIED'],
        spuriousPublicValueDeliveries: 0,
        spuriousPublicChildDeliveries: 0,
        writeAuthedDenied: { ok: false, errorName: 'Error', code: 'PERMISSION_DENIED' },
        readAuthedDenied: { ok: false, errorName: 'Error', code: 'PERMISSION_DENIED', val: null },
        publicWriteDeliveredToSurvivingListeners: {
          writeOutcome: { ok: true, errorName: null, code: null },
          publicValues: [{ a: 1 }, { a: 1, b: 2 }],
          publicChildren: ['a:1', 'b:2'],
        },
      });

      expect(observed.afterReSignInAlice).toEqual({
        writeAuthedAllowed: { ok: true, errorName: null, code: null },
        readAuthedAllowed: {
          ok: true,
          errorName: null,
          code: null,
          val: { fromBob: 20, reauthed: 30, seed: 10 },
        },
        cancelledAuthedValueCountUnchanged: true,
        cancelledAuthedChildCountUnchanged: true,
      });
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });
});
