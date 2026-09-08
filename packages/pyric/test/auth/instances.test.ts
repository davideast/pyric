import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth } from '../../src/auth/index.js';

describe('Client Auth Handle Mutable tenantId State (R5)', () => {
  it('exposes a mutable tenantId property defaulting to null on Auth instances', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);

    expect(auth.tenantId).toBeNull();

    auth.tenantId = 'tenant-alpha';
    expect(auth.tenantId).toBe('tenant-alpha');

    auth.tenantId = null;
    expect(auth.tenantId).toBeNull();
  });
});
