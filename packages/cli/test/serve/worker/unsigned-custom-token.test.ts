/**
 * The worker redeems only the signed custom token `createCustomToken` mints
 * (#2009): each unsigned shape answers `auth/invalid-custom-token` and binds
 * no session to the connection.
 */
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth } from 'pyric/auth';
import { mintCustomTokenFor } from 'pyric/auth/internal';
import { CUSTOM_TOKEN_AUDIENCE } from 'pyric/sandbox/internal';
import { cleanupPort, handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { portSession } from '../../../src/serve/worker/host-auth.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { unsignedCustomTokens } from '../../../../pyric/test/auth/fixtures/unsigned-custom-tokens.js';

function workerHost(): { context: HostCtx; port: PortLike; redeem(token: string): Promise<ResMessage | undefined> } {
  const sandbox = initializeSandbox();
  const context: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: 'unsigned-custom-token', subs: new Map(),
    flushPersistence: async () => {} };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: message => messages.push(message) };
  async function redeem(customToken: string): Promise<ResMessage | undefined> {
    await handleMessage(context, port, { t: 'op', id: crypto.randomUUID(), method: 'auth.signInWithCustomToken',
      customToken } as InboundMessage);
    return messages.findLast((message): message is ResMessage => message.t === 'res');
  }
  return { context, port, redeem };
}

for (const [shape, token] of Object.entries(unsignedCustomTokens(CUSTOM_TOKEN_AUDIENCE))) {
  test(`the worker refuses ${shape}`, async () => {
    const { context, port, redeem } = workerHost();
    try {
      expect(await redeem(token)).toMatchObject({ ok: false, error: { code: 'auth/invalid-custom-token' } });
      expect(portSession(context, port)).toBeNull();
    } finally { await cleanupPort(context, port); }
  });
}

test('the worker redeems the token createCustomToken mints', async () => {
  const { context, port, redeem } = workerHost();
  try {
    const token = mintCustomTokenFor(getAuth(context.sandbox), 'ada', { role: 'editor' });
    expect(await redeem(token)).toMatchObject({ ok: true, value: { user: { uid: 'ada' } } });
  } finally { await cleanupPort(context, port); }
});
