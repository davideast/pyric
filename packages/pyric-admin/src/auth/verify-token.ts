/**
 * Stateless ID token verification for `pyric-admin/auth`.
 * Routes token parsing across recognized decoder strategies.
 */
import type { DecodedIdToken } from './types.js';
import { SANDBOX_TOKEN_PREFIX, TOKEN_DECODERS } from './token-decoders.js';

/**
 * Parse a token minted by `createCustomToken` or a client ID token
 * minted by `pyric/auth`'s `getIdToken()`. Routes to the appropriate
 * modular token decoder based on token prefix.
 *
 * Throws on any token that doesn't match a recognized sandbox prefix —
 * including real JWTs that another verifier would parse. The sandbox
 * backends are intentionally not drop-ins for production verification.
 */
export function verifySandboxIdToken(idToken: string): Promise<DecodedIdToken> {
  const isInvalidTokenArgument = typeof idToken !== 'string';
  if (isInvalidTokenArgument) {
    return Promise.reject(
      new Error('pyric-admin/auth: verifyIdToken expects a string argument.'),
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  for (const decoder of TOKEN_DECODERS) {
    const matchesDecoderPrefix = idToken.startsWith(decoder.prefix);
    if (matchesDecoderPrefix) {
      try {
        return Promise.resolve(decoder.decode(idToken, nowSec));
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }
  return Promise.reject(
    new Error(
      'pyric-admin/auth: verifyIdToken on the sandbox backend only ' +
        'accepts tokens minted by this sandbox\'s createCustomToken or client getIdToken(). ' +
        `Token must begin with "${SANDBOX_TOKEN_PREFIX}:" or "sandbox-id-token-".`,
    ),
  );
}
