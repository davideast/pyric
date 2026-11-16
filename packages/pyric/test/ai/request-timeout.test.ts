import { describe, expect, test } from 'bun:test';
import { AIError, getAI, getGenerativeModel } from '../../src/ai/index.js';
import type {
  AnswerEngine,
  CountTokensResponse,
  WireChunk,
  WireResponse,
} from '../../src/ai/broker/index.js';
import { initializeSandbox } from '../../src/sandbox/index.js';

const MODEL = 'gemini-2.5-flash';

function makeTextResponse(text: string): WireResponse {
  return {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
      },
    ],
  };
}

function makeSlowCustomEngine(delayMs: number, options?: { ignoreSignal?: boolean }): {
  engine: AnswerEngine;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal) signals.push(signal);
      if (!options?.ignoreSignal && signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        if (signal && !options?.ignoreSignal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      if (signal && !options?.ignoreSignal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

  const engine: AnswerEngine = {
    async generateContent(_req, _model, _appCheck, callOptions): Promise<WireResponse> {
      await wait(delayMs, callOptions?.signal);
      return makeTextResponse('completed');
    },
    async *streamGenerateContent(_req, _model, _appCheck, callOptions): AsyncIterable<WireChunk> {
      await wait(delayMs, callOptions?.signal);
      callOptions?.onStreamOpen?.();
      yield makeTextResponse('streamed');
    },
    async countTokens(_req, _model, _appCheck, callOptions): Promise<CountTokensResponse> {
      await wait(delayMs, callOptions?.signal);
      return { totalTokens: 7, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 7 }] };
    },
  };

  return { engine, signals };
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  throw new Error('Expected promise to reject');
}

function abortableFetch(delayMs: number, buildResponse: () => Response): {
  fetch: typeof fetch;
  abortedCount: () => number;
  receivedSignals: AbortSignal[];
} {
  let aborted = 0;
  const receivedSignals: AbortSignal[] = [];
  const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    if (signal) receivedSignals.push(signal);
    return await new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        aborted += 1;
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(buildResponse());
      }, delayMs);
      const onAbort = (): void => {
        aborted += 1;
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  return { fetch: fetchFn as unknown as typeof fetch, abortedCount: () => aborted, receivedSignals };
}

