import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../../dist/vite.js';

for (const hosted of [true, false]) {
  const mode = hosted ? 'Node host' : 'SharedWorker';
  test(`${mode} uses the configured AI upstream for browser responses and streams`, async ({ page }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-ai-upstream-')));
    const requests: Array<{ model: string; stream: boolean }> = [];
    let proxyRequests = 0;
    let server: ViteDevServer | undefined;
    const upstream = createHttpServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      requests.push({ model: input.model, stream: input.stream });
      const streams = input.stream === true;
      if (streams) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const content of ['Streaming ', 'answer']) {
          res.write(`data: ${JSON.stringify({ id: 'stream', model: 'configured-model', choices: [
            { index: 0, delta: { content }, finish_reason: null },
          ] })}\n\n`);
        }
        res.end(`data: ${JSON.stringify({ id: 'stream', model: 'configured-model', choices: [
          { index: 0, delta: {}, finish_reason: 'stop' },
        ] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'answer', model: 'configured-model', choices: [
          { index: 0, message: { role: 'assistant', content: 'Generated answer' }, finish_reason: 'stop' },
        ] }));
      }
    });
    try {
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('Upstream did not listen.');
      const proxyUpstream = `http://127.0.0.1:${address.port}/v1`;
      writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body><output id="unary">Starting</output><output id="stream">Starting</output><script type="module" src="/main.js"></script></body></html>');
      writeFileSync(join(root, 'main.js'), `
        import { initializeApp } from 'firebase/app';
        import { getAI, getGenerativeModel } from 'firebase/ai';
        const app = initializeApp({ apiKey: 'demo', projectId: 'ai-upstream-test' });
        const model = getGenerativeModel(getAI(app), { model: 'gemini-2.5-flash' });
        try {
          const result = await model.generateContent('Hello');
          document.querySelector('#unary').textContent = result.response.text();
          const streamed = await model.generateContentStream('Hello');
          document.querySelector('#stream').textContent = '';
          for await (const chunk of streamed.stream) {
            document.querySelector('#stream').textContent += chunk.text();
          }
        } catch (error) {
          document.querySelector('#stream').textContent = error.message;
        }
      `);
      server = await createServer({
        root, configFile: false, logLevel: 'silent',
        plugins: [
          pyric({ hosted, ui: false, capture: false, ai: { model: 'configured-model', proxyUpstream } }),
        ],
        server: { host: '127.0.0.1', port: 0 },
      });
      server.httpServer?.prependListener('request', req => {
        const isProxyRequest = req.url?.startsWith('/__pyric/ai-proxy/') === true;
        if (isProxyRequest) proxyRequests += 1;
      });
      await server.listen();
      const url = server.resolvedUrls?.local[0];
      if (url === undefined) throw new Error('Vite did not listen.');
      const init = await fetch(`${url}__pyric/init.json`).then(response => response.text());
      expect(init).not.toContain(proxyUpstream);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await expect(page.locator('#unary')).toHaveText('Generated answer');
      await expect(page.locator('#stream')).toHaveText('Streaming answer');
      expect(requests).toEqual([
        { model: 'configured-model', stream: false },
        { model: 'configured-model', stream: true },
      ]);
      expect(proxyRequests).toBe(hosted ? 0 : 2);
      await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
      await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
      await page.getByLabel('Request service').selectOption('ai');
      await expect(page.locator('[data-inspect-request]')).toHaveCount(2);
      await page.getByLabel('Request service').selectOption('firestore');
      await page.getByRole('tab', { name: 'Sandbox', exact: true }).click();
      await expect(page.locator('[data-ai-requested-row]')).toContainText('gemini-2.5-flash');
      await expect(page.locator('[data-ai-route-row]')).toContainText('configured-model');
      await expect(page.locator('[data-ai-row]')).not.toContainText('OpenAI-compatible');

      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await server?.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
