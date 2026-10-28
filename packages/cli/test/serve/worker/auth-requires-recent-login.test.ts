import { expect, test } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { handleMessage, cleanupPort, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { portSession } from '../../../src/serve/worker/host-auth.js';
import type { OpMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';

const STALE = { ok: false, error: { code: 'auth/requires-recent-login' } };

test('a port session older than five minutes is refused sensitive operations until it reauthenticates', async () => {
  const sandbox = initializeSandbox();
  const context: HostCtx = {
    sandbox, db: getFirestore(sandbox), instanceId: 'recent-login-test', subs: new Map(),
    flushPersistence: async () => {},
  };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: message => messages.push(message) };
  async function send(message: OpMessage): Promise<ResMessage> {
    await handleMessage(context, port, message);
    const response = messages.findLast((entry): entry is ResMessage => entry.t === 'res' && entry.id === message.id);
    const missingResponse = response === undefined;
    if (missingResponse) throw new Error('No response from host');
    return response;
  }
  try {
    await send({ t: 'op', id: 'create', method: 'auth.createUser', email: 'owner@example.com', password: 'secret-password' });
    const uid = portSession(context, port)?.user.uid ?? 'missing';
    expect(await send({ t: 'op', id: 'fresh', method: 'auth.updatePassword', password: 'secret-password-2' }))
      .toMatchObject({ ok: true });

    getClock(sandbox).advance(305_000);
    // A reload and a forced token refresh re-mint the session without
    // authenticating, so neither clears the gate.
    expect(await send({ t: 'op', id: 'reload', method: 'auth.reload' })).toMatchObject({ ok: true });
    expect(await send({ t: 'op', id: 'refresh', method: 'auth.getIdToken', forceRefresh: true })).toMatchObject({ ok: true });

    expect(await send({ t: 'op', id: 'password', method: 'auth.updatePassword', password: 'secret-password-3' }))
      .toMatchObject(STALE);
    expect(await send({ t: 'op', id: 'email', method: 'auth.updateEmail', email: 'moved@example.com' }))
      .toMatchObject(STALE);
    expect(await send({ t: 'op', id: 'verify', method: 'auth.verifyBeforeUpdateEmail', uid, tenantId: null,
      newEmail: 'moved@example.com' })).toMatchObject(STALE);
    expect(await send({ t: 'op', id: 'delete', method: 'auth.deleteUser' })).toMatchObject(STALE);
    expect(await send({ t: 'op', id: 'unlink', method: 'auth.unlink', uid, tenantId: null, providerId: 'github.com' }))
      .toMatchObject({ ok: false, error: { code: 'auth/no-such-provider' } });
    expect(portSession(context, port)?.user.email).toBe('owner@example.com');

    const credential = { providerId: 'password', signInMethod: 'password', email: 'owner@example.com', password: 'secret-password-2' };
    expect(await send({ t: 'op', id: 'reauth', method: 'auth.reauthenticateWithCredential', uid, tenantId: null, credential }))
      .toMatchObject({ ok: true });
    expect(await send({ t: 'op', id: 'after', method: 'auth.updatePassword', password: 'secret-password-3' }))
      .toMatchObject({ ok: true });
    expect(await send({ t: 'op', id: 'gone', method: 'auth.deleteUser' })).toMatchObject({ ok: true });
    expect(portSession(context, port)).toBeNull();
  } finally { await cleanupPort(context, port); }
});

test('deleteUser on a port session whose account was removed out of band reports auth/user-not-found', async () => {
  const sandbox = initializeSandbox();
  const context: HostCtx = {
    sandbox, db: getFirestore(sandbox), instanceId: 'recent-login-missing', subs: new Map(),
    flushPersistence: async () => {},
  };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: message => messages.push(message) };
  async function send(message: OpMessage): Promise<ResMessage> {
    await handleMessage(context, port, message);
    const response = messages.findLast((entry): entry is ResMessage => entry.t === 'res' && entry.id === message.id);
    const missingResponse = response === undefined;
    if (missingResponse) throw new Error('No response from host');
    return response;
  }
  try {
    await send({ t: 'op', id: 'create', method: 'auth.createUser', email: 'gone@example.com', password: 'secret-password' });
    const uid = portSession(context, port)?.user.uid ?? 'missing';
    authSandbox.deleteUser(getAuth(sandbox), uid);
    expect(await send({ t: 'op', id: 'delete', method: 'auth.deleteUser' }))
      .toMatchObject({ ok: false, error: { code: 'auth/user-not-found' } });
  } finally { await cleanupPort(context, port); }
});
