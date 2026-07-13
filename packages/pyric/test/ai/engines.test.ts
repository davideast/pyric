/**
 * Red conformance suite: sandbox answer engine rows (ai#scripted-* and
 * ai#openai-*). One test per registry row id. The openai rows drive a local
 * OpenAI-compatible mock served by Bun.
 * RED BY DESIGN until the ai mirror lands (CDD map #92).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { aiSeam, observedBehavior, PROBE_MODEL, type AiSeam } from './support.ts';

const envelope = observedBehavior('ai-generate-minimal-envelope');
const framing = observedBehavior('ai-generate-stream-framing');

let seam: AiSeam;

function freshAi(entries?: any[]): { ai: any; model: any } {
  const sandbox = seam.sandboxMod.initializeSandbox();
  const ai = seam.ai.getAI(sandbox);
  if (entries) seam.scripting.script(ai, entries);
  const model = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
  return { ai, model };
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** Loads the seam inside the test so every row id reports its own red. */
function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    await fn();
  });
}

describe('ai: scripted engine', () => {
  rowTest('ai#scripted-zero-config no script yields a deterministic wire-true synthesized response', async () => {
    const { model } = freshAi();
    const result = await model.generateContent('Reply with exactly one word.');
    const response = result.response;
    for (const key of envelope.topLevelKeySet) expect(key in response).toBe(true);
    expect(response.candidates[0].finishReason).toBe(envelope.finishReason);
    expect(response.candidates[0].content.role).toBe(envelope.contentRole);
  });

  rowTest('ai#scripted-deterministic the same unscripted request twice yields an identical envelope', async () => {
    const { model } = freshAi();
    const request = 'Reply with exactly one word.';
    const first = await model.generateContent(request);
    const second = await model.generateContent(request);
    expect(second.response.candidates).toEqual(first.response.candidates);
    expect(second.response.usageMetadata).toEqual(first.response.usageMetadata);
    expect(second.response.modelVersion).toBe(first.response.modelVersion);
  });

  rowTest('ai#scripted-queue-order entries without matchers are consumed FIFO', async () => {
    const { model } = freshAi([
      { respond: { text: 'first' } },
      { respond: { text: 'second' } },
    ]);
    expect((await model.generateContent('a')).response.text()).toBe('first');
    expect((await model.generateContent('b')).response.text()).toBe('second');
  });

  rowTest('ai#scripted-matchers substring, regex, and predicate matchers select entries over the plain queue', async () => {
    const { model } = freshAi([
      { match: 'weather', respond: { text: 'sunny' } },
      { match: /math/i, respond: { text: 'four' } },
      { match: (request: any) => JSON.stringify(request).includes('predicate-token'), respond: { text: 'matched' } },
      { respond: { text: 'fallback' } },
    ]);
    expect((await model.generateContent('what is 2 + 2, Math genius?')).response.text()).toBe('four');
    expect((await model.generateContent('weather in Paris?')).response.text()).toBe('sunny');
    expect((await model.generateContent('contains predicate-token here')).response.text()).toBe('matched');
    expect((await model.generateContent('anything else')).response.text()).toBe('fallback');
  });

  rowTest('ai#scripted-raw-envelope a raw Gemini envelope entry is returned verbatim', async () => {
    const raw = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'verbatim' }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 1,
        totalTokenCount: 6,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 5 }],
        serviceTier: 'standard',
      },
      modelVersion: 'gemini-3.1-flash-lite',
      responseId: 'fixed-response-id',
    };
    const { model } = freshAi([{ respond: raw }]);
    const response = (await model.generateContent('paste the capture')).response;
    expect(response.candidates).toEqual(raw.candidates);
    expect(response.usageMetadata).toEqual(raw.usageMetadata);
    expect(response.modelVersion).toBe(raw.modelVersion);
    expect(response.responseId).toBe(raw.responseId);
  });

  rowTest('ai#scripted-shorthand-text a text shorthand expands to a wire-true envelope', async () => {
    const { model } = freshAi([{ respond: { text: 'expanded' } }]);
    const response = (await model.generateContent('expand me')).response;
    expect(response.candidates[0].finishReason).toBe('STOP');
    expect('serviceTier' in response.usageMetadata).toBe(true);
    expect(envelope.usageKeySet).toContain('serviceTier');
    expect(typeof response.modelVersion).toBe('string');
    expect(typeof response.responseId).toBe('string');
  });

  rowTest('ai#scripted-shorthand-functioncall a functionCall shorthand mints thoughtSignature on the part', async () => {
    const { model } = freshAi([
      { respond: { functionCall: { name: 'get_weather', args: { city: 'Paris' } } } },
    ]);
    const response = (await model.generateContent('weather?')).response;
    const part = response.candidates[0].content.parts.find((candidate: any) => candidate.functionCall);
    expect(part).toBeDefined();
    expect(response.candidates[0].content.role).toBe('model');
    expect(response.candidates[0].finishReason).toBe('STOP');
    expect(typeof part.thoughtSignature).toBe('string');
    expect(part.thoughtSignature.length).toBeGreaterThan(0);
  });

  rowTest('ai#scripted-stream-chunks a chunk-array shorthand applies the captured framing', async () => {
    const { model } = freshAi([{ respond: { chunks: ['Hel', 'lo'] } }]);
    const result = await model.generateContentStream('greet');
    const chunks = await collect(result.stream);
    expect(chunks.length).toBe(2);
    expect(chunks[0].candidates[0].content.parts[0].text).toBe('Hel');
    expect(chunks[1].candidates[0].content.parts[0].text).toBe('lo');
    expect(framing.finishReasonOnlyOnLastChunk).toBe(true);
    expect(chunks[0].candidates[0].finishReason).toBeUndefined();
    expect(chunks[1].candidates[0].finishReason).toBe('STOP');
    for (const chunk of chunks) expect(chunk.usageMetadata).toBeDefined();
  });

  rowTest('ai#scripted-text-assertable scripted text is returned exactly through response.text()', async () => {
    const scriptedText = 'The exact scripted sentence.';
    const { model } = freshAi([{ respond: { text: scriptedText } }]);
    const result = await model.generateContent('say the sentence');
    expect(result.response.text()).toBe(scriptedText);
  });
});

