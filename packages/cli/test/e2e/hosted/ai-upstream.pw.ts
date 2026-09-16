import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InitPayload } from '../../../src/serve/init-payload.js';

const request = { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };

async function withUpstream(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handle);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('Upstream did not listen.');
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function payload(project: string): InitPayload {
  return {
    rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
    bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: project,
    ai: { engine: { kind: 'openai', baseUrl: '/__pyric/ai-proxy', model: 'host-model' } },
  };
}

test('Node AI reaches the upstream without an HTTP frontend and uses the host model', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-ai-upstream-'));
  const previousUpstream = process.env.PYRIC_AI_PROXY_UPSTREAM;
  const requests: Array<{ path: string | undefined; model: string }> = [];
  let runtime: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  try {
    await withUpstream(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, model: JSON.parse(body).model });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'answer', model: 'host-model', choices: [
        { index: 0, message: { role: 'assistant', content: 'Direct answer' }, finish_reason: 'stop' },
      ] }));
    }, async baseUrl => {
      process.env.PYRIC_AI_PROXY_UPSTREAM = baseUrl;
      const replies: BridgeMessage[] = [];
      runtime = await createHostedRuntime(payload(project), () => {
        throw new Error('AI must not resolve the frontend origin.');
      }, message => replies.push(message), project);
      runtime.receive({ type: 'worker-message', clientSessionId: 'ai', message: {
        t: 'op', id: 'answer', method: 'ai.generateContent', model: 'gemini-2.5-flash', request,
        engine: { kind: 'openai', model: 'client-model' },
      } });
      await expect.poll(() => replies).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'worker-message-result', message: expect.objectContaining({
          id: 'answer', ok: true, value: expect.objectContaining({ candidates: expect.arrayContaining([
            expect.objectContaining({ content: expect.objectContaining({ parts: [expect.objectContaining({ text: 'Direct answer' })] }) }),
          ]) }),
        }) }),
      ]));
      expect(requests).toEqual([{ path: '/v1/chat/completions', model: 'host-model' }]);
    });
  } finally {
    await runtime?.close();
    if (previousUpstream === undefined) delete process.env.PYRIC_AI_PROXY_UPSTREAM;
    else process.env.PYRIC_AI_PROXY_UPSTREAM = previousUpstream;
    rmSync(project, { recursive: true, force: true });
  }
});

for (const endpoint of ['proxy option', 'explicit engine URL'] as const) {
  test(`Node AI streams directly through the ${endpoint}`, async () => {
    const project = mkdtempSync(join(tmpdir(), 'pyric-ai-stream-'));
    let finishStream: (() => void) | undefined;
    let runtime: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
    try {
      await withUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'stream', model: 'host-model', choices: [
          { index: 0, delta: { content: 'First' }, finish_reason: null },
        ] })}\n\n`);
        finishStream = () => res.end(`data: ${JSON.stringify({ id: 'stream', model: 'host-model', choices: [
          { index: 0, delta: { content: ' last' }, finish_reason: 'stop' },
        ] })}\n\ndata: [DONE]\n\n`);
      }, async baseUrl => {
        const init = payload(project);
        const usesExplicitUrl = endpoint === 'explicit engine URL';
        if (usesExplicitUrl) init.ai = { engine: { kind: 'openai', baseUrl, model: 'host-model' } };
        const replies: BridgeMessage[] = [];
        runtime = await createHostedRuntime(init, 'http://127.0.0.1:1', message => replies.push(message), project, {
          proxyUpstream: usesExplicitUrl ? 'http://127.0.0.1:1/wrong-upstream' : baseUrl,
        });
        runtime.receive({ type: 'worker-message', clientSessionId: 'ai', message: {
          t: 'sub', subId: 'stream', target: { service: 'ai', op: 'streamGenerateContent' },
          model: 'gemini-2.5-flash', request,
        } });
        await expect.poll(() => JSON.stringify(replies)).toContain('First');
        expect(JSON.stringify(replies)).not.toContain('"done":true');
        finishStream?.();
        await expect.poll(() => JSON.stringify(replies)).toContain('"done":true');
        expect(JSON.stringify(replies)).toContain(' last');
        expect(JSON.stringify(replies)).not.toContain('__error');
      });
    } finally {
      finishStream?.();
      await runtime?.close();
      rmSync(project, { recursive: true, force: true });
    }
  });
}

test('direct Node upstream failures reach the caller and terminal diagnostics', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-ai-failure-'));
  let runtime: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  try {
    await withUpstream((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify({ error: { message: 'Quota exhausted' } }));
    }, async baseUrl => {
      const replies: BridgeMessage[] = [];
      const notes: string[] = [];
      runtime = await createHostedRuntime(payload(project), 'http://127.0.0.1:1', message => replies.push(message), project, {
        proxyUpstream: baseUrl,
        logger: { info: () => {}, note: message => notes.push(message) },
      });
      runtime.receive({ type: 'worker-message', clientSessionId: 'ai', message: {
        t: 'op', id: 'failure', method: 'ai.generateContent', model: 'gemini-2.5-flash', request,
      } });
      await expect.poll(() => replies).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'worker-message-result', message: expect.objectContaining({ id: 'failure', ok: false }) }),
      ]));
      expect(JSON.stringify(replies)).toContain('429');
      expect(notes.join('\n')).toContain('429');
      expect(notes.join('\n')).toContain('Retry-After: 7');
    });
  } finally {
    await runtime?.close();
    rmSync(project, { recursive: true, force: true });
  }
});
