import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { McpHttpClient, startSoakServe, waitForPeer } from '../soak/harness.js';

test('MCP identity changes report presence exhaustion without changing the target', async ({ page }) => {
  const fixture = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    },
  });
  const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
  let attached = false;
  let closedSockets = 0;
  let lensEvents = 0;
  let targetMode: string | undefined;
  let targetSnapshot: unknown;
  page.on('websocket', peer => peer.on('close', () => { closedSockets += 1; }));
  socket.on('close', () => { closedSockets += 1; });
  socket.on('message', raw => {
    const frame: unknown = JSON.parse(raw.toString());
    const isKnownFrame = isBridgeMessage(frame);
    if (isKnownFrame) {
      const isAttached = frame.type === 'attach-ack';
      if (isAttached) attached = true;
      const isLensDelivery = frame.type === 'worker-event' && frame.event === 'remote-lens';
      if (isLensDelivery) {
        lensEvents += 1;
        targetMode = frame.lens.mode;
      }
      const isSnapshot = frame.type === 'worker-snap';
      if (isSnapshot) targetSnapshot = frame.value;
    }
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await waitForPeer(fixture.info.url);
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId: 'target', clientInfo: {
      platform: 'node', deviceLabel: 'é'.repeat(5.5 * 1024 * 1024),
    } }));
    await expect.poll(() => attached).toBe(true);
    socket.send(JSON.stringify({ type: 'worker-sub', subId: 'keep-listening', sub: {
      target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' },
    } }));
    await expect.poll(() => targetSnapshot).toMatchObject({ exists: false });
    const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
    await mcp.initialize();
    const refused = await mcp.toolCall('auth_impersonate', {
      target: 'target', uid: 'large-user', claims: { payload: 'é'.repeat(1024 * 1024) },
    });
    expect(refused.ok).toBe(false);
    expect(refused.data).toMatchObject({ code: 'resource-exhausted' });
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect.poll(() => targetSnapshot).toMatchObject({ exists: true });
    expect(lensEvents).toBe(0);
    const afterRefusal = await mcp.toolCall('auth_sessions', {});
    expect(sessionMode(afterRefusal.data)).toBe('app-session');
    const accepted = await mcp.toolCall('auth_impersonate', { target: 'target', anonymous: true });
    expect(accepted.ok).toBe(true);
    await expect.poll(() => targetMode).toBe('anon');
    const afterUpdate = await mcp.toolCall('auth_sessions', {});
    expect(sessionMode(afterUpdate.data)).toBe('anon');
    expect(lensEvents).toBe(1);
    expect(closedSockets).toBe(0);
    socket.send(JSON.stringify({ type: 'worker-unsub', subId: 'keep-listening' }));
  } finally {
    socket.close();
    await page.close().finally(() => fixture.stop());
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionMode(data: unknown): unknown {
  const isOtherData = !isRecord(data);
  if (isOtherData) return;
  const sessions = data.sessions;
  const hasSessions = Array.isArray(sessions);
  if (hasSessions) {
    for (const session of sessions) {
      const isTarget = isRecord(session) && session.target === 'target';
      if (isTarget) {
        const identity = session.identityDetail;
        const hasIdentity = isRecord(identity);
        if (hasIdentity) return identity.mode;
      }
    }
  }
}
