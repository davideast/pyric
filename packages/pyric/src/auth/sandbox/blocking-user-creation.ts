/**
 * Pre-creation validation, `beforeUserCreated` hook invocation, and atomic
 * account persistence across email/password, anonymous, email-link, and custom
 * token sign-in paths.
 */
import {
  getClock,
  randomUuid,
  readCustomToken,
  type SandboxCustomToken,
} from 'pyric/sandbox/internal';
import { ActionCodeURL } from '../action-code-url.js';
import { makeAuthError } from '../auth-errors.js';
import { EMAIL_LINK_SIGN_IN_METHOD } from '../email-link.js';
import { ActionCodeOperation } from '../enums.js';
import { validateEmailFormat, validatePasswordStrength } from '../sandbox-credential-validators.js';
import type { StoredUser } from '../sandbox-backend-types.js';
import { SandboxBackend } from '../sandbox-backend.js';
import {
  applyBeforeCreateResponseToInit,
  getAuthBlockingHooks,
  type AuthBlockingClientContext,
  type AuthBlockingUserCandidate,
} from './blocking-hooks.js';
import { runBeforeSignInHook, type BlockedSignInOutcome } from './blocking-sign-in.js';
import { assertMatchingTenant, normalizeTenantScope } from './tenant-isolation.js';
import { targetOf } from '../target.js';
import type { Auth, User } from '../types.js';

/** Pre-validate, invoke `beforeCreate` / `beforeSignIn`, and persist an email/password account. */
export async function createBlockedEmailPasswordUser(
  auth: Auth,
  input: {
    email: string;
    password: string;
    tenantId?: string | null;
    client?: AuthBlockingClientContext;
    stageForCurrentUser?: boolean;
  },
): Promise<BlockedSignInOutcome> {
  const target = targetOf(auth);
  const { backend } = target;
  const rawTenant = input.tenantId === undefined ? backend.getTenantId() : input.tenantId;
  const effectiveTenant = normalizeTenantScope(rawTenant);
  backend.assertProviderEnabled('password');
  validateEmailFormat(input.email);
  validatePasswordStrength(input.password);
  if (backend.findByEmail(input.email, effectiveTenant) !== undefined) {
    throw makeAuthError(
      'auth/email-already-in-use',
      `An account already exists for ${input.email}.`,
    );
  }

  const beforeCreate = getAuthBlockingHooks(auth)?.beforeCreate;
  let stored: StoredUser;
  if (beforeCreate === undefined) {
    stored = backend.createEmailPasswordUser(input.email, input.password, effectiveTenant);
  } else {
    const uid = `email-${randomUuid()}`;
    const createdAtIso = new Date(getClock(target.sandbox).now()).toISOString();
    const candidate: AuthBlockingUserCandidate = {
      uid,
      email: input.email,
      emailVerified: false,
      displayName: null,
      photoURL: null,
      phoneNumber: null,
      disabled: false,
      creationTime: createdAtIso,
      lastSignInTime: null,
      providerData: [{ uid: input.email, email: input.email, providerId: 'password' }],
      tenantId: effectiveTenant,
    };
    const response = await beforeCreate({
      userRecord: candidate,
      signInMethod: 'password',
      tenantId: effectiveTenant,
      client: input.client,
    });
    const { init, clearPhotoUrl } = applyBeforeCreateResponseToInit(
      {
        uid,
        email: input.email,
        password: input.password,
        emailVerified: false,
        disabled: false,
        tenantId: effectiveTenant,
        providerUserInfo: [{ providerId: 'password' }],
      },
      response,
    );
    stored = SandboxBackend.commitBlockedAccount(backend, init, { clearPhotoUrl });
    backend.assertSignInAllowed(stored.uid);
  }
  return runBeforeSignInHook(auth, {
    uid: stored.uid,
    signInMethod: 'password',
    tenantId: effectiveTenant,
    client: input.client,
    stageForCurrentUser: input.stageForCurrentUser,
  });
}

/** Invoke `beforeCreate` / `beforeSignIn` if active and persist a new anonymous account. */
export async function createBlockedAnonymousUser(
  auth: Auth,
  input: {
    tenantId?: string | null;
    client?: AuthBlockingClientContext;
    stageForCurrentUser?: boolean;
  } = {},
): Promise<BlockedSignInOutcome> {
  const target = targetOf(auth);
  const { backend } = target;
  const rawTenant = input.tenantId === undefined ? backend.getTenantId() : input.tenantId;
  const effectiveTenant = normalizeTenantScope(rawTenant);
  backend.assertProviderEnabled('anonymous');

  const beforeCreate = getAuthBlockingHooks(auth)?.beforeCreate;
  let uid: string;
  if (beforeCreate === undefined) {
    uid = backend.mintAnonymousUser(effectiveTenant).uid;
  } else {
    uid = `anonymous-${randomUuid()}`;
    const createdAtIso = new Date(getClock(target.sandbox).now()).toISOString();
    const response = await beforeCreate({
      userRecord: {
        uid,
        email: null,
        emailVerified: false,
        displayName: null,
        photoURL: null,
        phoneNumber: null,
        disabled: false,
        creationTime: createdAtIso,
        lastSignInTime: null,
        providerData: [],
        tenantId: effectiveTenant,
      },
      signInMethod: 'anonymous',
      tenantId: effectiveTenant,
      client: input.client,
    });
    const { init, clearPhotoUrl } = applyBeforeCreateResponseToInit(
      {
        uid,
        isAnonymous: true,
        emailVerified: false,
        disabled: false,
        tenantId: effectiveTenant,
        providerUserInfo: [],
      },
      response,
    );
    const stored = SandboxBackend.commitBlockedAccount(backend, init, {
      clearPhotoUrl,
      detail: { isAnonymous: true },
    });
    backend.assertSignInAllowed(stored.uid);
  }
  return runBeforeSignInHook(auth, {
    uid,
    signInMethod: 'anonymous',
    tenantId: effectiveTenant,
    client: input.client,
    stageForCurrentUser: input.stageForCurrentUser,
  });
}

