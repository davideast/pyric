/**
 * Bulk-create sandbox Auth identities — shared by the agent tool and
 * the Seed tab apply pipeline.
 */
import {
  getAuth,
  sandbox as authSandbox,
  type CreateUserRequest,
} from 'pyric/auth';
import type { Sandbox } from 'pyric/sandbox';
import type { SeedUser } from 'pyric/auth';

import { getRunner } from '~/lib/sandbox/runner';

export const MAX_AUTH_SEED_USERS = 100;

export interface AuthSeedApplyResult {
  created: string[];
  failed: number;
  errors: Array<{ index: number; uid: string; error: string }>;
}

function sandboxAuth() {
  return getAuth(getRunner().getSandbox() as Sandbox);
}

/** Map spec-derived SeedUser to CreateUserRequest. */
export function seedUserToCreateRequest(user: SeedUser): CreateUserRequest {
  return {
    uid: user.uid,
    email: user.email,
    password: user.password,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.customClaims && Object.keys(user.customClaims).length > 0
      ? { customClaims: user.customClaims }
      : {}),
  };
}

export function applyAuthSeedUsers(users: CreateUserRequest[]): AuthSeedApplyResult {
  if (users.length === 0) {
    return { created: [], failed: 0, errors: [] };
  }
  if (users.length > MAX_AUTH_SEED_USERS) {
    return {
      created: [],
      failed: users.length,
      errors: [
        {
          index: 0,
          uid: '',
          error: `Exceeds ${MAX_AUTH_SEED_USERS}-user cap (${users.length} requested).`,
        },
      ],
    };
  }

  const auth = sandboxAuth();
  const created: string[] = [];
  const errors: AuthSeedApplyResult['errors'] = [];

  for (let i = 0; i < users.length; i++) {
    const req = users[i]!;
    try {
      created.push(authSandbox.createUser(auth, req).uid);
    } catch (e) {
      errors.push({
        index: i,
        uid: req.uid ?? `(index ${i})`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { created, failed: errors.length, errors };
}
