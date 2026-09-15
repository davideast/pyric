import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { packedProject, startPackedServer } from './section-four-fixture.js';
import { startHost } from './host-process.js';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

function publishedConsumer(): string {
  const consumer = realpathSync(z.string().parse(process.env.PYRIC_PUBLISHED_CONSUMER));
  const cli = realpathSync(join(consumer, 'node_modules/@pyric/cli'));
  expect(cli.startsWith(`${consumer}/node_modules/`)).toBe(true);
  return consumer;
}

for (const version of ['candidate', 'published alpha.19']) {
  test(`installed ${version} remote consumer interoperates with the candidate hosted browser`, async ({ page }) => {
    const project = packedProject();
    const host = startPackedServer(project, 'hosted');
    const studio = await page.context().newPage();
    const usesCandidate = version === 'candidate';
    const consumer = usesCandidate ? project.consumer : publishedConsumer();
    const runner = join(consumer, 'phase-six-remote-client.mjs');
    copyFileSync(new URL('../../manual/section-six/remote-client.mjs', import.meta.url), runner);
    try {
      const url = await host.url;
      await page.goto(url);
      await expect(page.locator('#result')).toHaveText('Ready');
      await studio.goto(`${url}/__pyric/ui/firestore`);
      await expect(studio.getByText('No collections yet. App or agent writes show up here.')).toBeVisible();
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [runner, url], { cwd: consumer, timeout: 15_000 });
      expect(stdout).toContain('Auth, write, reconnect and listener passed');
      await expect(page.locator('#document')).toContainText('Installed remote listener');
      await expect(studio.getByRole('button', { name: 'shared', exact: true })).toBeVisible();
      await page.locator('#write').click();
      await expect(page.locator('#result')).toHaveText('Written');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('hosted');
      await test.info().attach('version-warning', { body: stderr, contentType: 'text/plain' });
    } finally {
      rmSync(runner, { force: true });
      await studio.close();
      await page.close();
      await host.stop();
      project.close();
    }
  });
}

test('candidate browser refuses the actual published host without worker-port support before sending a write', async ({ page }) => {
  const project = packedProject();
  const host = startPackedServer(project, 'hosted');
  const published = publishedConsumer();
  const legacyDir = mkdtempSync(join(published, 'legacy-host-'));
  writeFileSync(join(legacyDir, 'index.html'), '<p>Published host</p>');
  const legacy = startHost(legacyDir, 0, [process.execPath, join(published, 'node_modules/@pyric/cli/dist/cli/index.js')], [], 'dev');
  let writesSent = 0;
  const candidateUrl = await host.url;
  try {
    expect(await legacy.startup, legacy.stderr()).toEqual({ kind: 'ready' });
    const line = legacy.stdout().split('\n').find(line => line.startsWith('{'));
    const ready = z.object({ url: z.string() }).parse(JSON.parse(z.string().parse(line)));
    await page.route('**/__pyric/init.json', async route => {
      const response = await route.fetch();
      const payload = z.record(z.string(), z.unknown()).parse(await response.json());
      await route.fulfill({ response, json: { ...payload, bridgeUrl: `${ready.url.replace('http:', 'ws:')}/__pyric/sandbox` } });
    });
    await page.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      route.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isWorkerFrame = isBridgeMessage(frame) && frame.type === 'worker-message';
        if (isWorkerFrame) {
          const isWrite = frame.message.t === 'op' && frame.message.method === 'setDoc';
          if (isWrite) writesSent += 1;
        }
        server.send(data);
      });
    });
    writeFileSync(join(project.dir, 'writer.html'), '<output id="result">Starting</output><script type="module" src="/writer.js"></script>');
    writeFileSync(join(project.dir, 'writer.js'), `
      import { initializeApp } from 'firebase/app';
      import { doc, getFirestore, setDoc } from 'firebase/firestore';
      initializeApp({ projectId: 'demo-packed' });
      try {
        await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'Must not execute' });
        document.querySelector('#result').textContent = 'Written';
      } catch (error) { document.querySelector('#result').textContent = error.message; }
    `);
    await page.goto(`${candidateUrl}/writer.html`);
    await expect(page.locator('#result')).toContainText('does not support browser worker ports');
    await expect(page.locator('#result')).toContainText('Upgrade');
    expect(writesSent).toBe(0);
    expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('hosted');
    await test.info().attach('published-host-stderr', { body: legacy.stderr(), contentType: 'text/plain' });
  } finally {
    await page.close();
    await legacy.stop();
    await host.stop();
    project.close();
    rmSync(legacyDir, { recursive: true, force: true });
  }
});
