import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { createObservationGate } from '../../../../packages/conformance/src/observation-gate.ts';
import {
  observeListUsersDeletedCursor,
  type AdminAuthCursorSubject,
} from '../../../../packages/conformance/probes/auth-admin/admin-auth-listusers-deleted-cursor.ts';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAuth, type Auth } from '../../src/auth/index.js';
import { createWorkerBridgeRemoteAuth } from './worker-bridge-helper.js';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'conformance',
  'observations',
  'auth-admin',
);

const authAdminObsGate = createObservationGate({
  dir: OBS_DIR,
  match: (file) => file.startsWith('admin-auth-'),
});

function toCursorSubject(auth: Auth): AdminAuthCursorSubject {
  return {
    async createUser(uid: string): Promise<void> {
      await auth.createUser({ uid });
    },
    async deleteUser(uid: string): Promise<void> {
      await auth.deleteUser(uid);
    },
    async listUsers(maxResults: number, pageToken?: string) {
      return auth.listUsers(maxResults, pageToken);
    },
  };
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('oracle conformance (auth-admin)', () => {
  it('admin-auth-listusers-deleted-cursor (local and worker-bridge remote arms)', async () => {
    const expected = authAdminObsGate.load<Record<string, unknown>>(
      'admin-auth-listusers-deleted-cursor',
    );

    const localAuth = getAuth(
      initializeApp({ sandbox: initializeSandbox() }, 'oracle-auth-admin-local'),
    );
    const localActual = await observeListUsersDeletedCursor(
      toCursorSubject(localAuth),
      'oracle-local-cursor',
    );
    expect(localActual.deleteLastReturnedUser).toEqual(expected.deleteLastReturnedUser);
    expect(localActual.deleteNextBoundaryUser).toEqual(expected.deleteNextBoundaryUser);

    const remoteStack = await createWorkerBridgeRemoteAuth('oracle-auth-admin-remote');
    try {
      const remoteActual = await observeListUsersDeletedCursor(
        toCursorSubject(remoteStack.auth),
        'oracle-remote-cursor',
      );
      expect(remoteActual.deleteLastReturnedUser).toEqual(expected.deleteLastReturnedUser);
      expect(remoteActual.deleteNextBoundaryUser).toEqual(expected.deleteNextBoundaryUser);
    } finally {
      remoteStack.dispose();
    }
  });

  it('completeness: every observations/auth-admin/ capture is asserted', () => {
    const report = authAdminObsGate.report();
    expect(report.committed.length).toBe(1);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
