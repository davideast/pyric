import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getAuth, fetchSignInMethodsForEmail } from '../../src/auth/index.js';

describe('Email Enumeration Protection (CDD)', () => {
  test('fetchSignInMethodsForEmail resolves to empty array [] in accordance with production defaults', async () => {
    const app = initializeSandbox({ projectId: 'test-enum' });
    const auth = getAuth(app);
    const methods = await fetchSignInMethodsForEmail(auth, 'test@example.com');
    expect(methods).toEqual([]);
  });
});
