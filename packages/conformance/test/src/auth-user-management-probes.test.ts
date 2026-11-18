import { deleteApp, FirebaseError, initializeApp } from 'firebase/app';
import { getAuth, initializeAuth, inMemoryPersistence } from 'firebase/auth';
import { describe, expect, test } from 'bun:test';
import {
  observeAsyncAuthAttempt,
  observeSyncAuthAttempt,
} from '../../src/auth-user-probe-session.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as deleteUserProbe } from '../../probes/auth/auth-deleteuser-signout-and-followup-errors.ts';
import { probe as initAuthProbe } from '../../probes/auth/auth-initializeauth-lifecycle-and-deps.ts';
import { probe as reloadProbe } from '../../probes/auth/auth-reload-out-of-band-and-disabled-deleted.ts';
import { probe as updateCurrentUserProbe } from '../../probes/auth/auth-updatecurrentuser-set-and-null-signout.ts';

const AUTH_MGMT_PROBE_IDS = [
  'auth-deleteuser-signout-and-followup-errors',
  'auth-initializeauth-lifecycle-and-deps',
  'auth-reload-out-of-band-and-disabled-deleted',
  'auth-updatecurrentuser-set-and-null-signout',
] as const;

async function observeOfflineInitAuthLifecycle(runLabel: string) {
  const opts = {
    projectId: 'demo-auth-offline',
    apiKey: 'AIzaSyOfflineKey000000000000000000000000',
  };
  const app1 = initializeApp(opts, `offline-init-1-${runLabel}`);
  const app2 = initializeApp(opts, `offline-init-2-${runLabel}`);
  try {
    const a1 = initializeAuth(app1, { persistence: inMemoryPersistence });
    const getSame = getAuth(app1) === a1;
    const secondInit = observeSyncAuthAttempt(() => initializeAuth(app1), FirebaseError);

    const g2 = getAuth(app2);
    let noDepsSame = false;
    const afterGetNoDeps = observeSyncAuthAttempt(() => {
      noDepsSame = initializeAuth(app2) === g2;
    }, FirebaseError);
    const afterGetWithDeps = observeSyncAuthAttempt(
      () => initializeAuth(app2, { persistence: inMemoryPersistence }),
      FirebaseError,
    );
    const asyncOk = await observeAsyncAuthAttempt(async () => 'ok', FirebaseError);

    return {
      getSame,
      secondInit,
      afterGetNoDeps,
      noDepsSame,
      afterGetWithDeps,
      asyncOk,
    };
  } finally {
    await deleteApp(app1);
    await deleteApp(app2);
  }
}

describe('Auth user-management and session staged probes (sdk-probes)', () => {
  test('registers all 4 Auth user-management probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_MGMT_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [deleteUserProbe, initAuthProbe, reloadProbe, updateCurrentUserProbe];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'admin-auth']);
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(AUTH_MGMT_PROBE_IDS, {
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

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(lines.some((line) => line.includes('auth-initializeauth-lifecycle-and-deps'))).toBe(
      true,
    );
  });

  test('observes deterministic offline initializeAuth lifecycle without network I/O', async () => {
    const first = await observeOfflineInitAuthLifecycle('run-a');
    const second = await observeOfflineInitAuthLifecycle('run-b');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      getSame: true,
      secondInit: {
        threw: true,
        errorName: 'FirebaseError',
        isFirebaseError: true,
        code: 'auth/already-initialized',
      },
      afterGetNoDeps: {
        threw: false,
        errorName: null,
        isFirebaseError: false,
        code: null,
      },
      noDepsSame: true,
      afterGetWithDeps: {
        threw: true,
        errorName: 'FirebaseError',
        isFirebaseError: true,
        code: 'auth/already-initialized',
      },
      asyncOk: {
        threw: false,
        errorName: null,
        isFirebaseError: false,
        code: null,
      },
    });
  });
});
