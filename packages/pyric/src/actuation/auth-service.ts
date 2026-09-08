/**
 * Pure domain service for Auth user pool administration (`manageAuthUsers`),
 * auth flow inspection (`inspectAuthFlow`), and identity lens switching
 * (`switchAuthIdentity`) with Full-Lifecycle tenant propagation.
 */

import { normalizeAuthState, type LocalSandbox } from '../sandbox/index.js';
import {
  getAuth,
  checkActionCode,
  sandbox as authDriver,
  type AuthUserRecord,
  type OutboundAuthMail,
  type UserCredential,
} from 'pyric/auth';

/**
 * Normalizes custom claims with tenant projection via the shared sandbox foundation
 * per AGENTS.md Rule #4 (Foundation Reuse).
 */
export function buildNormalizedClaims(
  baseClaims: Record<string, unknown>,
  tenant?: string | null,
): Record<string, unknown> {
  const normalized = normalizeAuthState({
    uid: '__normalize__',
    ...(tenant ? { tenant } : {}),
    token: baseClaims,
  });
  return (normalized?.token as Record<string, unknown>) ?? { ...baseClaims };
}

export interface ActiveIdentityLens {
  mode: 'uid' | 'admin' | 'anonymous' | 'app-session';
  uid: string | null;
  tenant: string | null;
  claims: Record<string, unknown>;
  target?: string;
}

const activeIdentityLensMap = new WeakMap<LocalSandbox, ActiveIdentityLens>();

export function getActiveIdentityLens(sandbox: LocalSandbox): ActiveIdentityLens {
  return (
    activeIdentityLensMap.get(sandbox) ?? {
      mode: 'app-session',
      uid: null,
      tenant: null,
      claims: {},
    }
  );
}

export function resetActiveIdentityLens(sandbox: LocalSandbox): void {
  activeIdentityLensMap.delete(sandbox);
}

export interface SwitchAuthIdentityInput {
  mode: 'uid' | 'admin' | 'anonymous' | 'app-session';
  uid?: string;
  tenant?: string;
  claimsJson?: string;
  claims?: Record<string, unknown>;
  target?: string;
}

export interface SwitchAuthIdentityOutput {
  ok: boolean;
  activeIdentity: ActiveIdentityLens;
  error?: string;
}

