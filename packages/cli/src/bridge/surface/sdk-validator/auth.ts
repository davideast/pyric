/**
 * The `auth` tool: the Admin SDK's user management method names, plus the
 * identity methods, which have no Admin SDK counterpart because the sandbox
 * lets a caller become a user rather than mint a token for one.
 *
 * The Admin SDK spells custom claims `customClaims` and the tenant `tenantId`,
 * while the client SDK and most rules examples say `claims` and `tenant`. That
 * gap is the most common wrong argument on this tool, so it has a rename rather
 * than a spelling guess.
 *
 * `impersonate`, `actAsAdmin`, `actAsAnonymous`, and `useAppSession` change
 * what the agent's own later calls run as; `whoami` reports it. None of them
 * takes a `mode` enum: the eval that measured this surface found every
 * rejection on the tool traced back to `signInAs(mode)`'s invented enum, so
 * the mode each method picks is its own name instead of an argument.
 */
import { z } from 'zod';
import type { Args, Fail, InvalidArguments, MethodSpec, ToolSpec } from './shared.js';
import { quoted } from './shared.js';

/** The shortest password Firebase Authentication accepts. */
const MINIMUM_PASSWORD = 6;

const RENAMES: Readonly<Record<string, string>> = {
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

const uid = z.string().describe('The user id.');
const customClaims = z
  .record(z.unknown())
  .optional()
  .describe('Custom claims. Rules read them as request.auth.token.<name>.');
const tenantId = z
  .string()
  .optional()
  .describe('Identity Platform tenant. Rules read it as request.auth.token.firebase.tenant.');

/** Reject an email that is not an address and a password below the minimum. */
function checkCredentials(args: Args, fail: Fail): InvalidArguments | null {
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

const METHODS: readonly MethodSpec[] = [
  {
    name: 'createUser',
    sdkOrigin: 'firebase-admin',
    signature: 'createUser(uid?, email?, password?, displayName?, customClaims?, tenantId?)',
    summary: 'Seed a user in the sandbox user pool.',
    args: z.object({
      uid: z.string().optional().describe('User id. Generated when omitted.'),
      email: z.string().optional().describe('Email address.'),
      password: z.string().optional().describe('At least six characters. Never returned.'),
      displayName: z.string().optional().describe('Display name.'),
      customClaims,
      tenantId,
    }),
    operations: ['create_auth_user'],
    renames: RENAMES,
    example: {
      uid: 'alice',
      email: 'alice@example.com',
      customClaims: { role: 'owner' },
      tenantId: 'tenant-a',
    },
    resolve: () => 'create_auth_user',
    translate: (args) => {
      const call: Args = {};
      for (const name of ['uid', 'email', 'password', 'displayName']) {
        if (args[name] !== undefined) call[name] = args[name];
      }
      if (args.customClaims !== undefined) call.claims = args.customClaims;
      if (args.tenantId !== undefined) call.tenant = args.tenantId;
      return call;
    },
    check: checkCredentials,
  },
  {
    name: 'getUser',
    sdkOrigin: 'firebase-admin',
    signature: 'getUser(uid)',
    summary: 'Read one user record.',
    args: z.object({ uid }),
    operations: ['get_auth_user'],
    renames: RENAMES,
    example: { uid: 'alice' },
    resolve: () => 'get_auth_user',
    translate: (args) => ({ uid: args.uid }),
  },
  {
    name: 'listUsers',
    sdkOrigin: 'firebase-admin',
    signature: 'listUsers(maxResults?)',
    summary: 'List the users in the sandbox pool.',
    args: z.object({
      maxResults: z.number().optional().describe('Return at most this many users.'),
    }),
    operations: ['list_auth_users'],
    renames: RENAMES,
    example: { maxResults: 20 },
    resolve: () => 'list_auth_users',
    translate: (args) => (args.maxResults === undefined ? {} : { limit: args.maxResults }),
  },
  {
    name: 'updateUser',
    sdkOrigin: 'firebase-admin',
    signature: 'updateUser(uid, email?, password?, displayName?, disabled?, emailVerified?)',
    summary: 'Change one user record.',
    args: z.object({
      uid,
      email: z.string().optional().describe('Replacement email address.'),
      password: z.string().optional().describe('Replacement password.'),
      displayName: z.string().optional().describe('Replacement display name.'),
      disabled: z.boolean().optional().describe('Whether the account is disabled.'),
      emailVerified: z.boolean().optional().describe('Whether the email is verified.'),
    }),
    operations: ['update_auth_user'],
    renames: RENAMES,
    example: { uid: 'alice', displayName: 'Alice', emailVerified: true },
    resolve: () => 'update_auth_user',
    translate: (args) => ({ ...args }),
    check: checkCredentials,
  },
  {
    name: 'deleteUser',
    sdkOrigin: 'firebase-admin',
    signature: 'deleteUser(uid)',
    summary: 'Remove one user from the pool.',
    args: z.object({ uid }),
    operations: ['delete_auth_user'],
    renames: RENAMES,
    example: { uid: 'alice' },
    resolve: () => 'delete_auth_user',
    translate: (args) => ({ uid: args.uid }),
  },
  {
    name: 'setCustomUserClaims',
    sdkOrigin: 'firebase-admin',
    signature: 'setCustomUserClaims(uid, customClaims)',
    summary: 'Replace the complete custom claims map on one user.',
    args: z.object({
      uid,
      customClaims: z
        .record(z.unknown())
        .describe('The complete claims map. An empty object clears it.'),
    }),
    operations: ['set_auth_claims'],
    renames: RENAMES,
    example: { uid: 'alice', customClaims: { role: 'admin' } },
    resolve: () => 'set_auth_claims',
    translate: (args) => ({ uid: args.uid, claims: args.customClaims }),
  },
  {
    name: 'impersonate',
    sdkOrigin: 'pyric',
    signature: 'impersonate(uid, tenantId?, customClaims?)',
    summary: 'Run every later call as this user.',
    args: z.object({
      uid: z.string().describe('The user to act as.'),
      tenantId,
      customClaims,
    }),
    operations: ['switch_auth_identity'],
    renames: RENAMES,
    example: { uid: 'alice', tenantId: 'tenant-a' },
    resolve: () => 'switch_auth_identity',
    translate: (args) => {
      const call: Args = { mode: 'uid', uid: args.uid };
      if (args.tenantId !== undefined) call.tenant = args.tenantId;
      if (args.customClaims !== undefined) call.claims = args.customClaims;
      return call;
    },
  },
  {
    name: 'actAsAdmin',
    sdkOrigin: 'pyric',
    signature: 'actAsAdmin()',
    summary: 'Run every later call with rules bypassed.',
    args: z.object({}),
    operations: ['switch_auth_identity'],
    example: {},
    resolve: () => 'switch_auth_identity',
    translate: () => ({ mode: 'admin' }),
  },
  {
    name: 'actAsAnonymous',
    sdkOrigin: 'pyric',
    signature: 'actAsAnonymous()',
    summary: 'Run every later call unauthenticated.',
    args: z.object({}),
    operations: ['switch_auth_identity'],
    example: {},
    resolve: () => 'switch_auth_identity',
    translate: () => ({ mode: 'anonymous' }),
  },
  {
    name: 'useAppSession',
    sdkOrigin: 'pyric',
    signature: 'useAppSession()',
    summary: "Run every later call as the app's own signed-in user.",
    args: z.object({}),
    operations: ['switch_auth_identity'],
    example: {},
    resolve: () => 'switch_auth_identity',
    translate: () => ({ mode: 'app-session' }),
  },
  {
    name: 'whoami',
    sdkOrigin: 'pyric',
    signature: 'whoami()',
    summary: 'Report the identity later calls run under.',
    args: z.object({}),
    operations: ['get_auth_identity'],
    example: {},
    resolve: () => 'get_auth_identity',
    translate: () => ({}),
  },
];

export const AUTH_TOOL: ToolSpec = {
  name: 'auth',
  intro:
    'Firebase Authentication in the sandbox, called with the Admin SDK method names and argument names. Claims are customClaims and the tenant is tenantId, as the Admin SDK spells them.',
  methods: METHODS,
};
