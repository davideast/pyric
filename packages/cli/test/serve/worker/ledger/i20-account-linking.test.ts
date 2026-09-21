import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth } from 'pyric/auth';
import { handleMessage, cleanupPort, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { portSession } from '../../../../src/serve/worker/host-auth.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../../src/serve/worker/protocol.js';

function fixture() {
  const sandbox = initializeSandbox();
  const context: HostCtx = {
    sandbox, db: getFirestore(sandbox), instanceId: 'linking-test', subs: new Map(),
    flushPersistence: async () => {},
  };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: message => messages.push(message) };
  const other: PortLike = { postMessage() {} };
  async function send(message: InboundMessage): Promise<ResMessage> {
    await handleMessage(context, port, message);
    const response = messages.findLast((entry): entry is ResMessage => entry.t === 'res');
    const missingResponse = response === undefined;
    if (missingResponse) throw new Error('No response from host');
    return response;
  }
  async function close() {
    await cleanupPort(context, port);
    await cleanupPort(context, other);
  }
  return { context, port, other, messages, send, close };
}

test('linking waits for persistence, preserves the tenant and leaves the other port signed in', async () => {
  const f = fixture();
  try {
    await f.send({ t: 'op', id: 'anonymous', method: 'auth.signInAnonymously', tenantId: 'red' });
    await handleMessage(f.context, f.other, { t: 'op', id: 'other', method: 'auth.signInAnonymously', tenantId: 'blue' });
    const original = portSession(f.context, f.port);
    const other = portSession(f.context, f.other);
    expect(original).not.toBeNull();
    const uid = original?.user.uid ?? 'missing';
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.context.flushPersistence = () => { entered.resolve(); return release.promise; };
    const pending = f.send({ t: 'op', id: 'link', method: 'auth.linkWithCredential', uid, tenantId: 'red',
      credential: { providerId: 'password', signInMethod: 'password', email: 'linked@example.com', password: 'secret-password' } });
    try {
      await entered.promise;
      expect(f.messages.some(message => message.t === 'res' && message.id === 'link')).toBe(false);
    } finally { release.resolve(); }
    expect(await pending).toMatchObject({ ok: true, value: { operationType: 'link', user: { uid, tenantId: 'red', isAnonymous: false } } });
    expect(portSession(f.context, f.other)).toBe(other);
    expect(getAuth(f.context.sandbox).currentUser).toBeNull();
    const token = await portSession(f.context, f.port)?.user.getIdTokenResult();
    expect(token?.signInProvider).toBe('password');
    expect(token?.claims.firebase).toMatchObject({ tenant: 'red' });
  } finally { await f.close(); }
});

test('linking preserves engine errors without changing the current account', async () => {
  const f = fixture();
  try {
    await f.send({ t: 'op', id: 'existing', method: 'auth.createUser', email: 'taken@example.com', password: 'secret-password' });
    await f.send({ t: 'op', id: 'anonymous', method: 'auth.signInAnonymously' });
    const uid = portSession(f.context, f.port)?.user.uid ?? 'missing';
    const credential = { providerId: 'password', signInMethod: 'password', email: 'taken@example.com', password: 'secret-password' };
    expect(await f.send({ t: 'op', id: 'conflict', method: 'auth.linkWithCredential', uid, tenantId: null, credential }))
      .toMatchObject({ ok: false, error: { code: 'auth/email-already-in-use' } });
    await f.send({ t: 'op', id: 'disable', method: 'auth.setProviderConfig', providerId: 'google.com', enabled: false });
    expect(await f.send({ t: 'op', id: 'disabled', method: 'auth.linkWithCredential', uid, tenantId: null,
      credential: { providerId: 'google.com', signInMethod: 'google.com' } }))
      .toMatchObject({ ok: false, error: { code: 'auth/operation-not-allowed' } });
    expect(portSession(f.context, f.port)?.user).toMatchObject({ uid, isAnonymous: true, providerData: [] });
  } finally { await f.close(); }
});

test('a link waiting for persistence cannot undo a subsequent sign-out', async () => {
  const f = fixture();
  try {
    await f.send({ t: 'op', id: 'anonymous', method: 'auth.signInAnonymously' });
    const uid = portSession(f.context, f.port)?.user.uid ?? 'missing';
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.context.flushPersistence = () => { entered.resolve(); return release.promise; };
    const pending = f.send({ t: 'op', id: 'link', method: 'auth.linkWithCredential', uid, tenantId: null,
      credential: { providerId: 'google.com', signInMethod: 'google.com' } });
    try {
      await entered.promise;
      await f.send({ t: 'op', id: 'signout', method: 'auth.signOut' });
    } finally { release.resolve(); }
    expect(await pending).toMatchObject({ ok: true, value: { user: { uid } } });
    expect(portSession(f.context, f.port)).toBeNull();
  } finally { await f.close(); }
});

test('malformed credentials and another tenant are refused at the host boundary', async () => {
  const f = fixture();
  try {
    await f.send({ t: 'op', id: 'anonymous', method: 'auth.signInAnonymously', tenantId: 'red' });
    const uid = portSession(f.context, f.port)?.user.uid ?? 'missing';
    expect(await f.send({ t: 'op', id: 'malformed', method: 'auth.linkWithCredential', uid, tenantId: 'red',
      credential: { providerId: 'password', signInMethod: 'password' } }))
      .toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    expect(await f.send({ t: 'op', id: 'tenant', method: 'auth.linkWithCredential', uid, tenantId: 'blue',
      credential: { providerId: 'google.com', signInMethod: 'google.com' } }))
      .toMatchObject({ ok: false, error: { code: 'auth/user-mismatch' } });
    expect(portSession(f.context, f.port)?.user).toMatchObject({ uid, isAnonymous: true, providerData: [] });
  } finally { await f.close(); }
});
