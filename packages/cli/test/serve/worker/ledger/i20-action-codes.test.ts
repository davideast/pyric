import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { handleMessage, cleanupPort, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { portSession } from '../../../../src/serve/worker/host-auth.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../../src/serve/worker/protocol.js';

function fixture() {
  const sandbox = initializeSandbox();
  const context: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: 'action-code-test', subs: new Map(),
    flushPersistence: async () => {},
  };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: message => messages.push(message) };
  async function send(method: string, args: Record<string, unknown> = {}): Promise<ResMessage> {
    const message = { ...args, t: 'op', id: crypto.randomUUID(), method } as InboundMessage;
    await handleMessage(context, port, message);
    const response = messages.findLast((entry): entry is ResMessage => entry.t === 'res');
    const missingResponse = response === undefined;
    if (missingResponse) throw new Error('No response from host');
    return response;
  }
  async function createUser() {
    expect(await send('auth.createUser', { email: 'owner@example.com', password: 'secret-password', tenantId: 'red' }))
      .toMatchObject({ ok: true });
    return portSession(context, port)?.user.uid ?? 'missing';
  }
  function mail(email: string) {
    const message = authSandbox.takeAuthMail(getAuth(sandbox), email);
    const missingMessage = message === null;
    if (missingMessage) throw new Error(`No mail for ${email}`);
    return message;
  }
  return { context, port, send, createUser, mail, close: () => cleanupPort(context, port) };
}

test('served password reset sends a real code, rejects weak passwords without consuming it, and changes the password', async () => {
  const f = fixture();
  try {
    const uid = await f.createUser();
    expect(await f.send('auth.sendPasswordResetEmail', { email: 'absent@example.com' })).toMatchObject({ ok: true });
    expect(authSandbox.takeAuthMail(getAuth(f.context.sandbox))).toBeNull();
    expect(await f.send('auth.sendPasswordResetEmail', { email: 'owner@example.com' })).toMatchObject({ ok: true });
    const { code } = f.mail('owner@example.com');
    expect(await f.send('auth.verifyPasswordResetCode', { code })).toMatchObject({ ok: true, value: 'owner@example.com' });
    expect(await f.send('auth.confirmPasswordReset', { code, newPassword: 'bad' }))
      .toMatchObject({ ok: false, error: { code: 'auth/weak-password' } });
    expect(await f.send('auth.verifyPasswordResetCode', { code })).toMatchObject({ ok: true });
    expect(await f.send('auth.confirmPasswordReset', { code, newPassword: 'changed-password' })).toMatchObject({ ok: true });
    expect(await f.send('auth.verifyPasswordResetCode', { code })).toMatchObject({ ok: false, error: { code: 'auth/invalid-action-code' } });
    expect(await f.send('auth.signInEmail', { email: 'owner@example.com', password: 'secret-password', tenantId: 'red' }))
      .toMatchObject({ ok: false, error: { code: 'auth/wrong-password' } });
    expect(await f.send('auth.signInEmail', { email: 'owner@example.com', password: 'changed-password', tenantId: 'red' }))
      .toMatchObject({ ok: true, value: { user: { uid, tenantId: 'red' } } });
  } finally { await f.close(); }
});

test('served email verification applies only when its issued code is redeemed and cannot be replayed', async () => {
  const f = fixture();
  try {
    const uid = await f.createUser();
    expect(await f.send('auth.sendEmailVerification', { uid, tenantId: 'red' })).toMatchObject({ ok: true });
    expect(portSession(f.context, f.port)?.user.emailVerified).toBe(false);
    const { code } = f.mail('owner@example.com');
    expect(await f.send('auth.checkActionCode', { code }))
      .toMatchObject({ ok: true, value: { operation: 'VERIFY_EMAIL', data: { email: 'owner@example.com' } } });
    expect(await f.send('auth.applyActionCode', { code })).toMatchObject({ ok: true });
    expect(await f.send('auth.reload')).toMatchObject({ ok: true, value: { uid, tenantId: 'red', emailVerified: true } });
    expect(await f.send('auth.applyActionCode', { code })).toMatchObject({ ok: false, error: { code: 'auth/invalid-action-code' } });
  } finally { await f.close(); }
});

test('served verify-before-update mails the new address and keeps the original UID after redemption', async () => {
  const f = fixture();
  try {
    const uid = await f.createUser();
    expect(await f.send('auth.verifyBeforeUpdateEmail', { uid, tenantId: 'red', newEmail: 'changed@example.com' }))
      .toMatchObject({ ok: true });
    expect(portSession(f.context, f.port)?.user.email).toBe('owner@example.com');
    const { code } = f.mail('changed@example.com');
    expect(await f.send('auth.checkActionCode', { code })).toMatchObject({ ok: true, value: {
      operation: 'VERIFY_AND_CHANGE_EMAIL', data: { email: 'changed@example.com', previousEmail: 'owner@example.com' },
    } });
    expect(await f.send('auth.applyActionCode', { code })).toMatchObject({ ok: true });
    expect(await f.send('auth.reload')).toMatchObject({ ok: true, value: { uid, email: 'changed@example.com', tenantId: 'red' } });
    expect(await f.send('auth.signInEmail', { email: 'changed@example.com', password: 'secret-password', tenantId: 'red' }))
      .toMatchObject({ ok: true, value: { user: { uid } } });
  } finally { await f.close(); }
});

test('served action-code boundaries preserve documented validation errors and reject another session', async () => {
  const f = fixture();
  try {
    expect(await f.send('auth.signInAnonymously')).toMatchObject({ ok: true });
    const uid = portSession(f.context, f.port)?.user.uid ?? 'missing';
    expect(await f.send('auth.sendEmailVerification', { uid, tenantId: null }))
      .toMatchObject({ ok: false, error: { code: 'auth/missing-email' } });
    expect(await f.send('auth.sendEmailVerification', { uid: 'another-user', tenantId: null }))
      .toMatchObject({ ok: false, error: { code: 'auth/user-mismatch' } });
    expect(await f.send('auth.sendPasswordResetEmail', { email: 'invalid' }))
      .toMatchObject({ ok: false, error: { code: 'auth/invalid-email' } });
    expect(await f.send('auth.sendPasswordResetEmail', { email: 'absent@example.com', settings: { url: 'invalid' } }))
      .toMatchObject({ ok: false, error: { code: 'auth/invalid-continue-uri' } });
    expect(await f.send('auth.checkActionCode', { code: 'unknown' }))
      .toMatchObject({ ok: false, error: { code: 'auth/invalid-action-code' } });
  } finally { await f.close(); }
});
