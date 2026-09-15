import { expect, test } from '@playwright/test';
import { isBridgeMessage, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

type Attachment = Extract<BridgeMessage, { type: 'attach-ack' }>;
async function attach(url: string, resumeToken?: string, hostInstanceId?: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/__pyric/sandbox');
  let outcome: Attachment | number | undefined;
  socket.addEventListener('message', event => {
    const frame: unknown = JSON.parse(event.data);
    const isFrame = isBridgeMessage(frame);
    const isAttachment = isFrame && frame.type === 'attach-ack';
    if (isAttachment) outcome = frame;
  });
  socket.addEventListener('close', event => { outcome ??= event.code; });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port', resumeToken, hostInstanceId }));
    await expect.poll(() => outcome).toBeDefined();
    return outcome;
  } finally { socket.close(); }
}

test('altering an issued resume grant refuses admission without invalidating the original grant', async () => {
  const fixture = await startHostedFixture();
  try {
    const original = await attach(fixture.info.url);
    const hasAttachment = typeof original === 'object' && typeof original.resumeToken === 'string';
    const hasNoAttachment = !hasAttachment;
    if (hasNoAttachment) throw new Error('Expected a hosted session grant');
    const token = original.resumeToken;
    const hasNoToken = token === undefined;
    if (hasNoToken) throw new Error('Expected a resume token');
    const last = token.at(-1);
    const endsInZero = last === '0';
    const changedLast = endsInZero ? '1' : '0';
    const altered = [token.slice(0, -1) + changedLast, 'x' + token.slice(1), token + '.extra', token.slice(0, -1) + 'g'];
    for (const candidate of altered) {
      expect(await attach(fixture.info.url, candidate, original.hostInstanceId)).toBe(1008);
    }
    expect(await attach(fixture.info.url, token, original.hostInstanceId)).toMatchObject({
      type: 'attach-ack', resumeToken: token, clientSessionId: original.clientSessionId,
    });
  } finally { await fixture.stop(); }
});
