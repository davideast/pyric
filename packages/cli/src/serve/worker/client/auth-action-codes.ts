import type { ActionCodeInfo, ActionCodeSettings, OutboundAuthMail } from 'pyric/auth';
import type { AuthBlockingSmsType, OutboundAuthSms } from 'pyric/auth/internal';
import type { SerializedUserCredential } from '../protocol.js';
import { hydrateCred, requireUserPort, type ClientAuth, type ClientUser, type ClientUserCredential } from './auth.js';
import { attachHeldUserIdentity } from './auth-user-identity.js';
import { nextId, rpc } from './core.js';

/** Consume the shared sandbox's in-memory mailbox. Any attached page can take mail. */
export async function takeAuthMail(auth: ClientAuth, email?: string): Promise<OutboundAuthMail | null> {
  return await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.takeMail', email }) as OutboundAuthMail | null;
}

/** Consume the shared sandbox's in-memory SMS verification outbox. */
export async function takeAuthSms(auth: ClientAuth, phoneNumber?: string): Promise<OutboundAuthSms | null> {
  return await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.takeSms', phoneNumber }) as OutboundAuthSms | null;
}

/** Dispatch a verification SMS through `beforeSmsSent` (if active) into the shared SMS outbox. */
export async function sendAuthSmsVerification(
  auth: ClientAuth,
  request: {
    phoneNumber: string;
    smsType?: AuthBlockingSmsType;
    uid?: string;
    tenantId?: string | null;
  },
): Promise<OutboundAuthSms> {
  let tenantId = auth.tenantId;
  if (request.tenantId !== undefined) {
    tenantId = request.tenantId;
  }
  return await rpc(auth.port, {
    t: 'op',
    id: nextId(),
    method: 'auth.sendSmsVerification',
    phoneNumber: request.phoneNumber,
    smsType: request.smsType,
    uid: request.uid,
    tenantId,
  }) as OutboundAuthSms;
}

export async function sendSignInLinkToEmail(auth: ClientAuth, email: string, settings: ActionCodeSettings): Promise<void> {
  await rpc(auth.port, {
    t: 'op',
    id: nextId(),
    method: 'auth.sendSignInLinkToEmail',
    email,
    settings,
    tenantId: auth.tenantId,
  });
}

export async function signInWithEmailLink(auth: ClientAuth, email: string, link: string): Promise<ClientUserCredential> {
  const raw = await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.signInWithEmailLink', email, link,
    tenantId: auth.tenantId }) as SerializedUserCredential;
  return hydrateCred(auth, raw);
}

export async function sendPasswordResetEmail(auth: ClientAuth, email: string, settings?: ActionCodeSettings): Promise<void> {
  await rpc(auth.port, {
    t: 'op',
    id: nextId(),
    method: 'auth.sendPasswordResetEmail',
    email,
    settings,
    tenantId: auth.tenantId,
  });
}

export async function sendEmailVerification(user: ClientUser, settings?: ActionCodeSettings): Promise<void> {
  const port = requireUserPort(user, 'sendEmailVerification');
  await rpc(port, attachHeldUserIdentity(user, {
    t: 'op', id: nextId(), method: 'auth.sendEmailVerification', uid: user.uid, tenantId: user.tenantId, settings,
  }));
}

export async function verifyBeforeUpdateEmail(user: ClientUser, newEmail: string, settings?: ActionCodeSettings): Promise<void> {
  const port = requireUserPort(user, 'verifyBeforeUpdateEmail');
  await rpc(port, attachHeldUserIdentity(user, {
    t: 'op', id: nextId(), method: 'auth.verifyBeforeUpdateEmail', uid: user.uid, tenantId: user.tenantId, newEmail, settings,
  }));
}

export async function applyActionCode(auth: ClientAuth, code: string): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.applyActionCode', code });
}

export async function checkActionCode(auth: ClientAuth, code: string): Promise<ActionCodeInfo> {
  return await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.checkActionCode', code }) as ActionCodeInfo;
}

export async function verifyPasswordResetCode(auth: ClientAuth, code: string): Promise<string> {
  return await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.verifyPasswordResetCode', code }) as string;
}

export async function confirmPasswordReset(auth: ClientAuth, code: string, newPassword: string): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.confirmPasswordReset', code, newPassword });
}
