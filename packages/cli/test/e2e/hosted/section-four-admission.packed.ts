import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';
import { isBridgeMessage, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { packedProject, startPackedServer } from './section-four-fixture.js';

type Attachment = Extract<BridgeMessage, { type: 'attach-ack' }>;
type Admission = { kind: 'attached'; frame: Attachment } | { kind: 'http'; status: number } | { kind: 'closed'; code: number };

async function admission(url: string, options: { origin?: string; resumeToken?: string; hostInstanceId?: string } = {}): Promise<Admission> {
  const endpoint = new URL('/__pyric/sandbox', url);
  endpoint.protocol = 'ws:';
  const socket = new WebSocket(endpoint, { origin: options.origin });
  const outcome = Promise.withResolvers<Admission>();
  socket.on('error', () => undefined);
  socket.once('unexpected-response', (_request, response) => {
    outcome.resolve({ kind: 'http', status: response.statusCode ?? 0 });
    response.resume();
  });
  socket.once('open', () => socket.send(JSON.stringify({
    type: 'attach', protocol: 1, transport: 'worker-port',
    resumeToken: options.resumeToken, hostInstanceId: options.hostInstanceId,
  })));
  socket.on('message', data => {
    const frame: unknown = JSON.parse(data.toString());
    const isAttachment = isBridgeMessage(frame) && frame.type === 'attach-ack';
    if (isAttachment) outcome.resolve({ kind: 'attached', frame });
  });
  socket.once('close', code => outcome.resolve({ kind: 'closed', code }));
  const timeout = setTimeout(() => outcome.reject(new Error('Admission did not settle')), 5_000);
  try { return await outcome.promise; }
  finally { clearTimeout(timeout); socket.terminate(); }
}

for (const mode of ['hosted', 'vite'] as const) {
  test(`installed ${mode} refuses untrusted browser and socket origins while a valid app remains usable`, async ({ page, context }) => {
    const project = packedProject();
    const server = startPackedServer(project, mode);
    try {
      const url = await server.url;
      await page.goto(url);
      await expect(page.locator('#result')).toHaveText('Ready');
      await page.locator('#write').click();
      await expect(page.locator('#result')).toHaveText('Written');
      const original = await page.locator('#document').innerText();
      expect(await admission(url, { origin: 'http://untrusted.invalid' })).toEqual({ kind: 'closed', code: 1006 });
      expect(await admission(url, { origin: 'null' })).toEqual({ kind: 'closed', code: 1006 });
      const deniedHttp = await fetch(new URL('/__pyric/mcp', url), {
        method: 'POST', headers: { Origin: 'http://untrusted.invalid', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(deniedHttp.status).toBe(403);
      const attacker = await context.newPage();
      await attacker.route('http://untrusted.invalid/', route => route.fulfill({
        contentType: 'text/html', body: `<output>Starting</output><script>
          const socket = new WebSocket(${JSON.stringify(new URL('/__pyric/sandbox', url).href.replace('http:', 'ws:'))});
          socket.onopen = () => { document.querySelector('output').textContent = 'Unexpected admission'; };
          socket.onerror = () => { document.querySelector('output').textContent = 'Refused'; };
          socket.onmessage = () => { document.querySelector('output').textContent = 'Unexpected data'; };
        </script>`,
      }));
      try {
        await attacker.goto('http://untrusted.invalid/');
        await expect(attacker.locator('output')).toHaveText('Refused');
        await expect(page.locator('#document')).toHaveText(original);
        const before = Number(await page.locator('#updates').innerText());
        await page.locator('#write').click();
        await expect(page.locator('#result')).toHaveText('Written');
        await expect(page.locator('#updates')).toHaveText(String(before + 1));
      } finally { await attacker.close(); }
    } finally {
      await page.close();
      await server.stop();
      project.close();
    }
  });
}

test('an installed host refuses another host\'s resume grant and preserves the valid grant', async () => {
  const first = packedProject();
  const second = packedProject();
  const firstServer = startPackedServer(first, 'hosted');
  const secondServer = startPackedServer(second, 'hosted');
  try {
    const firstUrl = await firstServer.url;
    const secondUrl = await secondServer.url;
    const original = await admission(firstUrl);
    const destination = await admission(secondUrl);
    const lacksOriginal = original.kind !== 'attached';
    const lacksDestination = destination.kind !== 'attached';
    if (lacksOriginal) throw new Error('First host did not admit a valid local client');
    if (lacksDestination) throw new Error('Second host did not admit a valid local client');
    const foreign = await admission(secondUrl, {
      resumeToken: original.frame.resumeToken, hostInstanceId: destination.frame.hostInstanceId,
    });
    expect(foreign).toEqual({ kind: 'closed', code: 1008 });
    // A changed host identity deliberately requests fresh admission, never a resume.
    const fresh = await admission(secondUrl, {
      resumeToken: original.frame.resumeToken, hostInstanceId: original.frame.hostInstanceId,
    });
    const lacksFreshAdmission = fresh.kind !== 'attached';
    if (lacksFreshAdmission) throw new Error('Changed-host recovery did not receive fresh admission');
    expect(fresh.frame.resumeToken).not.toBe(original.frame.resumeToken);
    expect(fresh.frame.clientSessionId).not.toBe(original.frame.clientSessionId);
    const resumed = await admission(firstUrl, {
      resumeToken: original.frame.resumeToken, hostInstanceId: original.frame.hostInstanceId,
    });
    expect(resumed).toMatchObject({ kind: 'attached', frame: {
      resumeToken: original.frame.resumeToken, clientSessionId: original.frame.clientSessionId,
    } });
  } finally {
    await firstServer.stop();
    await secondServer.stop();
    first.close();
    second.close();
  }
});
