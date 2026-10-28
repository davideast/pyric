/**
 * `isFederatedProviderId` and `noMockConfiguredError`, the shared auth
 * foundation both planes use to refuse a credential pyric has no staged
 * result for (#1466).
 *
 * A federated id is one of the seven first-class Firebase ids or a custom
 * `oidc.<name>` / `saml.<name>` id. Matching is exact and case-sensitive,
 * as Firebase's is, so look-alikes of `password` and unknown ids are not
 * federated.
 */
import { describe, expect, it } from 'bun:test';
import { FEDERATED_PROVIDER_IDS } from 'pyric/auth';
import { isFederatedProviderId, noMockConfiguredError } from 'pyric/auth/internal';

const FEDERATED = [...FEDERATED_PROVIDER_IDS, 'oidc.acme', 'saml.corp'];

const NOT_FEDERATED = [
  'password',
  'Password',
  'password ',
  ' google.com',
  'Google.com',
  'emailLink',
  'phone',
  'anonymous',
  'firebase',
  'oidc.',
  'saml.',
  'oidc.acme corp',
  'OIDC.acme',
  'acme',
  '',
];

describe('isFederatedProviderId', () => {
  it('lists the seven first-class Firebase ids', () => {
    expect([...FEDERATED_PROVIDER_IDS]).toEqual([
      'google.com',
      'apple.com',
      'facebook.com',
      'github.com',
      'twitter.com',
      'microsoft.com',
      'yahoo.com',
    ]);
  });

  for (const id of FEDERATED) {
    it(`accepts ${JSON.stringify(id)}`, () => {
      expect(isFederatedProviderId(id)).toBe(true);
    });
  }

  for (const id of NOT_FEDERATED) {
    it(`refuses ${JSON.stringify(id)}`, () => {
      expect(isFederatedProviderId(id)).toBe(false);
    });
  }
});

describe('noMockConfiguredError', () => {
  it('builds the in-page signInWithCredential refusal', () => {
    const error = noMockConfiguredError('acme');
    expect(error.code).toBe('auth/no-mock-configured');
    expect(error.message).toBe(
      "Firebase: signInWithCredential(providerId: acme): no mock configured. Pre-stage with sandbox.mockSignInResult(auth, {user, providerId: 'acme', …}). (auth/no-mock-configured).",
    );
  });
});
