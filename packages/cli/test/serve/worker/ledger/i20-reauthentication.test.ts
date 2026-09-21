import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { handleMessage, cleanupPort, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { portSession } from '../../../../src/serve/worker/host-auth.js';
import type { OpMessage, OutboundMessage, ResMessage } from '../../../../src/serve/worker/protocol.js';

test('reauthentication changes session tokens without flushing or changing persisted accounts', async () => {
  const sandbox = initializeSandbox();
  let flushes = 0;
  const context: HostCtx = {
    sandbox, db: getFirestore(sandbox), instanceId: 'reauth-test', subs: new Map(),
    flushPersistence: async () => { flushes++; },
  };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: message => messages.push(message) };
  async function send(message: OpMessage): Promise<ResMessage> {
    await handleMessage(context, port, message);
    const response = messages.findLast((entry): entry is ResMessage => entry.t === 'res');
    const missingResponse = response === undefined;
    if (missingResponse) throw new Error('No response from host');
    return response;
  }
  try {
    await send({ t: 'op', id: 'create', method: 'auth.createUser', tenantId: 'red',
      email: 'owner@example.com', password: 'secret-password' });
    const uid = portSession(context, port)?.user.uid ?? 'missing';
    const before = authSandbox.exportUsers(getAuth(sandbox));
    expect(flushes).toBe(1);
    const credential = { providerId: 'password', signInMethod: 'password', email: 'owner@example.com', password: 'secret-password' };
    expect(await send({ t: 'op', id: 'reauth', method: 'auth.reauthenticateWithCredential', uid, tenantId: 'red', credential }))
      .toMatchObject({ ok: true, value: { operationType: 'reauthenticate', user: { uid, tenantId: 'red' } } });
    expect(authSandbox.exportUsers(getAuth(sandbox))).toEqual(before);
    expect(flushes).toBe(1);
    expect(await send({ t: 'op', id: 'wrong-tenant', method: 'auth.reauthenticateWithCredential', uid, tenantId: 'blue', credential }))
      .toMatchObject({ ok: false, error: { code: 'auth/user-mismatch' } });
    expect(await send({ t: 'op', id: 'missing-secret', method: 'auth.reauthenticateWithCredential', uid, tenantId: 'red',
      credential: { providerId: 'password', signInMethod: 'password' } }))
      .toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    await send({ t: 'op', id: 'disable', method: 'auth.setProviderConfig', providerId: 'google.com', enabled: false });
    expect(await send({ t: 'op', id: 'disabled', method: 'auth.reauthenticateWithProvider', uid, tenantId: 'red',
      identity: { uid, providerId: 'google.com' } }))
      .toMatchObject({ ok: false, error: { code: 'auth/operation-not-allowed' } });
    expect(portSession(context, port)?.user).toMatchObject({ uid, tenantId: 'red' });
    expect(getAuth(sandbox).currentUser).toBeNull();
  } finally { await cleanupPort(context, port); }
});
