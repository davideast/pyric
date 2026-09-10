/**
 * Sandbox auth user administration, exposed as one MCP tool per operation
 * bound to one authoritative sandbox: `auth_create_user`, `auth_import_users`,
 * `auth_get_user`, `auth_list_users`, `auth_update_user`, `auth_delete_user`,
 * `auth_set_claims`, `auth_custom_token`.
 *
 * The names follow `docs/decisions/0013-mcp-tool-names-carry-the-operation.md`:
 * the tool name is the whole path joined with underscores and there is no
 * `op` field.
 *
 * Execution runs wherever the forwarded families run — the browser peer's
 * sandbox, which in `pyric sandbox --bridge` is the SharedWorker's one
 * sandbox. The handlers call the same `pyric/auth` sandbox driver the worker
 * host's admin ops call (`sandbox.createUser`, `updateUser`, `deleteUser`,
 * `listUsers`), so a user created here is the same record the application,
 * Studio, and rules evaluation see. No new worker op is introduced.
 *
 * Passwords are accepted by create, import, and update and are never
 * returned: every record leaves through {@link toUserView}, which carries no
 * credential field. Claims are custom claims; rules read them as
 * `request.auth.token.<name>` on the next sign-in or token refresh.
 *
 * A sandbox auth failure (`auth/user-not-found`, `auth/uid-already-exists`,
 * `auth/weak-password`, and so on) is reported as an `ok: false` result whose
 * `data.code` is the Firebase error code, so an agent reads the same code an
 * application would.
 */

import type { ToolHandler } from '@inbrowser/agent';
import {
  getAuth,
  sandbox as sandboxAuth,
  type Auth,
  type AuthUserRecord,
  type CreateUserRequest,
  type UpdateUserRequest,
} from 'pyric/auth';
import type { LocalSandbox } from 'pyric/sandbox';

export interface AuthUsersToolDeps {
  /** Resolve the sandbox whose user store the tools administer. */
  resolveSandbox(): LocalSandbox | Promise<LocalSandbox>;
}

