import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { handleMessage, cleanupPort, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { portSession } from '../../../../src/serve/worker/host-auth.js';
import { requiresHealthyPersistence } from '../../../../src/serve/hosted/persistence-admission.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../../src/serve/worker/protocol.js';

test('custom-token redemption persists claims and binds only the requesting connection', async () => {
  const sandbox = initializeSandbox();
  let flushes = 0;
  const context: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: 'custom-token', subs: new Map(),
    flushPersistence: async () => { flushes++; } };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: message => messages.push(message) };
  const other: PortLike = { postMessage: () => {} };
  async function redeem(customToken: string): Promise<ResMessage | undefined> {
    await handleMessage(context, port, { t: 'op', id: crypto.randomUUID(), method: 'auth.signInWithCustomToken',
      customToken, tenantId: 'red' } as InboundMessage);
    return messages.findLast((message): message is ResMessage => message.t === 'res');
  }
  try {
    // Custom tokens are a backend assertion, independent of provider enablement.
    authSandbox.setAuthProviderConfig(getAuth(sandbox), 'custom', false);
    await handleMessage(context, other, { t: 'op', id: 'other', method: 'auth.signInAnonymously', tenantId: 'blue' });
    const otherSession = portSession(context, other);
    const before = flushes;
    expect(requiresHealthyPersistence({ t: 'op', id: 'admission', method: 'auth.signInWithCustomToken',
      customToken: JSON.stringify({ uid: 'custom-user' }), tenantId: 'red' })).toBe(true);
    expect(await redeem(JSON.stringify({ uid: 'custom-user', claims: { role: 'editor' } })))
      .toMatchObject({ ok: true, value: { user: { uid: 'custom-user', tenantId: 'red' }, providerId: null,
        operationType: 'signIn', additionalUserInfo: { isNewUser: true } } });
    expect(flushes).toBe(before + 1);
    const session = portSession(context, port);
    expect(await session?.user.getIdTokenResult()).toMatchObject({ claims: { role: 'editor', firebase: {
      tenant: 'red', sign_in_provider: 'custom',
    } } });
    expect(await redeem(JSON.stringify({ uid: 'custom-user', claims: { role: 'reader' } })))
      .toMatchObject({ ok: true, value: { additionalUserInfo: { isNewUser: false } } });
    expect(portSession(context, port)?.state.token).toMatchObject({ role: 'reader' });
    expect(portSession(context, other)).toBe(otherSession);
    expect(getAuth(sandbox).currentUser).toBeNull();
    const beforeInvalid = portSession(context, port);
    expect(await redeem('invalid')).toMatchObject({ ok: false, error: { code: 'auth/invalid-custom-token' } });
    expect(portSession(context, port)).toBe(beforeInvalid);
    authSandbox.updateUser(getAuth(sandbox), 'custom-user', { disabled: true });
    expect(await redeem(JSON.stringify({ uid: 'custom-user' })))
      .toMatchObject({ ok: false, error: { code: 'auth/user-disabled' } });
  } finally { await cleanupPort(context, port); await cleanupPort(context, other); }
});
