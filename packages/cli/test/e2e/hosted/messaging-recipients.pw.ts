import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { startSoakServe, CLI_PATH } from '../soak/harness.js';

for (const mode of ['hosted', 'shared-worker'] as const) {
  test(`${mode}: Messaging tokens survive reloads and stay separate across browser profiles`, async ({ browser }) => {
    const fixture = await startSoakServe({ flags: mode === 'hosted' ? ['--hosted', '--no-capture'] : ['--no-capture'] });
    const alice = await browser.newContext();
    const david = await browser.newContext();
    try {
      const page = await alice.newPage();
      const other = await david.newPage();
      await page.goto(fixture.info.url);
      await other.goto(fixture.info.url);
      const token = async (target: typeof page) => target.evaluate(async () => {
        const app = await import('firebase/app');
        const sdk = await import('firebase/messaging');
        const instance = sdk.getMessaging(app.getApp());
        return sdk.getToken(instance);
      });
      const sibling = await alice.newPage();
      await sibling.goto(fixture.info.url);
      const [aliceToken, siblingToken, davidToken] = await Promise.all([token(page), token(sibling), token(other)]);
      expect(davidToken).not.toBe(aliceToken);
      expect(siblingToken).toBe(aliceToken);
      await page.reload();
      expect(await token(page)).toBe(aliceToken);
    } finally {
      await alice.close();
      await david.close();
      await fixture.stop();
    }
  });
}

test('hosted: existing Messaging observers and tokens survive a host restart', async ({ browser }) => {
  const { connectRemoteSandbox } = await import('@pyric/cli/remote');
  const { startHost } = await import('./host-process.js');
  const fixture = await startSoakServe({ flags: ['--hosted', '--no-capture'] });
  const page = await browser.newPage();
  try {
    await page.goto(fixture.info.url);
    const token = await page.evaluate(async () => {
      const sdk = await import('firebase/messaging');
      const messaging = sdk.getMessaging();
      sdk.onMessage(messaging, payload => {
        const entry = document.createElement('p');
        entry.className = 'received';
        entry.textContent = payload.data?.message ?? '';
        document.body.append(entry);
      });
      return sdk.getToken(messaging);
    });
    const before = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await before.channel.op({ method: 'messaging.subscribeToTopic', tokens: [token], topic: 'orbit' });
      await before.channel.op({ method: 'messaging.send', message: { topic: 'orbit', data: { message: 'Before restart' } } });
      await expect(page.locator('.received')).toHaveText(['Before restart']);
    } finally { before.close(); }
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      await expect.poll(() => page.evaluate(async () => {
        const sdk = await import('firebase/messaging');
        try { return await sdk.getToken(sdk.getMessaging()); }
        catch { return 'reconnecting'; }
      })).toBe(token);
      const after = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await after.channel.op({ method: 'messaging.send', message: { topic: 'orbit', data: { message: 'After restart' } } });
        await expect(page.locator('.received')).toHaveText(['Before restart', 'After restart']);
      } finally { after.close(); }
    } finally { await replacement.stop(); }
  } finally {
    await page.close();
    await fixture.stop();
  }
});