describe('ai: RequestOptions.timeout and SingleRequestOptions.timeout parity', () => {
  test('generateContent honors model RequestOptions.timeout with upstream AbortError shape', async () => {
    const { engine, signals } = makeSlowCustomEngine(400);
    const ai = getAI(initializeSandbox(), { engine });
    const model = getGenerativeModel(ai, { model: MODEL }, { timeout: 30 });

    const startedAt = Date.now();
    const err = await captureRejection(() => model.generateContent('hello'));
    const elapsedMs = Date.now() - startedAt;

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect((err as DOMException).message).toBe('Timeout has expired.');
    expect(elapsedMs).toBeLessThan(300);
    expect(signals.length).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test('SingleRequestOptions.timeout overrides RequestOptions.timeout in both directions', async () => {
    const slow = makeSlowCustomEngine(300);
    const ai1 = getAI(initializeSandbox(), { engine: slow.engine });
    const looseModel = getGenerativeModel(ai1, { model: MODEL }, { timeout: 5000 });
    const tighterErr = await captureRejection(() =>
      looseModel.generateContent('hello', { timeout: 25 }),
    );
    expect((tighterErr as DOMException).name).toBe('AbortError');
    expect((tighterErr as DOMException).message).toBe('Timeout has expired.');

    const medium = makeSlowCustomEngine(60);
    const ai2 = getAI(initializeSandbox(), { engine: medium.engine });
    const tightModel = getGenerativeModel(ai2, { model: MODEL }, { timeout: 15 });
    const res = await tightModel.generateContent('hello', { timeout: 1000 });
    expect(res.response.text()).toBe('completed');
  });

  test('negative and NaN timeouts fall back to default timeout; zero timeout expires on delayed engines', async () => {
    const fast = makeSlowCustomEngine(30);
    const ai = getAI(initializeSandbox(), { engine: fast.engine });
    const model = getGenerativeModel(ai, { model: MODEL });

    const negRes = await model.generateContent('hello', { timeout: -1 });
    expect(negRes.response.text()).toBe('completed');

    const nanRes = await model.generateContent('hello', { timeout: Number.NaN });
    expect(nanRes.response.text()).toBe('completed');

    const infRes = await model.generateContent('hello', { timeout: Number.POSITIVE_INFINITY });
    expect(infRes.response.text()).toBe('completed');

    const zeroErr = await captureRejection(() => model.generateContent('hello', { timeout: 0 }));
    expect((zeroErr as DOMException).name).toBe('AbortError');
    expect((zeroErr as DOMException).message).toBe('Timeout has expired.');
  });

  test('enforces timeout even when a custom AnswerEngine ignores the abort signal', async () => {
    const { engine } = makeSlowCustomEngine(500, { ignoreSignal: true });
    const ai = getAI(initializeSandbox(), { engine });
    const model = getGenerativeModel(ai, { model: MODEL });

    const startedAt = Date.now();
    const err = await captureRejection(() => model.generateContent('hello', { timeout: 25 }));
    const elapsedMs = Date.now() - startedAt;

    expect((err as DOMException).name).toBe('AbortError');
    expect((err as DOMException).message).toBe('Timeout has expired.');
    expect(elapsedMs).toBeLessThan(300);
  });

  test('countTokens honors RequestOptions.timeout and SingleRequestOptions.timeout', async () => {
    const { engine } = makeSlowCustomEngine(400);
    const ai = getAI(initializeSandbox(), { engine });
    const model = getGenerativeModel(ai, { model: MODEL }, { timeout: 25 });

    const err = await captureRejection(() => model.countTokens('hello'));
    expect((err as DOMException).name).toBe('AbortError');
    expect((err as DOMException).message).toBe('Timeout has expired.');

    const fast = makeSlowCustomEngine(20);
    const aiFast = getAI(initializeSandbox(), { engine: fast.engine });
    const tightModel = getGenerativeModel(aiFast, { model: MODEL }, { timeout: 5 });
    const count = await tightModel.countTokens('hello', { timeout: 500 });
    expect(count.totalTokens).toBe(7);
  });

  test('generateContentStream rejects both stream and response on connect timeout', async () => {
    const { engine } = makeSlowCustomEngine(400);
    const ai = getAI(initializeSandbox(), { engine });
    const model = getGenerativeModel(ai, { model: MODEL }, { timeout: 25 });

    const result = await model.generateContentStream('hello');
    const streamErr = await captureRejection(async () => {
      for await (const _chunk of result.stream) {
        // wait for rejection
      }
    });
    const responseErr = await captureRejection(() => result.response);

    expect((streamErr as DOMException).name).toBe('AbortError');
    expect((streamErr as DOMException).message).toBe('Timeout has expired.');
    expect((responseErr as DOMException).name).toBe('AbortError');
    expect((responseErr as DOMException).message).toBe('Timeout has expired.');
  });

  test('generateContentStream clears timeout once stream opens while keeping external signal active', async () => {
    const delayedBody = (): Response => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(makeTextResponse('part-1 '))}\n\n`,
            ),
          );
          setTimeout(() => {
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(makeTextResponse('part-2'))}\n\n`,
                ),
              );
              controller.close();
            } catch {
              // stream already cancelled
            }
          }, 90);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const ai = getAI(initializeSandbox(), {
      engine: {
        kind: 'gemini',
        apiKey: 'synthetic-key',
        fetch: (async () => delayedBody()) as unknown as typeof fetch,
      },
    });
    const model = getGenerativeModel(ai, { model: MODEL }, { timeout: 40 });

    const opened = await model.generateContentStream('hello');
    const texts: string[] = [];
    for await (const chunk of opened.stream) {
      texts.push(chunk.text());
    }
    const aggregated = await opened.response;
    expect(texts).toEqual(['part-1 ', 'part-2']);
    expect(aggregated.text()).toBe('part-1 part-2');

    // External signal still aborts an already-open stream mid-response.
    const abortCtrl = new AbortController();
    const midStream = await model.generateContentStream('hello', {
      timeout: 5000,
      signal: abortCtrl.signal,
    });
    const firstChunks: string[] = [];
    const midErr = await captureRejection(async () => {
      for await (const chunk of midStream.stream) {
        firstChunks.push(chunk.text());
        abortCtrl.abort(new DOMException('caller cancelled', 'AbortError'));
      }
    });
    expect(firstChunks).toEqual(['part-1 ']);
    expect((midErr as DOMException).name).toBe('AbortError');
    expect((midErr as DOMException).message).toBe('caller cancelled');
  });

  test('ChatSession.sendMessage and sendMessageStream inherit timeout and do not pollute history on timeout', async () => {
    const { engine } = makeSlowCustomEngine(400);
    const ai = getAI(initializeSandbox(), { engine });
    const model = getGenerativeModel(ai, { model: MODEL }, { timeout: 25 });
    const chat = model.startChat();

    const unaryErr = await captureRejection(() => chat.sendMessage('turn 1'));
    expect((unaryErr as DOMException).name).toBe('AbortError');
    expect((unaryErr as DOMException).message).toBe('Timeout has expired.');
    expect(await chat.getHistory()).toEqual([]);

    const streamRes = await chat.sendMessageStream('turn 2', { timeout: 25 });
    const streamErr = await captureRejection(() => streamRes.response);
    expect((streamErr as DOMException).name).toBe('AbortError');
    expect((streamErr as DOMException).message).toBe('Timeout has expired.');
    expect(await chat.getHistory()).toEqual([]);
  });

  test('combined signal and timeout: external abort wins before timeout and pre-aborted signal throws immediately', async () => {
    const { engine } = makeSlowCustomEngine(500);
    const ai = getAI(initializeSandbox(), { engine });
    const model = getGenerativeModel(ai, { model: MODEL }, { timeout: 200 });

    const preAborted = new AbortController();
    preAborted.abort('stopped early');
    const preErr = await captureRejection(() =>
      model.generateContent('hello', { signal: preAborted.signal }),
    );
    expect((preErr as DOMException).name).toBe('AbortError');
    expect((preErr as DOMException).message).toBe('stopped early');

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException('user cancelled', 'AbortError')), 20);
    const extErr = await captureRejection(() =>
      model.generateContent('hello', { signal: ctrl.signal, timeout: 400 }),
    );
    expect((extErr as DOMException).name).toBe('AbortError');
    expect((extErr as DOMException).message).toBe('user cancelled');
  });

  test('OpenAiEngine and GeminiEngine propagate abort signal to fetch without wrapping in AIError', async () => {
    const openAiFetch = abortableFetch(400, () =>
      new Response(
        JSON.stringify({
          id: 'cmpl-1',
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'late' },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const openAi = getAI(initializeSandbox(), {
      engine: {
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:9999/v1',
        model: 'test-model',
        fetch: openAiFetch.fetch,
      },
    });
    const openAiModel = getGenerativeModel(openAi, { model: MODEL });
    const openAiErr = await captureRejection(() =>
      openAiModel.generateContent('hello', { timeout: 25 }),
    );
    expect(openAiErr).not.toBeInstanceOf(AIError);
    expect((openAiErr as DOMException).name).toBe('AbortError');
    expect((openAiErr as DOMException).message).toBe('Timeout has expired.');
    expect(openAiFetch.abortedCount()).toBe(1);

    const geminiFetch = abortableFetch(400, () =>
      new Response(JSON.stringify(makeTextResponse('late')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const geminiAi = getAI(initializeSandbox(), {
      engine: {
        kind: 'gemini',
        apiKey: 'synthetic-key',
        fetch: geminiFetch.fetch,
      },
    });
    const geminiModel = getGenerativeModel(geminiAi, { model: MODEL });
    const geminiErr = await captureRejection(() =>
      geminiModel.generateContent('hello', { timeout: 25 }),
    );
    expect(geminiErr).not.toBeInstanceOf(AIError);
    expect((geminiErr as DOMException).name).toBe('AbortError');
    expect((geminiErr as DOMException).message).toBe('Timeout has expired.');
    expect(geminiFetch.abortedCount()).toBe(1);
  });

  test('disposes stream timeout and rejects stream/response when engine iterator throws synchronously', async () => {
    const customEngine: AnswerEngine = {
      async generateContent() {
        return makeTextResponse('unused');
      },
      streamGenerateContent() {
        return {
          [Symbol.asyncIterator]() {
            throw new Error('sync iterator init failed');
          },
        };
      },
      async countTokens() {
        return { totalTokens: 1, promptTokensDetails: [] };
      },
    };
    const ai = getAI(initializeSandbox(), { engine: customEngine });
    const model = getGenerativeModel(ai, { model: MODEL });
    const streamRes = await model.generateContentStream('hi', { timeout: 60_000 });

    const streamErr = await captureRejection(async () => {
      for await (const _chunk of streamRes.stream) {
        // should fail immediately without hanging
      }
    });
    const responseErr = await captureRejection(() => streamRes.response);
    expect((streamErr as Error).message).toBe('sync iterator init failed');
    expect((responseErr as Error).message).toBe('sync iterator init failed');
  });
});
