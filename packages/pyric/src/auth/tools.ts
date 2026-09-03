/**
 * Tool factory for `pyric/auth`: administration of the sandbox user store.
 *
 * `createAuthUserTools({ resolveSandbox })` wraps the same user-admin seam
 * the sandbox driver exposes (`sandbox.createUser` and company on the
 * per-sandbox `SandboxBackend`) as `ToolHandler[]`. Users created here land
 * in the one user pool the application, Studio, and rules evaluation share.
 *
 * Passwords are accepted on create, import, and update and are never
 * returned: every record leaves through {@link toUserView}, which carries no
 * credential field. Claims are custom claims; they reach rules as
 * `request.auth.token.<name>` on the next sign-in or token refresh. The
 * sandbox auth state carries no tenant field, so no tenant is accepted.
 *
 * Every handler reports a sandbox auth failure (`auth/user-not-found`,
 * `auth/uid-already-exists`, `auth/weak-password`, and so on) as an
 * `ok: false` result whose `data.code` is the Firebase error code, so an
 * agent reads the same code an application would.
 */

import type { ToolHandler } from '@inbrowser/agent';
import type { Sandbox } from 'pyric/sandbox';
import { getAuth } from './instances.js';
import { sandbox as sandboxAuth } from './sandbox/driver.js';
import type { Auth } from './types.js';
import type {
  AuthUserRecord,
  CreateUserRequest,
  UpdateUserRequest,
} from './sandbox-backend.js';

export interface AuthUserToolDeps {
  /** Resolve the sandbox whose user store the tools administer. */
  resolveSandbox(): Promise<Sandbox> | Sandbox;
}

