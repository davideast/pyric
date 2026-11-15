// Verifies two entry-point guarantees:
// 1. A Vite middleware serving hand-written HTML without `server.transformIndexHtml`
//    initializes cleanly in hosted mode via the plugin's bundled worker-init define
//    (without inlining the project directory path), and throws a clear guidance error
//    naming the remedies in in-page mode.
// 2. Opening a hosted page from a non-loopback address on both the Vite and CLI planes
//    shows the loopback-only refusal explanation once with zero SharedWorker or
//    WebSocket errors and without leaking session tokens or project paths.
//
// In an offline network namespace, add a non-loopback IPv4 address first:
// `ip addr add 10.203.0.1/32 dev lo`.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { scenario, sleep, type App, type AppProcess, type ExpectedCrash } from '../driver.ts';
import { get, nonLoopbackAddress } from '../peer-client.ts';

export const expectedCrashes: readonly ExpectedCrash[] = [
  {
    message: /Missing Pyric page initialization.*transformIndexHtml/,
    source: /\/custom-html/,
    reason: 'in-page Vite mode intentionally throws the missing-init guidance error when HTML bypasses transformIndexHtml',
  },
];

const EXPLANATION = /only to clients on its own machine/;

async function waitForServer(port: number, running: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    assert.ok(running(), `${label} exited before serving /__pyric/init.json`);
    try {
      const answer = await get({ address: '127.0.0.1', port, path: '/__pyric/init.json', host: `localhost:${port}` });
      if (answer.status === 200) return;
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < deadline, `${label} did not answer /__pyric/init.json within 60s`);
    await sleep(250);
  }
}

interface RemotePageCheck {
  out: string;
  stampedHosted: unknown;
  chipText: string;
  consoleLines: string[];
  pageErrors: string[];
}

function assertRedactedRemoteHtml(label: string, body: string): void {
  const initMatch = /globalThis\.__PYRIC_WORKER_INIT__=(\{[\s\S]*?\});<\/script>/.exec(body);
  assert.ok(initMatch !== null && initMatch[1] !== undefined, `${label}: remote HTML must stamp __PYRIC_WORKER_INIT__`);
  const stampedInit = JSON.parse(initMatch[1]) as Record<string, unknown>;
  assert.equal(stampedInit.hosted, true, `${label}: remote HTML must declare hosted: true`);
  assert.equal(stampedInit.projectKey, null, `${label}: remote HTML must not stamp projectKey`);
  assert.equal(stampedInit.bridgeUrl, null, `${label}: remote HTML must not stamp bridgeUrl`);
  assert.equal(stampedInit.sessionToken, undefined, `${label}: remote HTML must not stamp sessionToken`);
  assert.equal(stampedInit.instanceId, undefined, `${label}: remote HTML must not stamp instanceId`);
  assert.ok(body.includes('<meta name="pyric-sandbox-host" content="node" data-pyric-serve>'), `${label}: remote HTML must declare Node host meta without projectKey`);
  assert.ok(!body.includes('"sessionToken"'), `${label}: remote HTML must not stamp sessionToken`);
  assert.ok(!body.includes('data-project-key='), `${label}: remote HTML must not stamp data-project-key`);
}

async function openRemotePage(
  app: App,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
): Promise<RemotePageCheck> {
  const page = await browser.newPage();
  await app.watchCrashes(page.context());
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => 'pageDone' in window, undefined, { timeout: 20_000 });
    await page.waitForTimeout(300);
    const out = (await page.locator('#out').textContent()) ?? '';
    const stampedHosted = await page.evaluate(
      () => (globalThis as { __PYRIC_WORKER_INIT__?: { hosted?: unknown } }).__PYRIC_WORKER_INIT__?.hosted,
    );
    const chipText = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .map((element) => element.shadowRoot)
        .filter((root): root is ShadowRoot => root !== null)
        .map((root) => root.innerHTML.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
        .join(' '),
    );
    return { out, stampedHosted, chipText, consoleLines, pageErrors };
  } finally {
    await page.close();
  }
}

function assertCleanRemoteRefusal(
  label: string,
  result: RemotePageCheck,
  options: { expectRuntimeChip: boolean },
): void {
  assert.equal(result.stampedHosted, true, `${label}: expected hosted: true stamp, got ${String(result.stampedHosted)}`);
  const combined = [...result.consoleLines, ...result.pageErrors, result.chipText].join('\n');
  assert.match(result.out, /^error .*only to clients on its own machine/, `${label}: unexpected #out: ${result.out}`);
  const initFailureLogs = result.consoleLines.filter((line) => line.includes('[pyric sandbox] init payload unavailable:'));
  assert.equal(initFailureLogs.length, 1, `${label}: expected exactly 1 refusal console log, saw ${initFailureLogs.length}:\n${result.consoleLines.join('\n')}`);
  assert.match(initFailureLogs[0] ?? '', EXPLANATION, `${label}: refusal explanation missing from console log:\n${initFailureLogs[0] ?? ''}`);
  assert.ok(!/Uncaught Error in snapshot listener/i.test(combined), `${label}: unexpected Firestore listener log:\n${combined}`);
  assert.ok(!/WebSocket connection/i.test(combined), `${label}: unexpected WebSocket attempt:\n${combined}`);
  assert.ok(!/SharedWorker/i.test(combined), `${label}: unexpected SharedWorker reference:\n${combined}`);
  if (options.expectRuntimeChip) {
    assert.match(result.chipText, /\b1 runtime error\b/i, `${label}: expected single runtime chip error, saw: ${result.chipText}`);
  }
  assert.deepEqual(result.pageErrors, [], `${label}: unexpected uncaught page errors: ${result.pageErrors.join('; ')}`);
}

