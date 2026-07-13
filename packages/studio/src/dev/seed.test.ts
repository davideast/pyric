import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { seedAuth } from './seed.js';

describe('Studio Auth dev seed', () => {
  it('seeds provider provenance as Auth data rather than custom claims', async () => {
    const auth = getAuth(initializeSandbox());
    await seedAuth(auth);
    const users = authSandbox.listUsers(auth);

    const alice = users.find((user) => user.uid === 'alice');
    expect(alice?.providerUserInfo).toEqual([{ providerId: 'google.com' }]);
    expect(alice?.customClaims).toEqual({ plan: 'pro' });

    const anonymous = users.find((user) => user.isAnonymous);
    expect(anonymous).toBeDefined();
    expect(anonymous?.providerUserInfo).toEqual([]);
  });
});
