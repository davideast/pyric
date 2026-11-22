import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';

import {
  captureAppSession,
  restoreAppSession,
} from '../../../../src/bridge/surface/methods/in-process-session-state.js';

describe('in-process-session-state', () => {
  it('captures and restores the signed-in app session and tenant scope', () => {
    const first = initializeSandbox();
    const firstAuth = getAuth(first);
    authSandbox.seedUsers(firstAuth, [
      { uid: 'alice', email: 'alice@example.com', password: 'secret', tenantId: 'tenant-a' },
    ]);
    authSandbox.restoreSession(firstAuth, 'alice');
    authSandbox.setTenantId(firstAuth, 'tenant-a');

    const captured = captureAppSession(first);
    expect(captured).toEqual({ uid: 'alice', tenantId: 'tenant-a' });

    const second = initializeSandbox();
    const secondAuth = getAuth(second);
    authSandbox.seedUsers(secondAuth, [
      { uid: 'alice', email: 'alice@example.com', password: 'secret', tenantId: 'tenant-a' },
    ]);
    restoreAppSession(second, captured);
    expect(secondAuth.currentUser?.uid).toBe('alice');
    expect(authSandbox.getTenantId(secondAuth)).toBe('tenant-a');
  });

  it('leaves a sandbox signed out when the captured uid is absent', () => {
    const sandbox = initializeSandbox();
    getAuth(sandbox);
    restoreAppSession(sandbox, { uid: 'deleted-user', tenantId: null });
    expect(getAuth(sandbox).currentUser).toBeNull();
  });
});