/** The user record a tool returns: the stored record without credentials. */
export interface AuthUserView {
  uid: string;
  email: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  photoUrl: string | null;
  /** Custom claims, as rules read them under `request.auth.token`. */
  claims: Record<string, unknown>;
  /** Linked provider ids, for example `password` or `google.com`. */
  providers: string[];
  isAnonymous: boolean;
  disabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** One user of an `import` request. */
export interface AuthImportUser {
  uid?: string;
  email: string;
  password?: string;
  displayName?: string;
  claims?: Record<string, unknown>;
  disabled?: boolean;
}

export interface AuthImportError {
  index: number;
  uid?: string;
  email: string;
  code: string;
  message: string;
}

export function toUserView(record: AuthUserRecord): AuthUserView {
  return {
    uid: record.uid,
    email: record.email,
    displayName: record.displayName,
    phoneNumber: record.phoneNumber,
    photoUrl: record.photoUrl,
    claims: { ...record.customClaims },
    providers: record.providerUserInfo.map((provider) => provider.providerId),
    isAnonymous: record.isAnonymous,
    disabled: record.disabled,
    emailVerified: record.emailVerified,
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt,
  };
}

/**
 * Mint the custom token the sandbox's `signInWithCustomToken` accepts: the
 * base64url encoding of the `{ uid, claims }` payload a production custom
 * token signs. The sandbox has no signing key, so no signature is attached.
 */
export function mintSandboxCustomToken(uid: string, claims?: Record<string, unknown>): string {
  const payload = JSON.stringify(claims ? { uid, claims } : { uid });
  return toBase64Url(payload);
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const UID_SCHEMA = { type: 'string' as const, description: 'User id.' };
const CLAIMS_SCHEMA = {
  type: 'object' as const,
  description: 'Custom claims. Rules read them as request.auth.token.<name>.',
};

const IMPORT_USER_SCHEMA = {
  type: 'object' as const,
  properties: {
    uid: { type: 'string' as const, description: 'Generated when omitted.' },
    email: { type: 'string' as const },
    password: { type: 'string' as const, description: 'At least six characters. Never returned.' },
    displayName: { type: 'string' as const },
    claims: CLAIMS_SCHEMA,
    disabled: { type: 'boolean' as const },
  },
  required: ['email'],
};

interface AuthFailure {
  code: string;
  message: string;
}

function asAuthFailure(error: unknown): AuthFailure {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : 'auth/internal-error';
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

function failed(failure: AuthFailure) {
  return { ok: false, summary: failure.message, data: { code: failure.code } };
}

function createRequest(input: {
  uid?: string;
  email?: string;
  password?: string;
  displayName?: string;
  claims?: Record<string, unknown>;
  disabled?: boolean;
  emailVerified?: boolean;
}): CreateUserRequest {
  return {
    uid: input.uid,
    email: input.email,
    password: input.password,
    displayName: input.displayName,
    customClaims: input.claims,
    disabled: input.disabled,
    emailVerified: input.emailVerified,
  };
}

/**
 * User administration for the sandbox: create, import, get, list, update,
 * delete, set claims, and mint a custom token. Handler names are stable
 * identifiers the bridge's tool records map onto operations.
 */
export function createAuthUserTools(deps: AuthUserToolDeps): ToolHandler[] {
  const { resolveSandbox } = deps;
  const resolveAuth = async (): Promise<Auth> => getAuth(await resolveSandbox());

  return [
    {
      name: 'auth_create_user',
      description:
        'Create one user in the sandbox user store. Does not sign the user in. A password requires an email. Returns the record without the password.',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'Generated when omitted.' },
          email: { type: 'string' },
          password: { type: 'string', description: 'At least six characters. Never returned.' },
          displayName: { type: 'string' },
          claims: CLAIMS_SCHEMA,
          disabled: { type: 'boolean' },
          emailVerified: { type: 'boolean' },
        },
      },
      async execute(args) {
        const input = args as Parameters<typeof createRequest>[0];
        const auth = await resolveAuth();
        try {
          const record = sandboxAuth.createUser(auth, createRequest(input));
          return { ok: true, summary: `Created user ${record.uid}`, data: { user: toUserView(record) } };
        } catch (error) {
          return failed(asAuthFailure(error));
        }
      },
    },
    {
      name: 'auth_import_users',
      description:
        'Create several users in order, each with an email and optional uid, password, displayName, claims, and disabled flag. Returns the created uids and one error per user that failed; the rest are still created.',
      parameters: {
        type: 'object',
        properties: {
          users: { type: 'array', items: IMPORT_USER_SCHEMA, description: 'Users to create, in order.' },
        },
        required: ['users'],
      },
      async execute(args) {
        const { users } = args as { users: AuthImportUser[] };
        const auth = await resolveAuth();
        const created: string[] = [];
        const errors: AuthImportError[] = [];
        users.forEach((user, index) => {
          try {
            created.push(sandboxAuth.createUser(auth, createRequest(user)).uid);
          } catch (error) {
            const failure = asAuthFailure(error);
            errors.push({ index, ...(user.uid ? { uid: user.uid } : {}), email: user.email, ...failure });
          }
        });
        const summary =
          errors.length === 0
            ? `Imported ${created.length} of ${users.length} users`
            : `Imported ${created.length} of ${users.length} users; ${errors.length} failed`;
        return { ok: errors.length === 0, summary, data: { created, errors } };
      },
    },
    {
      name: 'auth_get_user',
      description: 'Get one user by uid or by email. Returns the record without the password.',
      parameters: {
        type: 'object',
        properties: {
          uid: UID_SCHEMA,
          email: { type: 'string', description: 'Used when uid is omitted.' },
        },
      },
      async execute(args) {
        const { uid, email } = args as { uid?: string; email?: string };
        if (!uid && !email) {
          return failed({ code: 'auth/argument-error', message: 'get: uid or email is required.' });
        }
        const auth = await resolveAuth();
        const users = sandboxAuth.listUsers(auth);
        const record = uid
          ? users.find((user) => user.uid === uid)
          : users.find((user) => user.email?.toLowerCase() === email!.toLowerCase());
        if (!record) {
          return failed({
            code: 'auth/user-not-found',
            message: uid ? `No user found for uid ${uid}.` : `No user found for email ${email}.`,
          });
        }
        return { ok: true, summary: `Got user ${record.uid}`, data: { user: toUserView(record) } };
      },
    },
    {
      name: 'auth_list_users',
      description: 'List every user in the sandbox user store, without passwords.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Return at most this many users.' },
        },
      },
      async execute(args) {
        const { limit } = args as { limit?: number };
        const auth = await resolveAuth();
        const records = sandboxAuth.listUsers(auth);
        const users = (limit !== undefined ? records.slice(0, limit) : records).map(toUserView);
        return {
          ok: true,
          summary: `${users.length} of ${records.length} users`,
          data: { users, total: records.length },
        };
      },
    },
    {
      name: 'auth_update_user',
      description:
        'Update one user. Omitted fields are left untouched; claims replace the whole claims map. Returns the record without the password.',
      parameters: {
        type: 'object',
        properties: {
          uid: UID_SCHEMA,
          email: { type: 'string' },
          password: { type: 'string', description: 'At least six characters. Never returned.' },
          displayName: { type: 'string' },
          claims: CLAIMS_SCHEMA,
          disabled: { type: 'boolean' },
          emailVerified: { type: 'boolean' },
        },
        required: ['uid'],
      },
      async execute(args) {
        const { uid, claims, ...rest } = args as { uid: string; claims?: Record<string, unknown> } & Omit<
          UpdateUserRequest,
          'customClaims' | 'providerUserInfo'
        >;
        const auth = await resolveAuth();
        try {
          const record = sandboxAuth.updateUser(auth, uid, { ...rest, customClaims: claims });
          return { ok: true, summary: `Updated user ${uid}`, data: { user: toUserView(record) } };
        } catch (error) {
          return failed(asAuthFailure(error));
        }
      },
    },
    {
      name: 'auth_delete_user',
      description: 'Delete one user by uid. An active session for that user is not ended.',
      parameters: {
        type: 'object',
        properties: { uid: UID_SCHEMA },
        required: ['uid'],
      },
      async execute(args) {
        const { uid } = args as { uid: string };
        const auth = await resolveAuth();
        try {
          sandboxAuth.deleteUser(auth, uid);
          return { ok: true, summary: `Deleted user ${uid}`, data: { uid } };
        } catch (error) {
          return failed(asAuthFailure(error));
        }
      },
    },
    {
      name: 'auth_set_claims',
      description:
        'Replace the custom claims of one user. An empty object clears them. The claims reach an active session on its next sign-in or token refresh.',
      parameters: {
        type: 'object',
        properties: { uid: UID_SCHEMA, claims: CLAIMS_SCHEMA },
        required: ['uid', 'claims'],
      },
      async execute(args) {
        const { uid, claims } = args as { uid: string; claims: Record<string, unknown> };
        const auth = await resolveAuth();
        try {
          const record = sandboxAuth.updateUser(auth, uid, { customClaims: claims });
          return { ok: true, summary: `Set claims on user ${uid}`, data: { user: toUserView(record) } };
        } catch (error) {
          return failed(asAuthFailure(error));
        }
      },
    },
    {
      name: 'auth_custom_token',
      description:
        'Mint a custom token for a uid, with optional claims, that the sandbox accepts in signInWithCustomToken. Signing in creates the user when it does not exist and stores the claims on the record.',
      parameters: {
        type: 'object',
        properties: { uid: UID_SCHEMA, claims: CLAIMS_SCHEMA },
        required: ['uid'],
      },
      async execute(args) {
        const { uid, claims } = args as { uid: string; claims?: Record<string, unknown> };
        if (typeof uid !== 'string' || uid.length === 0) {
          return failed({ code: 'auth/argument-error', message: 'custom_token: uid must be a non-empty string.' });
        }
        const token = mintSandboxCustomToken(uid, claims);
        return {
          ok: true,
          summary: `Minted custom token for ${uid}`,
          data: { uid, claims: claims ?? {}, token },
        };
      },
    },
  ];
}
