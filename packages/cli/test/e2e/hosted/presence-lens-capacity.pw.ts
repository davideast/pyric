import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import {
  isBridgeMessage, type BridgeMessage, type RemoteSetLensAckFrame, type AuthLens,
} from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const sender of ['consumer', 'peer']) {
  test(`an oversized lens update from a ${sender} preserves identity, presence and listeners`, async ({ page }) => {
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const acknowledgments = new Map<string, RemoteSetLensAckFrame>();
    let presenceLens: AuthLens | undefined;
    let targetLens: AuthLens | undefined;
    let targetSnapshot: unknown;
    let lensEvents = 0;
    let closedSockets = 0;
    let sendFromPeer: ((payload: string) => void) | undefined;
    const sockets: WebSocket[] = [];
    function observe(frame: BridgeMessage, origin: string): void {
      const isAcknowledgment = frame.type === 'remote-set-lens-ack';
      if (isAcknowledgment) {
        const id = frame.id;
        const isExpectedAcknowledgment = origin === sender && id !== undefined;
        if (isExpectedAcknowledgment) acknowledgments.set(id, frame);
      }
      const isPresence = frame.type === 'consumer-presence';
      if (isPresence) presenceLens = frame.consumers.find(consumer => consumer.clientSessionId === 'target')?.activeLens;
      const isLensDelivery = origin === 'target' && frame.type === 'worker-event' && frame.event === 'remote-lens';
      if (isLensDelivery) {
        lensEvents += 1;
        targetLens = frame.lens;
      }
      const isTargetSnapshot = origin === 'target' && frame.type === 'worker-snap';
      if (isTargetSnapshot) targetSnapshot = frame.value;
    }
    await page.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      sendFromPeer = payload => server.send(payload);
      server.onMessage(raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isKnownFrame = isBridgeMessage(frame);
        if (isKnownFrame) observe(frame, 'peer');
        route.send(raw);
      });
    });
    page.on('websocket', socket => socket.on('close', () => { closedSockets += 1; }));
    function connectConsumer(id: string, deviceLabel: string) {
      const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
      sockets.push(socket);
      const state = { attached: false };
      socket.on('open', () => socket.send(JSON.stringify({
        type: 'attach', protocol: 1, clientSessionId: id, clientInfo: { platform: 'studio', deviceLabel },
      })));
      socket.on('close', () => { closedSockets += 1; });
      socket.on('message', raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isKnownFrame = isBridgeMessage(frame);
        if (isKnownFrame) {
          const isAcknowledgment = frame.type === 'attach-ack';
          if (isAcknowledgment) state.attached = true;
          observe(frame, id);
        }
      });
      return { socket, state };
    }
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      const target = connectConsumer('target', 'Target consumer');
      const controller = connectConsumer('consumer', 'é'.repeat(3 * 1024 * 1024));
      await expect.poll(() => target.state.attached && controller.state.attached).toBe(true);
      await expect.poll(() => presenceLens?.mode).toBe('app-session');
      target.socket.send(JSON.stringify({ type: 'worker-sub', subId: 'keep-listening', sub: {
        target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' },
      } }));
      await expect.poll(() => targetSnapshot).toMatchObject({ exists: false });
      function sendLensPayload(payload: string): void {
        expect(Buffer.byteLength(payload)).toBeLessThan(12_582_912);
        const usesPeer = sender === 'peer';
        if (usesPeer) {
          const send = sendFromPeer;
          const hasNoPeer = send === undefined;
          if (hasNoPeer) throw new Error('The sandbox peer did not connect');
          send(payload);
        } else {
          controller.socket.send(payload);
        }
      }
      function updateLens(id: string, lens: AuthLens): void {
        sendLensPayload(JSON.stringify({ type: 'remote-set-lens', id, clientSessionId: 'target', lens }));
      }
      updateLens('oversized', { mode: 'as', uid: 'large-user', token: { payload: 'é'.repeat(3 * 1024 * 1024) } });
      await expect.poll(() => acknowledgments.get('oversized')).toMatchObject({
        ok: false, clientSessionId: 'target', error: { code: 'resource-exhausted' },
      });
      const nestedClaim = '['.repeat(20_000) + '0' + ']'.repeat(20_000);
      sendLensPayload(`{"type":"remote-set-lens","id":"deep","clientSessionId":"target","lens":{"mode":"as","uid":"deep-user","token":{"payload":${nestedClaim}}}}`);
      await expect.poll(() => acknowledgments.get('deep')).toMatchObject({
        ok: false, error: { code: 'resource-exhausted', message: 'Consumer metadata exceeds the serialization depth limit.' },
      });
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect.poll(() => targetSnapshot).toMatchObject({
        exists: true, data: { json: '{"message":"Hello from the other browser"}', valueEncoding: 'pyric/firestore-values/1' },
      });
      expect(lensEvents).toBe(0);
      expect(targetLens).toBeUndefined();
      expect(presenceLens?.mode).toBe('app-session');
      updateLens('healthy', { mode: 'anon' });
      await expect.poll(() => acknowledgments.get('healthy')).toMatchObject({ ok: true, clientSessionId: 'target' });
      await expect.poll(() => targetLens?.mode).toBe('anon');
      await expect.poll(() => presenceLens?.mode).toBe('anon');
      expect(lensEvents).toBe(1);
      target.socket.send(JSON.stringify({ type: 'worker-unsub', subId: 'keep-listening' }));
      expect(closedSockets).toBe(0);
    } finally {
      await test.info().attach('host-state', {
        body: JSON.stringify({ exitCode: fixture.child.exitCode, stderr: fixture.stderr().slice(-4000) }),
        contentType: 'application/json',
      });
      for (const socket of sockets) socket.close();
      await page.close().finally(() => fixture.stop());
    }
  });
}