describe('ai: openai engine translation', () => {
  let server: any;
  let baseUrl: string;
  let lastBody: any;
  let nextResponse: (req: Request) => Response;

  function jsonCompletion(content: string): Response {
    return Response.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 0,
      model: 'mock-model',
      choices: [
        { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }

  function sseResponse(events: string[]): Response {
    const body = events.map((event) => `data: ${event}\n\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }

  function openaiAi(): { ai: any; model: any } {
    const sandbox = seam.sandboxMod.initializeSandbox();
    const ai = seam.ai.getAI(sandbox, { engine: { kind: 'openai', baseUrl } });
    const model = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
    return { ai, model };
  }

  beforeAll(() => {
    nextResponse = () => jsonCompletion('ok');
    server = Bun.serve({
      port: 0,
      fetch: async (request: Request) => {
        lastBody = await request.json().catch(() => undefined);
        return nextResponse(request);
      },
    });
    baseUrl = `http://localhost:${server.port}/v1`;
  });

  afterAll(() => {
    server?.stop(true);
  });

  rowTest('ai#openai-request-translation contents and systemInstruction become chat messages and the reply becomes a Gemini envelope', async () => {
    nextResponse = () => jsonCompletion('translated reply');
    const { model } = openaiAi();
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'hello upstream' }] }],
      systemInstruction: 'be terse',
    });
    expect(lastBody.messages.map((message: any) => message.role)).toEqual(['system', 'user']);
    expect(lastBody.messages[1].content).toBe('hello upstream');
    expect(result.response.candidates[0].content.role).toBe('model');
    expect(result.response.text()).toBe('translated reply');
  });

  rowTest('ai#openai-fifo-tool-ids tool_call ids are matched FIFO against functionResponse parts', async () => {
    nextResponse = () => jsonCompletion('done');
    const { model } = openaiAi();
    await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: 'two tools please' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'first_tool', args: { a: 1 } }, thoughtSignature: 'sig-1' },
            { functionCall: { name: 'second_tool', args: { b: 2 } }, thoughtSignature: 'sig-2' },
          ],
        },
        {
          role: 'function',
          parts: [
            { functionResponse: { name: 'first_tool', response: { ok: 1 } } },
            { functionResponse: { name: 'second_tool', response: { ok: 2 } } },
          ],
        },
      ],
    });
    const assistant = lastBody.messages.find((message: any) => Array.isArray(message.tool_calls));
    expect(assistant).toBeDefined();
    expect(assistant.tool_calls.length).toBe(2);
    const toolMessages = lastBody.messages.filter((message: any) => message.role === 'tool');
    expect(toolMessages.length).toBe(2);
    // FIFO: the first functionResponse joins the first tool_call id.
    expect(toolMessages[0].tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(toolMessages[1].tool_call_id).toBe(assistant.tool_calls[1].id);
  });

  rowTest('ai#openai-buffered-fncalls streamed tool_call deltas are buffered into whole functionCall parts', async () => {
    nextResponse = () =>
      sseResponse([
        JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"cit' } }] } }],
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'y":"Paris"}' } }] } }],
        }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]);
    const { model } = openaiAi();
    const result = await model.generateContentStream('weather stream');
    const chunks = await collect(result.stream);
    const partsWithCall = chunks.flatMap(
      (chunk) => chunk.candidates?.[0]?.content?.parts?.filter((part: any) => part.functionCall) ?? [],
    );
    // Buffered: exactly one whole functionCall part, args fully parsed.
    expect(partsWithCall.length).toBe(1);
    expect(partsWithCall[0].functionCall.name).toBe('get_weather');
    expect(partsWithCall[0].functionCall.args).toEqual({ city: 'Paris' });
  });

  rowTest('ai#openai-done-not-forwarded the [DONE] sentinel never surfaces as a Gemini chunk', async () => {
    nextResponse = () =>
      sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        '[DONE]',
      ]);
    const { model } = openaiAi();
    const result = await model.generateContentStream('stream please');
    const chunks = await collect(result.stream);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk)).not.toContain('[DONE]');
      expect('candidates' in chunk || 'usageMetadata' in chunk).toBe(true);
    }
  });

  rowTest('ai#openai-thought-parts-skipped thought parts in history are skipped on replay to the upstream', async () => {
    nextResponse = () => jsonCompletion('noted');
    const { model } = openaiAi();
    await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: 'question' }] },
        {
          role: 'model',
          parts: [
            { text: 'internal reasoning', thought: true },
            { text: 'visible answer' },
          ],
        },
        { role: 'user', parts: [{ text: 'follow up' }] },
      ],
    });
    const assistantMessages = lastBody.messages.filter((message: any) => message.role === 'assistant');
    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0].content).toBe('visible answer');
    expect(JSON.stringify(lastBody.messages)).not.toContain('internal reasoning');
  });
});
