import { describe, expect, test } from 'bun:test';
import {
  AIError,
  AIErrorCode,
  FinishReason,
  getAI,
  getGenerativeModel,
} from '../../src/ai/index.js';
import {
  AiBrokerError,
  GeminiEngine,
  geminiToOpenAIRequest,
  openAIToGeminiResponse,
  type OpenAIRequest,
  type OpenAIResponse,
  type WireChunk,
} from '../../src/ai/broker/index.js';
import { script } from '../../src/ai/scripting.js';
import { initializeSandbox } from '../../src/sandbox/index.js';

const MODEL = 'gemini-2.5-flash';

async function drainChunks(stream: AsyncIterable<WireChunk>): Promise<WireChunk[]> {
  const chunks: WireChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('ai: OpenAI wire translation empty choices, mixed turns, and fileData', () => {
  test('openAIToGeminiResponse throws AiBrokerError on empty choices or missing message', () => {
    const emptyChoices: OpenAIResponse = { id: 'c1', model: 'test-model', choices: [] };
    expect(() => openAIToGeminiResponse(emptyChoices)).toThrow(AiBrokerError);

    const missingMessage = {
      id: 'c2',
      model: 'test-model',
      choices: [{ index: 0, finish_reason: 'stop' }],
    } as unknown as OpenAIResponse;
    expect(() => openAIToGeminiResponse(missingMessage)).toThrow(AiBrokerError);
  });

  test('OpenAiEngine translates empty choices to AIError rather than unwrapped TypeError', async () => {
    const ai = getAI(initializeSandbox(), {
      engine: {
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:9999/v1',
        model: 'test-model',
        fetch: (async () =>
          new Response(JSON.stringify({ id: 'c3', model: 'test-model', choices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      },
    });
    const model = getGenerativeModel(ai, { model: MODEL });

    let thrown: unknown;
    try {
      await model.generateContent('hello');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AIError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as AIError).code).toBe(AIErrorCode.FETCH_ERROR);
    expect((thrown as AIError).customErrorData?.status).toBe(502);
  });

  test('geminiToOpenAIRequest preserves sibling text, inlineData, and fileData on mixed functionResponse turns', () => {
    const translated = geminiToOpenAIRequest(
      'test-model',
      {
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { name: 'lookupItem', args: { id: 'item-1' } } }],
          },
          {
            role: 'user',
            parts: [
              { text: 'follow-up note' },
              {
                fileData: {
                  mimeType: 'application/pdf',
                  fileUri: 'gs://items-bucket/doc-1.pdf',
                },
              },
              { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
              { functionResponse: { name: 'lookupItem', response: { found: true } } },
            ],
          },
        ],
      },
      false,
    );

    expect(translated.messages.length).toBe(3);
    expect(translated.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_lookupItem_0',
      content: JSON.stringify({ found: true }),
    });
    expect(translated.messages[2]).toEqual({
      role: 'user',
      content:
        'follow-up note' +
        '[unsupported fileData part: application/pdf gs://items-bucket/doc-1.pdf]' +
        '[unsupported inlineData part: image/png]',
    });
  });

  test('geminiToOpenAIRequest keeps pure functionResponse turns free of extra user messages', () => {
    const translated = geminiToOpenAIRequest(
      'test-model',
      {
        contents: [
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'lookupItem', response: { id: 'item-2' } } }],
          },
        ],
      },
      false,
    );
    expect(translated.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_lookupItem_0',
        content: JSON.stringify({ id: 'item-2' }),
      },
    ]);
  });

  test('geminiToOpenAIRequest translates standalone fileData parts and forwards them end-to-end', async () => {
    let sentBody: OpenAIRequest | undefined;
    const ai = getAI(initializeSandbox(), {
      engine: {
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:9999/v1',
        model: 'test-model',
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          sentBody = JSON.parse(String(init?.body ?? '{}')) as OpenAIRequest;
          return new Response(
            JSON.stringify({
              id: 'c4',
              model: 'test-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'acknowledged' },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as unknown as typeof fetch,
      },
    });

    const model = getGenerativeModel(ai, { model: MODEL });
    const res = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'summarize ', type: 'text' },
            {
              fileData: { mimeType: 'text/plain', fileUri: 'gs://docs-bucket/notes.txt' },
              type: 'fileData',
            },
          ],
        },
      ],
    });
    expect(res.response.text()).toBe('acknowledged');
    expect(sentBody?.messages).toEqual([
      {
        role: 'user',
        content: 'summarize [unsupported fileData part: text/plain gs://docs-bucket/notes.txt]',
      },
    ]);
  });
});

