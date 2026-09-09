/**
 * The `auth` tool: the Admin SDK's user management method names, plus
 * `signInAs`, which has no Admin SDK counterpart because the sandbox lets a
 * caller become a user rather than mint a token for one.
 *
 * The Admin SDK spells custom claims `customClaims` and the tenant `tenantId`,
 * while the client SDK and most rules examples say `claims` and `tenant`. That
 * gap is the most common wrong argument on this tool, so it has a rename rather
 * than a spelling guess.
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
    name: 'signInAs',
    signature: 'signInAs(mode, uid?, tenantId?, customClaims?)',
    summary: 'Set the identity later calls run under. This has no Admin SDK counterpart.',
    args: z.object({
      mode: z
        .enum(['admin', 'uid', 'anonymous', 'app-session'])
        .describe(
          'admin bypasses rules, uid enforces them as that user, anonymous is unauthenticated.',
        ),
      uid: z.string().optional().describe("The user to act as when mode is 'uid'."),
      tenantId,
      customClaims,
    }),
    operations: ['switch_auth_identity'],
    renames: RENAMES,
    example: { mode: 'uid', uid: 'alice', tenantId: 'tenant-a' },
    resolve: () => 'switch_auth_identity',
    translate: (args) => {
      const call: Args = { mode: args.mode };
      if (args.uid !== undefined) call.uid = args.uid;
      if (args.tenantId !== undefined) call.tenant = args.tenantId;
      if (args.customClaims !== undefined) call.claims = args.customClaims;
      return call;
    },
    check: (args, fail) => {
      if (args.mode !== 'uid' || typeof args.uid === 'string') return null;
      return fail(
        `mode is 'uid' with uid ${quoted(args.uid)}. Acting as a user needs the user to act as.`,
        `Pass uid, or pass mode 'anonymous' to run unauthenticated.`,
        'uid',
      );
    },
  },
];

export const AUTH_TOOL: ToolSpec = {
  name: 'auth',
  intro:
    'Firebase Authentication in the sandbox, called with the Admin SDK method names and argument names. Claims are customClaims and the tenant is tenantId, as the Admin SDK spells them.',
  methods: METHODS,
};
