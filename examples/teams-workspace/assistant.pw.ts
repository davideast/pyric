import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, test, type Page } from '@playwright/test';

interface RecordedCompletionRequest {
  readonly model?: string;
  readonly stream?: boolean;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startOpenAiStub(port: number) {
  const requests: RecordedCompletionRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const isCompletions = req.method === 'POST' && req.url === '/v1/chat/completions';
    if (!isCompletions) {
      res.writeHead(404);
      res.end();
      return;
    }
    const raw = await readRequestBody(req);
    const parsed = JSON.parse(raw) as RecordedCompletionRequest;
    requests.push(parsed);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const firstChunk = JSON.stringify({
      id: 'chatcmpl-orbit-1',
      model: 'ornith:9b',
      choices: [{ index: 0, delta: { content: 'Orbit summary: ' }, finish_reason: null }],
    });
    const secondChunk = JSON.stringify({
      id: 'chatcmpl-orbit-1',
      model: 'ornith:9b',
      choices: [{ index: 0, delta: { content: 'design review is ready.' }, finish_reason: null }],
    });
    const stopChunk = JSON.stringify({
      id: 'chatcmpl-orbit-1',
      model: 'ornith:9b',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write(`data: ${firstChunk}\n\n`);
    res.write(`data: ${secondChunk}\n\n`);
    res.write(`data: ${stopChunk}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function signInAndOpenAssistant(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('alice@orbit.example');
  await page.getByLabel('Password', { exact: true }).fill('orbit-demo');
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'AI assistant', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Orbit assistant', exact: true })).toBeVisible();
}

test('assistant streams an answer with App Check initialized before getAI', async ({ page }) => {
  const upstream = await startOpenAiStub(53918);
  const appCheckWarnings: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    const isRefusalWarning =
      message.type() === 'warning' && text.includes('[pyric/ai]') && text.includes('App Check');
    if (isRefusalWarning) appCheckWarnings.push(text);
  });
  try {
    await signInAndOpenAssistant(page);
    await page.getByLabel('Ask Orbit', { exact: true }).fill('Summarize the latest design discussion.');
    await page.getByRole('button', { name: 'Send question', exact: true }).click();
    await expect(
      page.locator('.assistant-answer').filter({ hasText: 'Orbit summary: design review is ready.' }),
    ).toBeVisible();
    await expect(page.locator('.assistant-error')).toHaveCount(0);
    expect(appCheckWarnings).toEqual([]);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.model).toBe('ornith:9b');
    expect(upstream.requests[0]?.stream).toBe(true);
  } finally {
    await upstream.close();
  }
});
