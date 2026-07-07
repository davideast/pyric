/**
 * Sandbox auth user-admin tools (epic plan §8 B3.2) — the agent-facing
 * twins of the playground's Auth tab. Both surfaces read the SAME pane
 * of glass: `pyric/auth`'s `sandbox.*` user-admin drivers over the
 * runner's root sandbox, so what the agent reports is exactly what the
 * user sees in the tab (and vice versa).
 *
 *   inspect_auth_users — read-only, parallel-safe. Lists every sandbox
 *     identity with providers, claims, disabled/emailVerified flags.
 *   seed_auth_users    — mutating, capped. Bulk-create test identities
 *     for auth-gated fixture setup, mirroring
 *     `seed_firestore_data_as_admin`'s pinned batch semantics
 *     (100-entry cap, per-entry errors, no atomicity).
 *
 * Local sandbox only — no live-mode counterpart this PR (matches the
 * seed tool's pinned design).
 */
import type { ToolHandler } from '@inbrowser/agent';
import {
  type AuthUserRecord,
  type CreateUserRequest,
} from 'pyric/auth';
import { getPlaygroundRuntime } from '~/lib/sandbox/runtime';
import { applyAuthSeedUsersAsync, MAX_AUTH_SEED_USERS } from '~/lib/sandbox/seed-auth-apply';

/** Same cap + rationale as `seed_firestore_data_as_admin`: reject the
 *  whole call above the cap — never silently truncate. */
const MAX_USERS = MAX_AUTH_SEED_USERS;

export interface InspectAuthUsersData {
  count: number;
  users: AuthUserRecord[];
}

export const inspectAuthUsersHandler: ToolHandler<
  Record<string, never>,
  InspectAuthUsersData
> = {
  name: 'inspect_auth_users',
  parallelSafe: true, // read-only (0.2.0 parallelDispatch)
  description:
    'List every identity in the in-browser sandbox Auth user database: uid, email, displayName, providers, custom claims, disabled, emailVerified, created/last-sign-in timestamps. Use this to see which test identities exist (and with which claims) before writing auth-gated rules or app flows, or to verify what seed_auth_users / the sign-in helper created. Read-only; an empty list means no identity has been seeded or signed in yet this session.',
  parameters: { type: 'object', properties: {} },
  async execute() {
    const users = await getPlaygroundRuntime().listAuthUsers();
    return {
      ok: true,
      summary: `inspect_auth_users · ${users.length} identit${users.length === 1 ? 'y' : 'ies'}`,
      data: { count: users.length, users },
    };
  },
};

export interface SeedAuthUsersArgs {
  users: CreateUserRequest[];
}

export interface SeedAuthUsersData {
  created: string[];
  failed: number;
  errors?: Array<{ index: number; error: string }>;
  /** Surfaced on the rejection path so the agent can branch on it. */
  code?: 'TOO_MANY_USERS' | 'INVALID_ARGS';
}

export const seedAuthUsersHandler: ToolHandler<SeedAuthUsersArgs, SeedAuthUsersData> = {
  name: 'seed_auth_users',
  description:
    'Bulk-create test identities in the in-browser sandbox Auth user database. Use this to set up auth fixture state BEFORE testing auth-gated rules or flows — e.g. seed an admin (customClaims: {admin: true}) and a plain user, then probe rules as each. Each entry: { uid?, email?, password?, displayName?, customClaims?, disabled?, emailVerified? } — uid defaults to a generated `user-<N>`. In rules, custom claims read as `request.auth.token.<name>`. Creating a user does NOT sign anyone in; the preview app signs in via its own auth calls (or the sign-in helper). Max 100 users per call — anything larger gets the whole call rejected. Per-entry failures (e.g. `auth/uid-already-exists`) land in `errors[]` and do NOT abort the batch (no atomicity guarantee).',
  parameters: {
    type: 'object',
    properties: {
      users: {
        type: 'array',
        description: 'Up to 100 identities to create, in order.',
        items: {
          type: 'object',
          properties: {
            uid: { type: 'string' },
            email: { type: 'string' },
            password: { type: 'string' },
            displayName: { type: 'string' },
            customClaims: {
              type: 'object',
              description: 'Custom claims — read in rules as request.auth.token.<name>.',
            },
            disabled: { type: 'boolean' },
            emailVerified: { type: 'boolean' },
          },
        },
      },
    },
    required: ['users'],
  },
  async execute({ users }) {
    if (!Array.isArray(users) || users.length === 0) {
      return {
        ok: false,
        summary: 'seed_auth_users: `users` must be a non-empty array',
        data: { created: [], failed: 0, code: 'INVALID_ARGS' },
      };
    }
    if (users.length > MAX_USERS) {
      return {
        ok: false,
        summary: `seed_auth_users: ${users.length} users exceeds the ${MAX_USERS}-entry cap — split into multiple calls`,
        data: { created: [], failed: users.length, code: 'TOO_MANY_USERS' },
      };
    }
    const batch = await applyAuthSeedUsersAsync(users);
    const errors = batch.errors.map((e) => ({ index: e.index, error: e.error }));
    return {
      ok: true,
      summary: `seed_auth_users · created ${batch.created.length}/${users.length}${batch.failed ? ` · ${batch.failed} failed` : ''}`,
      data: {
        created: batch.created,
        failed: batch.failed,
        ...(errors.length ? { errors } : {}),
      },
    };
  },
};

/** Always-registered alongside CORE_TOOLS — sandbox-only, no auth or
 *  project gating (epic plan §8 B3.2). */
export const AUTH_TOOLS: ToolHandler[] = [
  inspectAuthUsersHandler as ToolHandler,
  seedAuthUsersHandler as ToolHandler,
];