export default scenario(async (app) => {
  const remote = nonLoopbackAddress();
  assert.ok(remote !== null, 'this machine has no IPv4 address outside 127.0.0.0/8; add one, for example `ip addr add 10.203.0.1/32 dev lo`');

  const hostedVitePort = await app.freePort();
  let hostedVite: AppProcess | undefined;
  await app.step('hosted Vite dev server starts on all interfaces', async () => {
    const child = app.commandProcess(
      'node',
      [join(app.dir, 'node_modules/vite/bin/vite.js'), '--host', '0.0.0.0', '--port', String(hostedVitePort), '--strictPort'],
      { env: { SCENARIO_HOSTED: '1', SCENARIO_HOST: '0.0.0.0', SCENARIO_ALLOWED_HOST: remote } },
    );
    hostedVite = child;
    await waitForServer(hostedVitePort, () => child.running, 'hosted vite');
  });

  await app.step('hosted Vite initializes hand-written HTML bypassing transformIndexHtml without leaking project path', async () => {
    const rawHtml = await get({
      address: '127.0.0.1',
      port: hostedVitePort,
      path: '/custom-html',
      host: `127.0.0.1:${hostedVitePort}`,
    });
    assert.equal(rawHtml.status, 200, rawHtml.body);
    assert.ok(!rawHtml.body.includes('__PYRIC_WORKER_INIT__'), 'expected /custom-html to bypass transformIndexHtml');

    const page = await app.page(`http://127.0.0.1:${hostedVitePort}/custom-html`);
    await page.waitForFunction(() => 'pageDone' in window, undefined, { timeout: 20_000 });
    const text = (await page.locator('#out').textContent()) ?? '';
    assert.equal(text, 'wrote {"value":1}', `custom HTML page failed to initialize in hosted mode: ${text}`);
    const initSnapshot = await page.evaluate(() => (globalThis as { __PYRIC_WORKER_INIT__?: Record<string, unknown> }).__PYRIC_WORKER_INIT__);
    assert.equal(initSnapshot?.hosted, true);
    assert.equal(initSnapshot?.projectKey, null, 'bundled define fallback must not inline the project directory path');
  });

  await app.step('hosted Vite refuses non-loopback peer clearly on both standard and custom HTML without leaking secrets or project path', async () => {
    const remoteHtml = await get({
      address: remote,
      port: hostedVitePort,
      path: '/',
      host: `${remote}:${hostedVitePort}`,
      localAddress: remote,
    });
    assert.equal(remoteHtml.status, 200, remoteHtml.body);
    assertRedactedRemoteHtml('vite', remoteHtml.body);

    const browser = await chromium.launch({
      headless: true,
      args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ${remote}`],
    });
    try {
      const standardResult = await openRemotePage(app, browser, `http://${remote}:${hostedVitePort}/`);
      assertCleanRemoteRefusal('vite standard page', standardResult, { expectRuntimeChip: true });

      const customResult = await openRemotePage(app, browser, `http://${remote}:${hostedVitePort}/custom-html`);
      assertCleanRemoteRefusal('vite custom-html page', customResult, { expectRuntimeChip: false });
    } finally {
      await browser.close();
    }
  });

  await app.step('hosted Vite stops', async () => {
    await hostedVite?.stop();
  });

  await app.step('in-page Vite throws the improved missing-init guidance error when HTML bypasses transformIndexHtml', async () => {
    const inPageVite = await app.devServer({ env: { SCENARIO_HOSTED: '0' }, name: 'in-page vite' });
    const pageErrors: string[] = [];
    const page = await (await app.browser()).newPage();
    try {
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`${inPageVite.url}/custom-html`, { waitUntil: 'load' });
      await page.waitForTimeout(1_500);
      const missing = pageErrors.find((message) => message.includes('Missing Pyric page initialization'));
      assert.ok(missing !== undefined, `expected Missing Pyric page initialization error, saw: ${pageErrors.join(' | ')}`);
      assert.match(missing, /transformIndexHtml/, missing);
      assert.match(missing, /hosted:\s*true/, missing);
      assert.match(missing, /NEXT_PUBLIC_PYRIC_WORKER_INIT/, missing);
    } finally {
      await page.close();
      await inPageVite.process.stop();
    }
  });

  const cliPort = await app.freePort();
  let cliHost: AppProcess | undefined;
  await app.step('hosted CLI server refuses non-loopback peer with the same explanation and zero SharedWorker or WebSocket errors', async () => {
    const child = app.pyricProcess([
      'sandbox',
      '--hosted',
      '--no-open',
      '--host',
      '0.0.0.0',
      '--allowed-host',
      remote,
      '--port',
      String(cliPort),
    ]);
    cliHost = child;
    await waitForServer(cliPort, () => child.running, 'hosted cli');

    const localPage = await app.page(`http://127.0.0.1:${cliPort}/`);
    await localPage.waitForFunction(() => 'pageDone' in window, undefined, { timeout: 20_000 });
    assert.equal((await localPage.locator('#out').textContent()) ?? '', 'wrote {"value":1}');

    const cliRemoteHtml = await get({
      address: remote,
      port: cliPort,
      path: '/',
      host: `${remote}:${cliPort}`,
      localAddress: remote,
    });
    assert.equal(cliRemoteHtml.status, 200, cliRemoteHtml.body);
    assertRedactedRemoteHtml('cli', cliRemoteHtml.body);

    const browser = await chromium.launch({
      headless: true,
      args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ${remote}`],
    });
    try {
      const cliRemote = await openRemotePage(app, browser, `http://${remote}:${cliPort}/`);
      assertCleanRemoteRefusal('cli hosted page', cliRemote, { expectRuntimeChip: true });
    } finally {
      await browser.close();
    }
    await cliHost.stop();
  });
});