/** The user record the tools return: the stored record without credentials. */
export interface AuthUserView {
  uid: string;
  email: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  /**
   * Profile photo. A user whose creating provider id contains a dot
   * (`google.com`, `oidc.acme`) is assigned a generated avatar at creation;
   * `password`, `phone`, email-link, and anonymous users stay `null`.
   */
  photoUrl: string | null;
  /** Custom claims, as rules read them under `request.auth.token`. */
  claims: Record<string, unknown>;
  /** Linked provider ids, for example `password` or `google.com`. */
  providers: string[];
  isAnonymous: boolean;
  disabled: boolean;
  emailVerified: boolean;
  /**
   * Identity Platform tenant the record belongs to, or `null` for the
   * project-level pool. Rules read the same value as
   * `request.auth.token.firebase.tenant` once the identity signs in.
   */
  tenantId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** One user of an `auth_import_users` call. */
export interface AuthImportUser {
  uid?: string;
  email: string;
  password?: string;
  displayName?: string;
  phoneNumber?: string;
  claims?: Record<string, unknown>;
  providers?: string[];
  disabled?: boolean;
  emailVerified?: boolean;
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
    tenantId: record.tenantId,
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
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

function failure(code: string, message: string): ToolResult {
  return { ok: false, summary: message, data: { code } };
}

function asAuthFailure(error: unknown): ToolResult {
  const code =
    typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : 'auth/internal-error';
  return failure(code, error instanceof Error ? error.message : String(error));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArgs(rawArgs: unknown): Record<string, unknown> {
  return (isPlainObject(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
}

function requireUid(args: Record<string, unknown>, tool: string): string | ToolResult {
  const uid = args.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    return failure('auth/argument-error', `${tool}: uid must be a non-empty string.`);
  }
  return uid;
}

function providerUserInfo(providers: unknown): CreateUserRequest['providerUserInfo'] {
  if (!Array.isArray(providers)) return undefined;
  return providers
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((providerId) => ({ providerId }));
}

interface UserInput {
  uid?: string;
  email?: string;
  password?: string;
  displayName?: string;
  phoneNumber?: string;
  claims?: Record<string, unknown>;
  providers?: string[];
  disabled?: boolean;
  emailVerified?: boolean;
}

function createRequest(input: UserInput): CreateUserRequest {
  return {
    uid: input.uid,
    email: input.email,
    password: input.password,
    displayName: input.displayName,
    phoneNumber: input.phoneNumber,
    customClaims: input.claims,
    disabled: input.disabled,
    emailVerified: input.emailVerified,
    providerUserInfo: providerUserInfo(input.providers),
  };
}

const CLAIMS_SCHEMA = {
  type: 'object' as const,
  description: 'Custom claims. Rules read them as request.auth.token.<name>.',
};

const PROVIDERS_SCHEMA = {
  type: 'array' as const,
  items: { type: 'string' as const },
  description:
    'Provider ids to link, for example google.com. A user created under a dotted provider id and no password is assigned a generated photoUrl.',
};

const USER_FIELDS = {
  email: { type: 'string' as const },
  password: { type: 'string' as const, description: 'At least six characters. Never returned.' },
  displayName: { type: 'string' as const },
  phoneNumber: { type: 'string' as const },
  claims: CLAIMS_SCHEMA,
  providers: PROVIDERS_SCHEMA,
  disabled: { type: 'boolean' as const },
  emailVerified: { type: 'boolean' as const },
};

const IMPORT_USER_SCHEMA = {
  type: 'object' as const,
  properties: {
    uid: { type: 'string' as const, description: 'Generated when omitted.' },
    ...USER_FIELDS,
  },
  required: ['email'],
};

const POOL_NOTE =
  'Users land in the one pool the application, Studio, and rules evaluation share. ' +
  'Creating a user does not sign anyone in, and a password is never returned. ' +
  'A user created under a dotted provider id with no password is assigned a generated photoUrl; ' +
  'password, phone, and anonymous users keep photoUrl null.';

/**
 * The eight user-administration tools, bound to one sandbox, in the order the
 * family record pins.
 */
export function createAuthUsersTools(deps: AuthUsersToolDeps): ToolHandler[] {
  const resolveAuth = async (): Promise<Auth> => getAuth(await deps.resolveSandbox());

  return [
    {
      name: 'auth_create_user',
      description: `Create one user in the connected sandbox's user store. ${POOL_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'User id. Generated when omitted.' },
          ...USER_FIELDS,
        },
      },
      async execute(rawArgs) {
        const args = asArgs(rawArgs);
        const auth = await resolveAuth();
        try {
          const record = sandboxAuth.createUser(auth, createRequest(args as UserInput));
          return {
            ok: true,
            summary: `Created user ${record.uid}`,
            data: { user: toUserView(record) },
          };
        } catch (error) {
          return asAuthFailure(error);
        }
      },
    },

    {
      name: 'auth_import_users',
      description: `Create many users in order, reporting each failure without stopping. ${POOL_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          users: {
            type: 'array',
            items: IMPORT_USER_SCHEMA,
            description: 'Users to create, in order. Each requires an email.',
          },
        },
        required: ['users'],
      },
      async execute(rawArgs) {
        const args = asArgs(rawArgs);
        const users = args.users;
        if (!Array.isArray(users)) {
          return failure('auth/argument-error', 'auth_import_users: users must be an array.');
        }
        const auth = await resolveAuth();
        const created: string[] = [];
        const errors: AuthImportError[] = [];
        users.forEach((entry, index) => {
          const user = (isPlainObject(entry) ? entry : {}) as unknown as AuthImportUser;
          if (typeof user.email !== 'string' || user.email.length === 0) {
            errors.push({
              index,
              ...(user.uid ? { uid: user.uid } : {}),
              email: String(user.email ?? ''),
              code: 'auth/argument-error',
              message: `auth_import_users: users[${index}].email is required.`,
            });
            return;
          }
          try {
            created.push(sandboxAuth.createUser(auth, createRequest(user)).uid);
          } catch (error) {
            const reported = asAuthFailure(error).data as { code: string };
            errors.push({
              index,
              ...(user.uid ? { uid: user.uid } : {}),
              email: user.email,
              code: reported.code,
              message: error instanceof Error ? error.message : String(error),
            });
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
      description:
        "Read one user of the connected sandbox's user store by uid, or by email when uid is omitted.",
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string' },
          email: { type: 'string', description: 'Matched case-insensitively. Used when uid is omitted.' },
        },
      },
      async execute(rawArgs) {
        const { uid, email } = asArgs(rawArgs) as { uid?: string; email?: string };
        if (typeof uid !== 'string' && typeof email !== 'string') {
          return failure('auth/argument-error', 'auth_get_user: uid or email is required.');
        }
        const users = sandboxAuth.listUsers(await resolveAuth());
        const record =
          typeof uid === 'string'
            ? users.find((user) => user.uid === uid)
            : users.find((user) => user.email?.toLowerCase() === email!.toLowerCase());
        if (!record) {
          return failure(
            'auth/user-not-found',
            typeof uid === 'string'
              ? `No user found for uid ${uid}.`
              : `No user found for email ${email}.`,
          );
        }
        return { ok: true, summary: `Got user ${record.uid}`, data: { user: toUserView(record) } };
      },
    },

    {
      name: 'auth_list_users',
      description: "Read every user of the connected sandbox's user store.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Return at most this many users.' },
        },
      },
      async execute(rawArgs) {
        const { limit } = asArgs(rawArgs) as { limit?: number };
        if (
          limit !== undefined &&
          (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)
        ) {
          return failure('auth/argument-error', 'auth_list_users: limit must be a non-negative number.');
        }
        const records = sandboxAuth.listUsers(await resolveAuth());
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
        'Change one user. Every supplied field replaces what is stored; claims replaces the whole claims map. Omitted fields are left alone.',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'The user to change.' },
          ...USER_FIELDS,
        },
        required: ['uid'],
      },
      async execute(rawArgs) {
        const args = asArgs(rawArgs);
        const uid = requireUid(args, 'auth_update_user');
        if (typeof uid !== 'string') return uid;
        const input = args as UserInput;
        const update: UpdateUserRequest = {
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.password !== undefined ? { password: input.password } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
          ...(input.emailVerified !== undefined ? { emailVerified: input.emailVerified } : {}),
          ...(input.claims !== undefined ? { customClaims: input.claims } : {}),
          ...(input.providers !== undefined
            ? { providerUserInfo: providerUserInfo(input.providers) }
            : {}),
        };
        try {
          const record = sandboxAuth.updateUser(await resolveAuth(), uid, update);
          return { ok: true, summary: `Updated user ${uid}`, data: { user: toUserView(record) } };
        } catch (error) {
          return asAuthFailure(error);
        }
      },
    },

    {
      name: 'auth_delete_user',
      description: "Remove one user from the connected sandbox's user store.",
      parameters: {
        type: 'object',
        properties: { uid: { type: 'string', description: 'The user to remove.' } },
        required: ['uid'],
      },
      async execute(rawArgs) {
        const args = asArgs(rawArgs);
        const uid = requireUid(args, 'auth_delete_user');
        if (typeof uid !== 'string') return uid;
        try {
          sandboxAuth.deleteUser(await resolveAuth(), uid);
          return { ok: true, summary: `Deleted user ${uid}`, data: { uid } };
        } catch (error) {
          return asAuthFailure(error);
        }
      },
    },

    {
      name: 'auth_set_claims',
      description:
        'Replace one user\'s custom claims. Rules read them as request.auth.token.<name> on the next sign-in or token refresh. An empty object clears them.',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'The user to change.' },
          claims: CLAIMS_SCHEMA,
        },
        required: ['uid', 'claims'],
      },
      async execute(rawArgs) {
        const args = asArgs(rawArgs);
        const uid = requireUid(args, 'auth_set_claims');
        if (typeof uid !== 'string') return uid;
        if (!isPlainObject(args.claims)) {
          return failure('auth/argument-error', 'auth_set_claims: claims must be an object.');
        }
        const claims = args.claims;
        try {
          const record = sandboxAuth.updateUser(await resolveAuth(), uid, { customClaims: claims });
          return {
            ok: true,
            summary: `Set claims on user ${uid}`,
            data: { user: toUserView(record) },
          };
        } catch (error) {
          return asAuthFailure(error);
        }
      },
    },

    {
      name: 'auth_custom_token',
      description:
        "Mint a custom token for a uid that the sandbox's signInWithCustomToken accepts. The sandbox has no signing key, so the token is unsigned and is only good against this sandbox.",
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'The user the token signs in.' },
          claims: CLAIMS_SCHEMA,
        },
        required: ['uid'],
      },
      async execute(rawArgs) {
        const args = asArgs(rawArgs);
        const uid = requireUid(args, 'auth_custom_token');
        if (typeof uid !== 'string') return uid;
        const claims = args.claims;
        if (claims !== undefined && !isPlainObject(claims)) {
          return failure('auth/argument-error', 'auth_custom_token: claims must be an object.');
        }
        return {
          ok: true,
          summary: `Minted custom token for ${uid}`,
          data: {
            uid,
            claims: claims ?? {},
            token: mintSandboxCustomToken(uid, claims as Record<string, unknown> | undefined),
          },
        };
      },
    },
  ];
}