/** Redeem an email sign-in link, running `beforeCreate` (if new) and `beforeSignIn`. */
export async function resolveBlockedEmailLinkIdentity(
  auth: Auth,
  email: string,
  link: string,
  tenantId?: string | null,
  client?: AuthBlockingClientContext,
  stageForCurrentUser?: boolean,
): Promise<{ user: User; isNewUser: boolean; sessionClaims?: Record<string, unknown> }> {
  const target = targetOf(auth);
  const { backend } = target;
  backend.assertProviderEnabled('password');
  const parsed = ActionCodeURL.parseLink(link);
  if (parsed === null) {
    throw makeAuthError(
      'auth/argument-error',
      'signInWithEmailLink: the link is not a valid email sign-in link (no oobCode).',
    );
  }
  if (parsed.operation !== ActionCodeOperation.EMAIL_SIGNIN) {
    throw makeAuthError(
      'auth/argument-error',
      `signInWithEmailLink: the link authorizes ${parsed.operation}, not an email sign-in.`,
    );
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw makeAuthError(
      'auth/invalid-email',
      'signInWithEmailLink: the email address is badly formatted.',
    );
  }
  const spec = backend.peekActionCode(parsed.code);
  if (spec === undefined) {
    throw makeAuthError(
      'auth/invalid-action-code',
      'signInWithEmailLink: the action code is invalid. This can happen if the code is malformed, expired, or has already been used.',
    );
  }
  if (spec.expired === true) {
    throw makeAuthError(
      'auth/expired-action-code',
      'signInWithEmailLink: the action code has expired.',
    );
  }
  if (spec.email.toLowerCase() !== email.toLowerCase()) {
    throw makeAuthError(
      'auth/invalid-email',
      'signInWithEmailLink: the email provided does not match the address this sign-in link was issued for.',
    );
  }

  const rawTenant = tenantId === undefined ? backend.getTenantId() : tenantId;
  const effectiveTenant = normalizeTenantScope(rawTenant);
  const existing = backend.findByEmail(spec.email, effectiveTenant);
  if (existing !== undefined) {
    backend.assertSignInAllowed(existing.uid);
    const outcome = await runBeforeSignInHook(auth, {
      uid: existing.uid,
      signInMethod: EMAIL_LINK_SIGN_IN_METHOD,
      tenantId: effectiveTenant,
      client,
      candidateOverride: { emailVerified: true },
      onApproved: () => {
        backend.consumeActionCode(parsed.code);
        backend.upsertEmailLinkUser(spec.email, effectiveTenant);
      },
      stageForCurrentUser,
    });
    return {
      user: outcome.user,
      isNewUser: false,
      sessionClaims: outcome.sessionClaims,
    };
  }

  const beforeCreate = getAuthBlockingHooks(auth)?.beforeCreate;
  let createdStored: StoredUser;
  if (beforeCreate === undefined) {
    backend.consumeActionCode(parsed.code);
    createdStored = backend.upsertEmailLinkUser(spec.email, effectiveTenant).stored;
    backend.assertSignInAllowed(createdStored.uid);
  } else {
    backend.consumeActionCode(parsed.code);
    const uid = `email-${randomUuid()}`;
    const createdAtIso = new Date(getClock(target.sandbox).now()).toISOString();
    const response = await beforeCreate({
      userRecord: {
        uid,
        email: spec.email,
        emailVerified: true,
        displayName: null,
        photoURL: null,
        phoneNumber: null,
        disabled: false,
        creationTime: createdAtIso,
        lastSignInTime: null,
        providerData: [{ uid: spec.email, email: spec.email, providerId: 'password' }],
        tenantId: effectiveTenant,
      },
      signInMethod: EMAIL_LINK_SIGN_IN_METHOD,
      tenantId: effectiveTenant,
      client,
    });
    const { init, clearPhotoUrl } = applyBeforeCreateResponseToInit(
      {
        uid,
        email: spec.email,
        emailVerified: true,
        disabled: false,
        tenantId: effectiveTenant,
        providerUserInfo: [{ providerId: 'password' }],
      },
      response,
    );
    createdStored = SandboxBackend.commitBlockedAccount(backend, init, {
      clearPhotoUrl,
      detail: { emailLink: true },
    });
    backend.assertSignInAllowed(createdStored.uid);
  }
  const outcome = await runBeforeSignInHook(auth, {
    uid: createdStored.uid,
    signInMethod: EMAIL_LINK_SIGN_IN_METHOD,
    tenantId: effectiveTenant,
    client,
    stageForCurrentUser,
  });
  return {
    user: outcome.user,
    isNewUser: true,
    sessionClaims: outcome.sessionClaims,
  };
}

