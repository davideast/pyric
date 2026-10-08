import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

// An OpenAI-compatible upstream that answers every call as its own model.
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const model = (JSON.parse(body) as { model?: string }).model;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'chatcmpl-1',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
  });
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

const directory = process.argv[2];
const notes: string[] = [];
const logger = { info: () => {}, note: (line: string) => { notes.push(line); } };
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory };
let reply: (response: OutboundMessage) => void = () => {};
function receive(frame: BridgeMessage) {
  if (frame.type === 'worker-message-result') reply(frame.message);
}
const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', receive, directory, { logger });
async function request(message: InboundMessage) {
  return await new Promise<OutboundMessage>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 5000);
    reply = (response) => {
      if (response.t !== 'res') return;
      clearTimeout(deadline);
      resolve(response);
    };
    runtime.receive({ type: 'worker-message', clientSessionId: 'test', message });
  });
}
try {
  for (let i = 0; i < 3; i += 1) {
    const response = await request({
      t: 'op', id: `ai-${i}`, method: 'ai.generateContent', model: 'models/gemini-2.5-pro',
      request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      engine: { kind: 'openai', baseUrl: upstreamUrl, model: 'llama3' },
    } as InboundMessage);
    assert.equal(response.t === 'res' && response.ok, true);
  }
} finally {
  await runtime.close();
  upstream.close();
}
const substitutions = notes.filter((line) => line.includes('ai model substituted'));
assert.deepEqual(substitutions, ['  ⚠ [pyric] ai model substituted: models/gemini-2.5-pro → llama3 (openai, engine catch-all model)']);
console.log('Hosted AI diagnostics passed');
