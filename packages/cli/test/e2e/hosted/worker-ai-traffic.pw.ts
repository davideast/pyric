import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../../dist/vite.js';

test('independent worker AI is inspectable live, after noise, and in a late Studio', async ({ page, context }) => {
  test.setTimeout(45_000);
  context.setDefaultTimeout(10_000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-worker-traffic-')));
  let server: ViteDevServer | undefined;
  let finishStream: (() => void) | undefined;
  const upstream = createHttpServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the synthetic request. */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (text: string) => `data: ${JSON.stringify({ model: 'synthetic-worker', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
    response.write(chunk('Synthetic '));
    finishStream = () => {
      if (!response.writableEnded) response.end(chunk('worker answer') + 'data: [DONE]\n\n');
    };
  });
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing test upstream');
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body><button id="generate">Generate in worker</button><button id="noise">Create 70 requests</button><output id="status">Ready</output><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(root, 'main.js'), `
      import { initializeApp } from 'firebase/app';
      import { getFirestore, setDoc, doc } from 'firebase/firestore';
      const db = getFirestore(initializeApp({ projectId: 'synthetic', apiKey: 'demo' }));
      document.querySelector('#generate').onclick = () => {
        const generation = localStorage.getItem('pyric:worker-generation');
        const backend = new SharedWorker('/__pyric/sdk/worker.js', { type: 'classic', name: generation ? 'pyric-shared-worker:' + generation : 'pyric-shared-worker' });
        const producer = new Worker('/producer.js');
        producer.onmessage = () => { document.querySelector('#status').textContent = 'Completed'; producer.terminate(); };
        producer.postMessage(backend.port, [backend.port]);
      };
      document.querySelector('#noise').onclick = async () => {
        for (let index = 0; index < 70; index++) await setDoc(doc(db, 'noise/' + index), { synthetic: true });
        document.querySelector('#status').textContent = '70 requests created';
      };
    `);
    writeFileSync(join(root, 'producer.js'), `
      onmessage = ({ data: port }) => {
        port.onmessage = ({ data }) => {
          if (data.t === 'snap' && data.value.done) { port.close(); postMessage('done'); }
        };
        port.start();
        port.postMessage({ t: 'sub', subId: 'background', target: { service: 'ai', op: 'streamGenerateContent' },
          model: 'requested-worker', request: { contents: [{ role: 'user', parts: [{ text: 'Synthetic test only' }] }] } });
      };
    `);
    writeFileSync(join(root, 'firestore.rules'), "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /noise/{id} { allow read, write: if true; } } }");
    server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [pyric({ capture: false,
      ai: { model: 'synthetic-worker', proxyUpstream: `http://127.0.0.1:${address.port}/v1` } })],
      server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const url = server.resolvedUrls!.local[0]!;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    await page.locator('#generate').click();
    await expect(page.locator('[data-inspect-request]').filter({ hasText: 'In progress' })).toHaveCount(1);
    const runningStudio = await context.newPage();
    await runningStudio.goto(new URL('__pyric/ui/traffic/?service=ai', url).href);
    await expect(runningStudio.locator('[data-pyric-traffic-row]')).toContainText('In progress');
    await runningStudio.close();
    finishStream!();
    await expect(page.locator('#status')).toHaveText('Completed');
    await page.locator('#noise').click();
    await expect(page.locator('#status')).toHaveText('70 requests created');
    await expect(page.locator('[data-inspect-request]')).toHaveCount(25);
    await page.getByRole('button', { name: 'Load older' }).click();
    await expect(page.locator('[data-inspect-request]')).toHaveCount(50);
    const pinnedIds = await page.locator('[data-inspect-request]').evaluateAll(rows => rows.map(row => row.getAttribute('data-inspect-request')));
    await page.locator('#noise').click();
    await expect(page.getByRole('button', { name: /Resume live.*70 new/ })).toBeVisible();
    expect(await page.locator('[data-inspect-request]').evaluateAll(rows => rows.map(row => row.getAttribute('data-inspect-request')))).toEqual(pinnedIds);
    await page.getByLabel('Request service').selectOption('ai');
    await expect(page.locator('[data-inspect-request]')).toHaveCount(1);
    await page.locator('[data-inspect-request]').click();
    await page.locator('[data-request-response] summary').click();
    await expect(page.locator('[data-request-response] pre')).toHaveText('Synthetic worker answer');
    const studioHref = await page.getByRole('link', { name: 'Inspect in Studio' }).getAttribute('href');
    const studio = await context.newPage();
    studio.on('pageerror', error => errors.push(error.message));
    await studio.goto(new URL(studioHref!, url).href);
    await expect(studio.locator('[data-pyric-ui="traffic-request-inspector"]')).toContainText('Completed');
    await studio.getByText('Returned response', { exact: true }).click();
    await expect(studio.locator('[data-pyric-ui="traffic-request-inspector"] pre')).toHaveText('Synthetic worker answer');
    await expect(studio.locator('[data-pyric-ui="traffic-request-inspector"]')).not.toContainText('Security Rules');
    const aiRow = studio.locator('[data-pyric-traffic-row]').filter({ hasText: 'requested-worker' });
    await expect(aiRow).toContainText('Routed');
    await expect(aiRow).toContainText('synthetic-worker');
    const methodBadge = aiRow.locator('[data-pyric-badge-kind]');
    expect(await methodBadge.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

    await studio.getByLabel('Traffic service').selectOption('firestore');
    await expect(studio.locator('[data-pyric-ui="traffic-request-inspector"]')).toHaveCount(0);
    expect(new URL(studio.url()).searchParams.has('inspect')).toBe(false);
    await studio.getByLabel('Traffic service').selectOption('ai');
    await aiRow.click();

    await page.reload();
    await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    await page.getByLabel('Request service').selectOption('ai');
    await expect(page.locator('[data-inspect-request]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Rates', exact: true }).click();
    await expect(page.locator('[data-service-summary="ai"]')).toContainText('1 started / 1 completed');
    await page.locator('[data-inspect-rates="ai"]').click();
    await page.locator('[data-ai-requests] > summary').click();
    await expect(page.locator('[data-ai-request]')).toHaveCount(1);
    await page.locator('[data-rates-back]').click();
    await page.getByRole('button', { name: 'Requests', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/pyric-worker-traffic-mobile.png' });
    await studio.setViewportSize({ width: 390, height: 844 });
    await studio.locator('[data-pyric-ui="traffic-request-inspector"]').scrollIntoViewIfNeeded();
    await studio.screenshot({ path: '/tmp/pyric-studio-traffic-mobile.png' });
    const detailBounds = await studio.locator('[data-pyric-ui="traffic-request-inspector"]').boundingBox();
    expect(detailBounds!.width).toBeLessThanOrEqual(390);
    await studio.reload();
    await expect(studio.locator('[data-pyric-ui="traffic-request-inspector"]')).toContainText('Completed');
    await studio.getByRole('button', { name: 'Back to the log', exact: true }).click();
    await expect(studio.getByLabel('Traffic service')).toHaveValue('ai');
    await studio.getByLabel('Traffic service').selectOption('firestore');
    await studio.locator('[data-pyric-traffic-row]').first().click();
    await studio.getByText('Security Rules', { exact: true }).click();
    await expect(studio.locator('[data-pyric-ui="traffic-rules-inspector"]')).toBeVisible();
    await studio.goto(new URL('__pyric/ui/traffic/?inspect=expired-request', url).href);
    await expect(studio.locator('[data-pyric-ui="traffic-inspect-missing"]')).toContainText('unavailable');
    expect(errors).toEqual([]);
    await studio.close();
  } finally {
    finishStream?.();
    await page.close();
    await server?.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