function verifySignedCustomToken(
  auth: Auth,
  customToken: string,
): { uid: string; claims?: Record<string, unknown> } {
  const target = targetOf(auth);
  let reading: ReturnType<typeof readCustomToken> = { kind: 'invalid' };
  if (typeof customToken === 'string') {
    reading = readCustomToken(customToken);
  }
  if (reading.kind !== 'signed') {
    throw makeAuthError(
      'auth/invalid-custom-token',
      'The custom token format is incorrect. Please check the documentation.',
    );
  }
  const signed: SandboxCustomToken = reading;
  if (signed.projectId !== SandboxBackend.tokenProjectId(target.backend)) {
    throw makeAuthError(
      'auth/custom-token-mismatch',
      'The custom token corresponds to a different audience.',
    );
  }
  const nowSec = Math.floor(getClock(target.sandbox).now() / 1000);
  if (nowSec >= signed.exp) {
    throw makeAuthError(
      'auth/invalid-custom-token',
      'The custom token format is incorrect. Please check the documentation.',
    );
  }
  if (signed.claims !== undefined) {
    return { uid: signed.uid, claims: signed.claims };
  }
  return { uid: signed.uid };
}

/** Verify a custom token, running `beforeCreate` (if new) and `beforeSignIn`. */
export async function resolveBlockedCustomTokenIdentity(
  auth: Auth,
  customToken: string,
  tenantId?: string | null,
  client?: AuthBlockingClientContext,
  stageForCurrentUser?: boolean,
): Promise<{ user: User; isNewUser: boolean; sessionClaims?: Record<string, unknown> }> {
  const target = targetOf(auth);
  const { backend } = target;
  const payload = verifySignedCustomToken(auth, customToken);
  const rawTenant = tenantId === undefined ? backend.getTenantId() : tenantId;
  const effectiveTenant = normalizeTenantScope(rawTenant);
  const existing = backend.findByUid(payload.uid);
  if (existing !== undefined) {
    assertMatchingTenant(existing, effectiveTenant);
    backend.assertSignInAllowed(existing.uid);
    const outcome = await runBeforeSignInHook(auth, {
      uid: existing.uid,
      signInMethod: 'custom',
      tenantId: effectiveTenant,
      client,
      onApproved: () => {
        SandboxBackend.setCustomTokenClaims(backend, payload.uid, payload.claims);
      },
      stageForCurrentUser,
    });
    return {
      user: outcome.user,
      isNewUser: false,
      sessionClaims: outcome.sessionClaims,
    };
  }

  const beforeCreate = getAuthBlockingHooks(auth)?.beforeCreate;
  let stored: StoredUser;
  if (beforeCreate !== undefined) {
    const createdAtIso = new Date(getClock(target.sandbox).now()).toISOString();
    const response = await beforeCreate({
      userRecord: {
        uid: payload.uid,
        email: null,
        emailVerified: false,
        displayName: null,
        photoURL: null,
        phoneNumber: null,
        disabled: false,
        creationTime: createdAtIso,
        lastSignInTime: null,
        providerData: [],
        tenantId: effectiveTenant,
      },
      signInMethod: 'custom',
      tenantId: effectiveTenant,
      client,
    });
    const { init, clearPhotoUrl } = applyBeforeCreateResponseToInit(
      {
        uid: payload.uid,
        emailVerified: false,
        disabled: false,
        tenantId: effectiveTenant,
        providerUserInfo: [],
      },
      response,
    );
    stored = SandboxBackend.commitBlockedAccount(backend, init, { clearPhotoUrl });
  } else {
    const createReq: { uid: string; tenantId?: string | null } = { uid: payload.uid };
    if (effectiveTenant !== null) {
      createReq.tenantId = effectiveTenant;
    }
    backend.createUser(createReq);
    const materialized = backend.findByUid(payload.uid);
    if (materialized === undefined) {
      throw makeAuthError(
        'auth/invalid-custom-token',
        'signInWithCustomToken: could not materialize the identity.',
      );
    }
    stored = materialized;
  }

  backend.assertSignInAllowed(stored.uid);
  const outcome = await runBeforeSignInHook(auth, {
    uid: stored.uid,
    signInMethod: 'custom',
    tenantId: effectiveTenant,
    client,
    onApproved: () => {
      SandboxBackend.setCustomTokenClaims(backend, payload.uid, payload.claims);
    },
    stageForCurrentUser,
  });
  return {
    user: outcome.user,
    isNewUser: true,
    sessionClaims: outcome.sessionClaims,
  };
}
