/**
 * The `auth` tool's argument vocabulary.
 *
 * The Admin SDK spells custom claims `customClaims` and the tenant `tenantId`,
 * while the client SDK and most rules examples say `claims` and `tenant`. That
 * gap is the most common wrong argument on this tool, so it has a rename rather
 * than a spelling guess.
 */
import { z } from 'zod';
import { FEDERATED_PROVIDER_IDS } from 'pyric/auth';
import type { Args, Fail, InvalidArguments } from '../method-types.js';
import { quoted } from '../closest-name.js';

/** The shortest password Firebase Authentication accepts. */
const MINIMUM_PASSWORD = 6;

export const RENAMES: Readonly<Record<string, string>> = {
  claims: 'customClaims',
  customUserClaims: 'customClaims',
  tenant: 'tenantId',
  tenantID: 'tenantId',
  userId: 'uid',
  user: 'uid',
  id: 'uid',
  name: 'displayName',
  limit: 'maxResults',
  pageSize: 'maxResults',
};

export const uid = z.string().describe('The user id.');

export const customClaims = z
  .record(z.unknown())
  .optional()
  .describe('Custom claims. Rules read them as request.auth.token.<name>.');

export const tenantId = z
  .string()
  .optional()
  .describe('Identity Platform tenant. Rules read it as request.auth.token.firebase.tenant.');

/**
 * The federated providers a credential may name, which is the set the sandbox
 * resolves a sign-in credential for. Email and password sign-in has its own
 * method, so `password` is not one of these.
 */
export const CREDENTIAL_PROVIDER_IDS = FEDERATED_PROVIDER_IDS;

/** The federated credential an app signs in with, under the SDK's own names. */
export const signInCredential = z
  .object({
    providerId: z
      .enum(CREDENTIAL_PROVIDER_IDS)
      .describe('The federated provider the credential comes from.'),
    idToken: z.string().optional().describe("The provider's id token. Not verified."),
    accessToken: z.string().optional().describe("The provider's access token. Not verified."),
    email: z
      .string()
      .describe('The address the credential asserts. The identity is created if it is unknown.'),
  })
  .describe('The credential the provider returned.');

/** The claims a minted custom token carries, as the Admin SDK names them. */
export const developerClaims = z
  .record(z.unknown())
  .optional()
  .describe('Claims to sign into the token. Rules read them as request.auth.token.<name>.');

/** Reject an email that is not an address and a password below the minimum. */
export function checkCredentials(args: Args, fail: Fail): InvalidArguments | null {
  if (typeof args.email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) {
    return fail(
      `email ${quoted(args.email)} is not an email address. Firebase Authentication requires a local part, an '@', and a domain.`,
      `Pass an address such as 'alice@example.com'.`,
      'email',
    );
  }
  if (typeof args.password === 'string' && args.password.length < MINIMUM_PASSWORD) {
    return fail(
      `password ${quoted(args.password)} is ${args.password.length} characters. Firebase Authentication requires at least ${MINIMUM_PASSWORD}.`,
      `Pass a password of ${MINIMUM_PASSWORD} characters or more.`,
      'password',
    );
  }
  return null;
}
