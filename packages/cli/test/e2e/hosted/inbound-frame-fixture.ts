import { WebSocket } from 'ws';
import { expect } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

const frameLimit = 12 * 1024 * 1024;
export const inboundFrameCases = [
  { bytes: frameLimit - 1, fragmented: false, acceptsWrite: true },
  { bytes: frameLimit, fragmented: false, acceptsWrite: true },
  { bytes: frameLimit + 1, fragmented: false, acceptsWrite: false },
  { bytes: frameLimit, fragmented: true, acceptsWrite: true },
  { bytes: frameLimit + 1, fragmented: true, acceptsWrite: false },
];

export async function checkInboundFrame(url: string, size: { bytes: number; fragmented: boolean; acceptsWrite: boolean }, message: string): Promise<void> {
  const { fragmented, acceptsWrite } = size;
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/__pyric/sandbox`);
  let attached = false;
  let outcome: number | boolean | 'pending' = 'pending';
  socket.addEventListener('close', event => { outcome = event.code; });
  socket.addEventListener('message', event => {
    const frame: unknown = JSON.parse(event.data.toString());
    const isKnownFrame = isBridgeMessage(frame);
    const acknowledgesAttach = isKnownFrame && frame.type === 'attach-ack';
    if (acknowledgesAttach) attached = true;
    const acknowledgesWrite = isKnownFrame && frame.type === 'worker-res';
    if (acknowledgesWrite) outcome = frame.ok;
  });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
    await expect.poll(() => attached).toBe(true);
    const request = { type: 'worker-op', id: 'sized-frame', op: {
      method: 'setDoc', path: 'shared/greeting', data: { message }, actAs: { mode: 'admin' },
    }, padding: '' };
    const envelopeBytes = Buffer.byteLength(JSON.stringify(request));
    const paddingBytes = size.bytes - envelopeBytes;
    request.padding = 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2);
    const payload = JSON.stringify(request);
    expect(Buffer.byteLength(payload)).toBe(size.bytes);
    if (fragmented) {
      const midpoint = Math.floor(payload.length / 2);
      socket.send(payload.slice(0, midpoint), { fin: false });
      socket.send(payload.slice(midpoint), { fin: true });
    } else {
      socket.send(payload);
    }
    const expectedOutcome = acceptsWrite ? true : 1009;
    await expect.poll(() => outcome).toBe(expectedOutcome);
  } finally {
    socket.close();
  }
}