describe('ai: ChatSession history excludes blocked and contentless candidates', () => {
  test('sendMessage omits contentless SAFETY candidate and its prompt so startChat({ history }) succeeds', async () => {
    const ai = getAI(initializeSandbox());
    script(ai, [
      { respond: { text: 'first reply' } },
      { respond: { candidates: [{ index: 0, finishReason: FinishReason.SAFETY }] } as never },
      { respond: { text: 'third reply' } },
    ]);
    const model = getGenerativeModel(ai, { model: MODEL });
    const chat = model.startChat();

    await chat.sendMessage('turn 1');
    await chat.sendMessage('turn 2 blocked');

    const historyAfterBlock = await chat.getHistory();
    expect(historyAfterBlock.length).toBe(2);
    expect(historyAfterBlock.map((entry) => entry.role)).toEqual(['user', 'model']);
    expect(historyAfterBlock[0]?.parts[0]?.text).toBe('turn 1');
    expect(historyAfterBlock[1]?.parts[0]?.text).toBe('first reply');

    const resumed = model.startChat({ history: historyAfterBlock });
    expect(await resumed.getHistory()).toEqual(historyAfterBlock);

    const turn3 = await chat.sendMessage('turn 3');
    expect(turn3.response.text()).toBe('third reply');
    const historyAfterTurn3 = await chat.getHistory();
    expect(historyAfterTurn3.map((entry) => entry.role)).toEqual(['user', 'model', 'user', 'model']);
  });

  test('sendMessage excludes blocked candidates with partial content and contentless STOP candidates', async () => {
    const ai = getAI(initializeSandbox());
    script(ai, [
      {
        respond: {
          candidates: [
            {
              index: 0,
              finishReason: FinishReason.RECITATION,
              content: { role: 'model', parts: [{ text: 'partial' }] },
            },
          ],
        },
      },
      {
        respond: {
          candidates: [
            {
              index: 0,
              finishReason: FinishReason.STOP,
              content: { role: 'model', parts: [] },
            },
          ],
        },
      },
    ]);
    const model = getGenerativeModel(ai, { model: MODEL });
    const chat = model.startChat();

    await chat.sendMessage('recitation prompt');
    await chat.sendMessage('empty parts prompt');
    expect(await chat.getHistory()).toEqual([]);
  });

  test('sendMessageStream excludes blocked candidates even after partial streamed text', async () => {
    const ai = getAI(initializeSandbox(), {
      engine: {
        kind: 'gemini',
        apiKey: 'synthetic-key',
        fetch: (async () => {
          const chunk1 = {
            candidates: [
              { index: 0, content: { role: 'model', parts: [{ text: 'partial ' }] } },
            ],
          };
          const chunk2 = {
            candidates: [{ index: 0, finishReason: FinishReason.SAFETY }],
          };
          return new Response(
            `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }) as unknown as typeof fetch,
      },
    });
    const model = getGenerativeModel(ai, { model: MODEL });
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: 'seed question', type: 'text' }] },
        { role: 'model', parts: [{ text: 'seed answer', type: 'text' }] },
      ],
    });

    const streamRes = await chat.sendMessageStream('blocked stream turn');
    for await (const _chunk of streamRes.stream) {
      // drain
    }
    await streamRes.response;

    const history = await chat.getHistory();
    expect(history).toEqual([
      { role: 'user', parts: [{ text: 'seed question', type: 'text' }] },
      { role: 'model', parts: [{ text: 'seed answer', type: 'text' }] },
    ]);
    expect(() => model.startChat({ history })).not.toThrow();
  });

  test('sendMessageStream excludes contentless SAFETY candidates from history', async () => {
    const ai = getAI(initializeSandbox());
    script(ai, [
      { respond: { candidates: [{ index: 0, finishReason: FinishReason.SAFETY }] } as never },
    ]);
    const model = getGenerativeModel(ai, { model: MODEL });
    const chat = model.startChat();

    const streamRes = await chat.sendMessageStream('blocked contentless stream');
    for await (const _chunk of streamRes.stream) {
      // drain
    }
    await streamRes.response;

    const history = await chat.getHistory();
    expect(history).toEqual([]);
    expect(() => model.startChat({ history })).not.toThrow();
  });
});

describe('ai: GeminiEngine WHATWG SSE framing', () => {
  const sampleChunk = (text: string, finishReason?: string): WireChunk => ({
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text }] },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
  });

  function engineFromChunks(rawParts: string[], apiKey = 'synthetic-key'): GeminiEngine {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of rawParts) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    });
    return new GeminiEngine({
      apiKey,
      fetch: (async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch,
    });
  }

  test('parses data:{...} without space, mixed spacing, and [DONE] sentinels', async () => {
    const c1 = sampleChunk('alpha');
    const c2 = sampleChunk('beta', 'STOP');
    const engine = engineFromChunks([
      `data:${JSON.stringify(c1)}\n\n`,
      `data: ${JSON.stringify(c2)}\n\n`,
      'data:[DONE]\n\n',
      'data:\n\n',
    ]);
    const chunks = await drainChunks(
      engine.streamGenerateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, MODEL),
    );
    expect(chunks).toEqual([c1, c2]);
  });

  test('parses multi-line SSE data frames, split CRLF chunk boundaries, and EOF without trailing newline', async () => {
    const c1 = sampleChunk('multiline');
    const c2 = sampleChunk('split-crlf');
    const c3 = sampleChunk('eof-chunk', 'STOP');
    const prettyC1 = JSON.stringify(c1, null, 2)
      .split('\n')
      .map((line) => `data:${line}`)
      .join('\n');

    const engine = engineFromChunks([
      `${prettyC1}\n\n`,
      `data:${JSON.stringify(c2)}\r`,
      `\n\r\n`,
      `data:${JSON.stringify(c3)}`,
    ]);
    const chunks = await drainChunks(
      engine.streamGenerateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, MODEL),
    );
    expect(chunks).toEqual([c1, c2, c3]);
  });

  test('parses consecutive data:{...} lines without blank separator and CR-delimited events', async () => {
    const c1 = sampleChunk('first');
    const c2 = sampleChunk('second');
    const c3 = sampleChunk('third', 'STOP');
    const engine = engineFromChunks([
      `data:${JSON.stringify(c1)}\ndata:${JSON.stringify(c2)}\n\n`,
      `data:${JSON.stringify(c3)}\r\r`,
    ]);
    const chunks = await drainChunks(
      engine.streamGenerateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, MODEL),
    );
    expect(chunks).toEqual([c1, c2, c3]);
  });

  test('redacts credentials inside mid-stream error events framed as data:{...} without space', async () => {
    const secret = 'AIzaSyFakeKeyForSseRedactionCheck';
    const errChunk = { error: { code: 500, message: `bad key ${secret}`, status: 'INTERNAL' } };
    const engine = engineFromChunks([`data:${JSON.stringify(errChunk)}\n\n`], secret);
    const chunks = await drainChunks(
      engine.streamGenerateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, MODEL),
    );
    expect(JSON.stringify(chunks)).not.toContain(secret);
    expect(chunks).toEqual([
      { error: { code: 500, message: 'bad key ***', status: 'INTERNAL' } } as unknown as WireChunk,
    ]);
  });

  test('redacts credentials inside array-wrapped mid-stream error events', async () => {
    const secret = 'AIzaSyFakeKeyForArraySseRedaction';
    const errEnvelope = [{ error: { code: 400, message: `refused ${secret}`, status: 'INVALID_ARGUMENT' } }];
    const engine = engineFromChunks(
      [`data: ${JSON.stringify(errEnvelope)}\n\n`, `data:${JSON.stringify(errEnvelope)}\n\n`],
      secret,
    );
    const chunks = await drainChunks(
      engine.streamGenerateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, MODEL),
    );
    expect(JSON.stringify(chunks)).not.toContain(secret);
    expect(chunks).toEqual([
      [{ error: { code: 400, message: 'refused ***', status: 'INVALID_ARGUMENT' } }] as unknown as WireChunk,
      [{ error: { code: 400, message: 'refused ***', status: 'INVALID_ARGUMENT' } }] as unknown as WireChunk,
    ]);
  });

  test('fails with AIError(PARSE_FAILED) on malformed SSE JSON frames and redacts secrets', async () => {
    const secret = 'AIzaSyFakeKeyInMalformedSseFrame';
    const cases = [
      { label: 'spaced', payload: 'data: {not-valid-json}\n\n', expectedQuote: '"{not-valid-json}"' },
      { label: 'no-space', payload: 'data:{broken\n\n', expectedQuote: '"{broken"' },
      { label: 'eof-flush', payload: 'data:{truncated-eof', expectedQuote: '"{truncated-eof"' },
      { label: 'two-spaces', payload: 'data:  {keep-second-space\n\n', expectedQuote: '" {keep-second-space"' },
      {
        label: 'multiline-broken',
        payload: 'data:{\ndata:  "bad":\ndata:}\n\n',
        expectedQuote: '"{\n "bad":\n}"',
      },
      {
        label: 'secret-redacted',
        payload: `data:{broken ${secret}\n\n`,
        expectedQuote: '"{broken ***"',
      },
    ];

    for (const tc of cases) {
      const ai = getAI(initializeSandbox(), {
        engine: {
          kind: 'gemini',
          apiKey: secret,
          fetch: (async () =>
            new Response(tc.payload, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            })) as unknown as typeof fetch,
        },
      });
      const model = getGenerativeModel(ai, { model: MODEL });
      const streamRes = await model.generateContentStream('hi');

      let streamErr: unknown;
      try {
        for await (const _chunk of streamRes.stream) {
          // drain
        }
      } catch (err) {
        streamErr = err;
      }
      let responseErr: unknown;
      try {
        await streamRes.response;
      } catch (err) {
        responseErr = err;
      }

      for (const err of [streamErr, responseErr]) {
        expect(err, `${tc.label}: expected AIError`).toBeInstanceOf(AIError);
        const aiErr = err as AIError;
        expect(aiErr.code, `${tc.label}: expected PARSE_FAILED`).toBe(AIErrorCode.PARSE_FAILED);
        expect(aiErr.message, `${tc.label}: expected quoted snippet`).toContain(tc.expectedQuote);
        expect(aiErr.message, `${tc.label}: must not leak secret`).not.toContain(secret);
      }
    }
  });

  test('yields valid chunks before failing with AIError(PARSE_FAILED) on a later malformed frame', async () => {
    const valid = sampleChunk('before-failure');
    const scenarios = [
      `data:  ${JSON.stringify(valid)}\n\ndata: {broken\n\n`,
      `data:${JSON.stringify(valid)}\ndata:{broken\n\n`,
    ];

    for (const payload of scenarios) {
      const ai = getAI(initializeSandbox(), {
        engine: {
          kind: 'gemini',
          apiKey: 'synthetic-key',
          fetch: (async () =>
            new Response(payload, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            })) as unknown as typeof fetch,
        },
      });
      const model = getGenerativeModel(ai, { model: MODEL });
      const streamRes = await model.generateContentStream('hi');

      const seen: string[] = [];
      let streamErr: unknown;
      try {
        for await (const chunk of streamRes.stream) {
          seen.push(chunk.text());
        }
      } catch (err) {
        streamErr = err;
      }

      expect(seen).toEqual(['before-failure']);
      expect(streamErr).toBeInstanceOf(AIError);
      expect((streamErr as AIError).code).toBe(AIErrorCode.PARSE_FAILED);
      await expect(streamRes.response).rejects.toMatchObject({ code: AIErrorCode.PARSE_FAILED });
    }
  });
});
