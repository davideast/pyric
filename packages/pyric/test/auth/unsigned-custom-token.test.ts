/**
 * The sandbox redeems only the signed custom token `createCustomToken` mints
 * (#2009). Production verifies every custom token's signature, so each
 * unsigned shape the sandbox once read unchecked is refused with
 * `auth/invalid-custom-token`, the code the client SDK maps the server's
 * `INVALID_CUSTOM_TOKEN` to, and leaves the session alone.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getAuth, signInWithCustomToken } from '../../src/auth/index.js';
import { mintCustomTokenFor } from '../../src/auth/internal.js';
import { CUSTOM_TOKEN_AUDIENCE } from '../../src/sandbox/internal/index.js';
import { unsignedCustomTokens } from './fixtures/unsigned-custom-tokens.js';

describe('signInWithCustomToken refuses unsigned custom tokens', () => {
  for (const [shape, token] of Object.entries(unsignedCustomTokens(CUSTOM_TOKEN_AUDIENCE))) {
    it(`refuses ${shape}`, async () => {
      const auth = getAuth(initializeSandbox());
      await expect(signInWithCustomToken(auth, token)).rejects.toMatchObject({ code: 'auth/invalid-custom-token' });
      expect(auth.currentUser).toBeNull();
    });
  }

  it('still redeems the token createCustomToken mints', async () => {
    const auth = getAuth(initializeSandbox());
    const { user } = await signInWithCustomToken(auth, mintCustomTokenFor(auth, 'ada', { role: 'editor' }));
    expect(user.uid).toBe('ada');
    expect((await user.getIdTokenResult()).claims.role).toBe('editor');
  });
});