export async function switchAuthIdentity(
  sandbox: LocalSandbox,
  input: SwitchAuthIdentityInput
): Promise<SwitchAuthIdentityOutput> {
  try {
    if (input.mode === 'uid' && !input.uid) {
      return {
        ok: false,
        activeIdentity: getActiveIdentityLens(sandbox),
        error: "uid is required when mode is 'uid'",
      };
    }

    const baseClaims =
      input.claims ??
      (input.claimsJson
        ? (JSON.parse(input.claimsJson) as Record<string, unknown>)
        : {});

    const claims = buildNormalizedClaims(baseClaims, input.tenant);

    const activeIdentity: ActiveIdentityLens = {
      mode: input.mode,
      uid: input.mode === 'uid' ? input.uid! : null,
      tenant: input.tenant ?? null,
      claims,
      target: input.target,
    };

    activeIdentityLensMap.set(sandbox, activeIdentity);

    return {
      ok: true,
      activeIdentity,
    };
  } catch (err) {
    return {
      ok: false,
      activeIdentity: getActiveIdentityLens(sandbox),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ManageAuthUsersInput {
  action: 'create' | 'get' | 'list' | 'update' | 'delete' | 'set_claims' | 'mint_token' | 'import';
  uid?: string;
  email?: string;
  password?: string;
  displayName?: string;
  phoneNumber?: string;
  disabled?: boolean;
  emailVerified?: boolean;
  claimsJson?: string;
  claims?: Record<string, unknown>;
  usersJson?: string;
  users?: Array<{
    uid: string;
    email?: string;
    displayName?: string;
    password?: string;
    customClaims?: Record<string, unknown>;
  }>;
}

export interface ManageAuthUsersOutput {
  ok: boolean;
  action: ManageAuthUsersInput['action'];
  user?: AuthUserRecord;
  users?: AuthUserRecord[];
  token?: string;
  importedCount?: number;
  error?: string;
}

export async function manageAuthUsers(
  sandbox: LocalSandbox,
  input: ManageAuthUsersInput
): Promise<ManageAuthUsersOutput> {
  try {
    const auth = getAuth(sandbox);

    if (input.action === 'create') {
      const user = authDriver.createUser(auth, {
        uid: input.uid,
        email: input.email,
        password: input.password,
        displayName: input.displayName,
        phoneNumber: input.phoneNumber,
        disabled: input.disabled,
        emailVerified: input.emailVerified,
        customClaims:
          input.claims ??
          (input.claimsJson
            ? (JSON.parse(input.claimsJson) as Record<string, unknown>)
            : undefined),
      });
      return { ok: true, action: 'create', user };
    }

    if (input.action === 'get') {
      const users = authDriver.listUsers(auth);
      const user = users.find((u) => (input.uid && u.uid === input.uid) || (input.email && u.email === input.email));
      if (!user) {
        return {
          ok: false,
          action: 'get',
          error: `User not found: ${input.uid ?? input.email ?? 'unknown'}`,
        };
      }
      return { ok: true, action: 'get', user };
    }

    if (input.action === 'list') {
      const users = authDriver.listUsers(auth);
      return { ok: true, action: 'list', users };
    }

    if (input.action === 'update') {
      if (!input.uid) {
        throw new Error("uid is required for 'update' action");
      }
      const user = authDriver.updateUser(auth, input.uid, {
        email: input.email,
        displayName: input.displayName,
        disabled: input.disabled,
        emailVerified: input.emailVerified,
      });
      return { ok: true, action: 'update', user };
    }

    if (input.action === 'delete') {
      if (!input.uid) {
        throw new Error("uid is required for 'delete' action");
      }
      authDriver.deleteUser(auth, input.uid);
      return { ok: true, action: 'delete' };
    }

    if (input.action === 'set_claims') {
      if (!input.uid) {
        throw new Error("uid is required for 'set_claims' action");
      }
      const claims =
        input.claims ??
        (input.claimsJson ? (JSON.parse(input.claimsJson) as Record<string, unknown>) : {});
      const user = authDriver.updateUser(auth, input.uid, { customClaims: claims });
      return { ok: true, action: 'set_claims', user };
    }

    if (input.action === 'mint_token') {
      if (!input.uid) {
        throw new Error("uid is required for 'mint_token' action");
      }
      const claims =
        input.claims ??
        (input.claimsJson
          ? (JSON.parse(input.claimsJson) as Record<string, unknown>)
          : undefined);
      if (claims) {
        authDriver.updateUser(auth, input.uid, { customClaims: claims });
      }
      const minted = authDriver.mintSession(auth, { kind: 'uid', uid: input.uid });
      const token = await minted.user.getIdToken();
      return { ok: true, action: 'mint_token', token };
    }

    if (input.action === 'import') {
      const list =
        input.users ??
        (input.usersJson
          ? (JSON.parse(input.usersJson) as Array<{
              uid: string;
              email?: string;
              displayName?: string;
              password?: string;
              customClaims?: Record<string, unknown>;
            }>)
          : []);

      for (const u of list) {
        authDriver.createUser(auth, {
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          password: u.password,
          customClaims: u.customClaims,
        });
      }
      return {
        ok: true,
        action: 'import',
        importedCount: list.length,
        users: authDriver.listUsers(auth),
      };
    }

    return {
      ok: false,
      action: input.action,
      error: `Unsupported auth action: ${input.action}`,
    };
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface InspectAuthFlowInput {
  action: 'whoami' | 'list_sessions' | 'take_mail' | 'verify_action_code' | 'stage_oauth_mock';
  email?: string;
  code?: string;
  providerId?: string;
  mockCredentialJson?: string;
  mockCredential?: UserCredential;
}

export interface InspectAuthFlowOutput {
  ok: boolean;
  action: InspectAuthFlowInput['action'];
  activeIdentity?: ActiveIdentityLens;
  sessions?: Array<{ uid: string; email?: string | null }>;
  mail?: OutboundAuthMail | null;
  actionCodeInfo?: unknown;
  error?: string;
}

export async function inspectAuthFlow(
  sandbox: LocalSandbox,
  input: InspectAuthFlowInput
): Promise<InspectAuthFlowOutput> {
  try {
    const auth = getAuth(sandbox);

    if (input.action === 'whoami') {
      const activeIdentity = getActiveIdentityLens(sandbox);
      return {
        ok: true,
        action: 'whoami',
        activeIdentity,
      };
    }

    if (input.action === 'list_sessions') {
      const users = authDriver.listUsers(auth);
      const sessions = users.map((u) => ({ uid: u.uid, email: u.email }));
      return {
        ok: true,
        action: 'list_sessions',
        sessions,
      };
    }

    if (input.action === 'take_mail') {
      const mail = authDriver.takeAuthMail(auth, input.email);
      return {
        ok: true,
        action: 'take_mail',
        mail,
      };
    }

    if (input.action === 'verify_action_code') {
      if (!input.code) {
        throw new Error("code is required for 'verify_action_code'");
      }
      const info = await checkActionCode(auth, input.code);
      return {
        ok: true,
        action: 'verify_action_code',
        actionCodeInfo: info,
      };
    }

    if (input.action === 'stage_oauth_mock') {
      const credential =
        input.mockCredential ??
        (input.mockCredentialJson
          ? (JSON.parse(input.mockCredentialJson) as UserCredential)
          : authDriver.createSignInCredential(auth, {
              providerId: input.providerId ?? 'google.com',
              uid: 'oauth_mock_user',
            }));
      authDriver.mockSignInResult(auth, credential);
      return {
        ok: true,
        action: 'stage_oauth_mock',
      };
    }

    return {
      ok: false,
      action: input.action,
      error: `Unsupported inspectAuthFlow action: ${input.action}`,
    };
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