for (const mode of ['hosted', 'shared-worker'] as const) {
  test(`${mode}: sends only to the intended page or its real background Service Worker`, async ({ browser }) => {
    const { readFileSync } = await import('node:fs');
    const { connectRemoteSandbox } = await import('@pyric/cli/remote');
    const fixture = await startSoakServe({
      flags: mode === 'hosted' ? ['--hosted', '--no-capture'] : ['--no-capture'],
      extraFiles: {
        'messaging-service-worker.js': readFileSync(new URL('../fixture/messaging-service-worker.js', import.meta.url), 'utf8'),
      },
    });
    const alice = await browser.newContext({ permissions: ['notifications'] });
    const david = mode === 'hosted' ? await browser.newContext() : alice;
    const mcp = new Client({ name: 'messaging-evidence-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI_PATH, 'mcp'], cwd: fixture.dir, stderr: 'pipe' });
    try {
      const page = await alice.newPage();
      const other = await david.newPage();
      await page.goto(fixture.info.url);
      await other.goto(fixture.info.url);
      const token = await page.evaluate(async () => {
        const sdk = await import('firebase/messaging');
        const registration = await navigator.serviceWorker.register('/messaging-service-worker.js', { type: 'module', scope: '/' });
        await navigator.serviceWorker.ready;
        navigator.serviceWorker.addEventListener('message', event => {
          if (event.data?.type !== 'pyric-background-message') return;
          const entry = document.createElement('p');
          entry.className = 'background';
          entry.textContent = event.data.payload.data.message;
          document.body.append(entry);
        });
        const messaging = sdk.getMessaging();
        sdk.onMessage(messaging, payload => {
          const entry = document.createElement('p');
          entry.className = 'foreground';
          entry.textContent = payload.data?.message ?? '';
          document.body.append(entry);
        });
        return sdk.getToken(messaging, { serviceWorkerRegistration: registration });
      });
      await other.evaluate(async hostMode => {
        const app = await import('firebase/app');
        const sdk = await import('firebase/messaging');
        const target = hostMode === 'hosted' ? app.getApp() : app.initializeApp(app.getApp().options, 'david');
        const messaging = sdk.getMessaging(target);
        sdk.onMessage(messaging, () => { document.body.dataset.unexpectedDelivery = 'yes'; });
        await sdk.getToken(messaging);
      }, mode);
      const remote = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await remote.channel.op({ method: 'messaging.send', message: { token, data: { message: 'Foreground' } } });
        await expect(page.locator('.foreground')).toHaveText(['Foreground']);
        await expect(other.locator('body')).not.toHaveAttribute('data-unexpected-delivery');
        await page.evaluate(async () => {
          // The browser owns visibility; exercise the SDK's visibilitychange boundary deterministically.
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          const sdk = await import('firebase/messaging');
          const registration = await navigator.serviceWorker.getRegistration('/');
          await sdk.getToken(sdk.getMessaging(), { serviceWorkerRegistration: registration });
        });
        await remote.channel.op({ method: 'messaging.send', message: { token, data: { message: 'Background' } } });
        await expect(page.locator('.background')).toHaveText(['Background']);
        await mcp.connect(transport);
        const deliveries = async () => {
          const result = await mcp.callTool({ name: 'messaging_deliveries', arguments: {} });
          expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
          const content = result.content as Array<{ type: string; text: string }>;
          const body = JSON.parse(content[0]?.text ?? '{}');
          return body.data.deliveries as Array<{ receipt: string; payload: { data?: { message?: string } }; acknowledgments: Array<{ stage: string }> }>;

        };
        await expect.poll(async () => (await deliveries()).find(entry => entry.payload.data?.message === 'Background'))
          .toMatchObject({ receipt: 'received', acknowledgments: expect.arrayContaining([
            expect.objectContaining({ stage: 'received' }), expect.objectContaining({ stage: 'handler-completed' }),
          ]) });
        await remote.channel.op({ method: 'messaging.send', message: { token, notification: { title: 'Denied display' }, data: { message: 'Rejected display' } } });
        await expect.poll(async () => (await deliveries()).find(entry => entry.payload.data?.message === 'Rejected display'))
          .toMatchObject({ receipt: 'received', acknowledgments: expect.arrayContaining([
            expect.objectContaining({ stage: 'display-requested' }), expect.objectContaining({ stage: 'display-rejected' }),
            expect.objectContaining({ stage: 'handler-rejected' }),
          ]) });
        const hosted = mode === 'hosted';
        if (hosted) {
          const { stdout } = await promisify(execFile)(process.execPath, [CLI_PATH, 'messaging', 'deliveries', '--json'], { cwd: fixture.dir });
          const result = JSON.parse(stdout);
          expect(result.data.deliveries).toEqual(expect.arrayContaining([
            expect.objectContaining({ receipt: 'received', acknowledgments: expect.arrayContaining([
              expect.objectContaining({ stage: 'display-rejected' }),
            ]) }),
          ]));
        }
        await expect(page.locator('.foreground')).toHaveText(['Foreground']);
        await expect(other.locator('body')).not.toHaveAttribute('data-unexpected-delivery');
      } finally { remote.close(); }
    } finally {
      await mcp.close();
      await transport.close();
      if (david !== alice) await david.close();
      await alice.close();
      await fixture.stop();
    }
  });
}

test('hosted: getToken retains an explicitly selected Service Worker registration', async ({ browser }) => {
  const fixture = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: { 'registration-worker.js': "self.addEventListener('install', () => self.skipWaiting());" },
  });
  const page = await browser.newPage();
  try {
    await page.goto(fixture.info.url);
    const tokens = await page.evaluate(async () => {
      const sdk = await import('firebase/messaging');
      const messaging = sdk.getMessaging();
      const defaultToken = await sdk.getToken(messaging);
      const registration = await navigator.serviceWorker.register('/registration-worker.js', { scope: '/notifications/' });
      const selected = await sdk.getToken(messaging, { serviceWorkerRegistration: registration });
      const repeated = await sdk.getToken(messaging);
      await sdk.deleteToken(messaging);
      const renewed = await sdk.getToken(messaging);
      return { defaultToken, selected, repeated, renewed };
    });
    expect(tokens.selected).not.toBe(tokens.defaultToken);
    expect(tokens.repeated).toBe(tokens.selected);
    expect(tokens.renewed).not.toBe(tokens.selected);
    expect(tokens.renewed).not.toBe(tokens.defaultToken);
  } finally {
    await page.close();
    await fixture.stop();
  }
});
