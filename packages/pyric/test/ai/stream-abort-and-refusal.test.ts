import { describe, expect, test } from 'bun:test';
import { AIError, getAI, getGenerativeModel } from '../../src/ai/index.js';
import { createTransportAI } from '../../src/ai/internal.js';
import {
  AiBrokerError,
  GeminiEngine,
  OpenAiEngine,
  errorEnvelope,
  type WireChunk,
  type WireResponse,
} from '../../src/ai/broker/index.js';
import type { FirebaseApp } from '../../src/app/types.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { sdkActivity } from '../../src/sandbox/internal/sdk-activity.js';

const MODEL = 'gemini-2.5-flash';

function makeChunk(text: string, finishReason?: string): WireChunk {
  const candidate: NonNullable<WireResponse['candidates']>[number] = {
    index: 0,
    content: { role: 'model', parts: [{ text }] },
  };
  if (finishReason !== undefined) {
    candidate.finishReason = finishReason;
  }
  return { candidates: [candidate] };
}

function makeFakeApp(name: string): FirebaseApp {
  return {
    name,
    options: {
      apiKey: 'fake-api-key',
      projectId: 'demo-stream',
      appId: '1:100000000000:web:abc123',
    },
    automaticDataCollectionEnabled: false,
  };
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  throw new Error('Expected promise to reject');
}

function makeControlledSseStream(chunks: string[], delayMs: number): {
  stream: ReadableStream<Uint8Array>;
  isCancelled: () => boolean;
  sentCount: () => number;
} {
  const encoder = new TextEncoder();
  let cancelled = false;
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueueNext = (): void => {
        if (cancelled) return;
        if (sent >= chunks.length) {
          controller.close();
          return;
        }
        const raw = chunks[sent];
        sent += 1;
        if (raw !== undefined) {
          controller.enqueue(encoder.encode(raw));
        }
        timer = setTimeout(enqueueNext, delayMs);
      };
      enqueueNext();
    },
    cancel() {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  });

  return {
    stream,
    isCancelled: () => cancelled,
    sentCount: () => sent,
  };
}

function makeGeminiSseFrames(count: number): string[] {
  const frames: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const finish = i === count - 1 ? 'STOP' : undefined;
    frames.push(`data: ${JSON.stringify(makeChunk(`c${i} `, finish))}\r\n\r\n`);
  }
  return frames;
}

function makeOpenAiSseFrames(count: number): string[] {
  const frames: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const payload = {
      id: 'chatcmpl-1',
      model: 'mock-model',
      choices: [
        {
          index: 0,
          delta: { content: `o${i} ` },
          finish_reason: i === count - 1 ? 'stop' : null,
        },
      ],
    };
    frames.push(`data: ${JSON.stringify(payload)}\n\n`);
  }
  frames.push('data: [DONE]\n\n');
  return frames;
}

describe('ai: transport generateContentStream direct refusal (#1553)', () => {
  test('rejects generateContentStream itself on App Check 401 and bad-request refusals', async () => {
    const refused401 = new AiBrokerError(
      errorEnvelope(401, 'Firebase App Check token is invalid.', 'UNAUTHENTICATED'),
    );
    const ai = createTransportAI(makeFakeApp('transport-401'), undefined, {
      generateContent: async () => {
        throw refused401;
      },
      streamGenerateContent: () =>
        (async function* () {
          throw refused401;
        })(),
      countTokens: async () => ({ totalTokens: 0, promptTokensDetails: [] }),
    });
    const model = getGenerativeModel(ai, { model: MODEL });

    // Must reject the generateContentStream() promise itself (not only .response/.stream).
    const err = await captureRejection(() => model.generateContentStream('ping'));
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).code).toBe('fetch-error');
    expect((err as AIError).customErrorData?.status).toBe(401);
  });

  test('preserves chunk 0 and multi-chunk aggregation on transport stream success', async () => {
    const ai = createTransportAI(makeFakeApp('transport-multi'), undefined, {
      generateContent: async () => makeChunk('unused', 'STOP'),
      streamGenerateContent: () =>
        (async function* () {
          yield makeChunk('first ');
          yield makeChunk('second ');
          yield makeChunk('third', 'STOP');
        })(),
      countTokens: async () => ({ totalTokens: 1, promptTokensDetails: [] }),
    });
    const model = getGenerativeModel(ai, { model: MODEL });
    const res = await model.generateContentStream('hi');
    const seen: string[] = [];
    for await (const chunk of res.stream) {
      seen.push(chunk.text());
    }
    expect(seen).toEqual(['first ', 'second ', 'third']);
    const agg = await res.response;
    expect(agg.text()).toBe('first second third');
  });

  test('handles empty 0-chunk transport streams cleanly with one delivery event', async () => {
    const phases: string[] = [];
    const stop = sdkActivity.subscribe((event) => {
      if (event.record.service === 'ai') phases.push(event.phase);
    });
    try {
      const ai = createTransportAI(makeFakeApp('transport-empty'), undefined, {
        generateContent: async () => makeChunk('', 'STOP'),
        streamGenerateContent: () =>
          (async function* () {
            // empty stream
          })(),
        countTokens: async () => ({ totalTokens: 0, promptTokensDetails: [] }),
      });
      const model = getGenerativeModel(ai, { model: MODEL });
      const res = await model.generateContentStream('hi');
      const seen: unknown[] = [];
      for await (const chunk of res.stream) {
        seen.push(chunk);
      }
      expect(seen).toEqual([]);
      const agg = await res.response;
      expect(agg.candidates).toBeUndefined();
      expect(phases.filter((phase) => phase === 'delivery')).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test('rejects transport generateContentStream on abort before the first chunk and runs return()', async () => {
    let returned = false;
    const ai = createTransportAI(makeFakeApp('transport-abort-first'), undefined, {
      generateContent: async () => makeChunk('unused', 'STOP'),
      streamGenerateContent: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<WireResponse>>(() => undefined),
            return: async () => {
              returned = true;
              return { value: undefined, done: true };
            },
          };
        },
      }),
      countTokens: async () => ({ totalTokens: 0, promptTokensDetails: [] }),
    });
    const model = getGenerativeModel(ai, { model: MODEL });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const err = await captureRejection(() =>
      model.generateContentStream('wait', { signal: controller.signal }),
    );
    expect((err as Error).name).toBe('AbortError');
    expect(returned).toBe(true);
  });

  test('rejects transport generateContentStream on connect timeout before the first chunk', async () => {
    const ai = createTransportAI(makeFakeApp('transport-timeout'), undefined, {
      generateContent: async () => makeChunk('unused', 'STOP'),
      streamGenerateContent: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<WireResponse>>(() => undefined),
            return: async () => ({ value: undefined, done: true }),
          };
        },
      }),
      countTokens: async () => ({ totalTokens: 0, promptTokensDetails: [] }),
    });
    const model = getGenerativeModel(ai, { model: MODEL });
    const err = await captureRejection(() =>
      model.generateContentStream('wait', { timeout: 20 }),
    );
    expect((err as DOMException).name).toBe('AbortError');
    expect((err as DOMException).message).toBe('Timeout has expired.');
  });
});

describe('ai: mid-stream AbortSignal cancellation (#1633)', () => {
  test('ai#stream-abort-midstream aborts GeminiEngine mid-stream, cancels body reader, and suppresses request_rejected', async () => {
    const sandbox = initializeSandbox();
    const rejections: unknown[] = [];
    const unsubscribe = sandbox.onEvent((event) => {
      if (event.kind === 'service_mutation' && event.service === 'ai' && event.op === 'request_rejected') {
        rejections.push(event);
      }
    });

    const frames = makeGeminiSseFrames(20);
    const controlled = makeControlledSseStream(frames, 25);
    const seenSignals: AbortSignal[] = [];
    const ai = getAI(sandbox, {
      engine: {
        kind: 'gemini',
        apiKey: 'synthetic-key',
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.signal) seenSignals.push(init.signal);
          return new Response(controlled.stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }) as unknown as typeof fetch,
      },
    });

    try {
      const model = getGenerativeModel(ai, { model: MODEL });
      const controller = new AbortController();
      const result = await model.generateContentStream('count', { signal: controller.signal });
      const seen: string[] = [];
      const streamErr = await captureRejection(async () => {
        for await (const chunk of result.stream) {
          seen.push(chunk.text());
          if (seen.length === 3) {
            controller.abort();
          }
        }
      });
      const responseErr = await captureRejection(() => result.response);

      expect(seen).toEqual(['c0 ', 'c1 ', 'c2 ']);
      expect((streamErr as Error).name).toBe('AbortError');
      expect((responseErr as Error).name).toBe('AbortError');
      expect(seenSignals.length).toBe(1);
      expect(seenSignals[0]?.aborted).toBe(true);
      expect(controlled.isCancelled()).toBe(true);
      expect(controlled.sentCount()).toBeLessThan(20);
      expect(rejections).toEqual([]);
    } finally {
      unsubscribe();
      sandbox.dispose();
    }
  });

  test('cancels GeminiEngine reader when consumer breaks out of generator early without aborting signal', async () => {
    const controlled = makeControlledSseStream(makeGeminiSseFrames(20), 25);
    const engine = new GeminiEngine({
      apiKey: 'synthetic-key',
      fetch: (async () =>
        new Response(controlled.stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch,
    });
    let seen = 0;
    for await (const _chunk of engine.streamGenerateContent(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      MODEL,
    )) {
      seen += 1;
      if (seen === 2) break;
    }
    expect(seen).toBe(2);
    expect(controlled.isCancelled()).toBe(true);
  });

  test('cancels OpenAiEngine reader immediately on mid-stream AbortSignal abort', async () => {
    const controlled = makeControlledSseStream(makeOpenAiSseFrames(20), 25);
    const engine = new OpenAiEngine({
      baseUrl: 'http://127.0.0.1:19999/v1',
      model: 'mock-model',
      fetch: (async () =>
        new Response(controlled.stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const seen: string[] = [];
    const err = await captureRejection(async () => {
      for await (const chunk of engine.streamGenerateContent(
        { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        MODEL,
        undefined,
        { signal: controller.signal },
      )) {
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        seen.push(text);
        if (seen.length === 2) controller.abort();
      }
    });
    expect(seen).toEqual(['o0 ', 'o1 ']);
    expect((err as Error).name).toBe('AbortError');
    expect(controlled.isCancelled()).toBe(true);
    expect(controlled.sentCount()).toBeLessThan(20);
  });

  test('stops yielding already-buffered chunks when signal aborts mid-stream while stream is still open', async () => {
    const sandbox = initializeSandbox();
    let releaseTail: (() => void) | undefined;
    const ai = getAI(sandbox, {
      engine: {
        generateContent: async () => makeChunk('unused', 'STOP'),
        streamGenerateContent: () =>
          (async function* () {
            yield makeChunk('a ');
            yield makeChunk('b ');
            yield makeChunk('c ');
            yield makeChunk('d ');
            await new Promise<void>((resolve) => {
              releaseTail = resolve;
            });
          })(),
        countTokens: async () => ({ totalTokens: 1, promptTokensDetails: [] }),
      },
    });
    try {
      const model = getGenerativeModel(ai, { model: MODEL });
      const controller = new AbortController();
      const result = await model.generateContentStream('hi', { signal: controller.signal });
      // Allow the eager pump to buffer all four initial chunks before reading.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const seen: string[] = [];
      const streamErr = await captureRejection(async () => {
        for await (const chunk of result.stream) {
          seen.push(chunk.text());
          if (seen.length === 2) controller.abort();
        }
      });
      const responseErr = await captureRejection(() => result.response);
      expect(seen).toEqual(['a ', 'b ']);
      expect((streamErr as Error).name).toBe('AbortError');
      expect((responseErr as Error).name).toBe('AbortError');
    } finally {
      releaseTail?.();
      sandbox.dispose();
    }
  });

  test('ChatSession.sendMessageStream mid-stream abort leaves aborted turn out of history', async () => {
    const sandbox = initializeSandbox();
    const controlled = makeControlledSseStream(makeGeminiSseFrames(10), 25);
    const ai = getAI(sandbox, {
      engine: {
        kind: 'gemini',
        apiKey: 'synthetic-key',
        fetch: (async () =>
          new Response(controlled.stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })) as unknown as typeof fetch,
      },
    });
    try {
      const chat = getGenerativeModel(ai, { model: MODEL }).startChat();
      const controller = new AbortController();
      const result = await chat.sendMessageStream('tell a story', { signal: controller.signal });
      const err = await captureRejection(async () => {
        for await (const _chunk of result.stream) {
          controller.abort();
        }
      });
      expect((err as Error).name).toBe('AbortError');
      expect(await chat.getHistory()).toEqual([]);
      expect(controlled.isCancelled()).toBe(true);
    } finally {
      sandbox.dispose();
    }
  });

  test('aborting after an already-completed stream completes cleanly like real @firebase/ai', async () => {
    const sandbox = initializeSandbox();
    const ai = getAI(sandbox, {
      engine: {
        kind: 'scripted',
        script: [{ respond: { chunks: ['a ', 'b ', 'c '] } }],
      },
    });
    try {
      const model = getGenerativeModel(ai, { model: MODEL });
      const controller = new AbortController();
      const result = await model.generateContentStream('hi', { signal: controller.signal });
      // Wait for the finite scripted stream to finish and dispose the abort scope.
      await result.response;
      const seen: string[] = [];
      for await (const chunk of result.stream) {
        seen.push(chunk.text());
        if (seen.length === 1) controller.abort();
      }
      expect(seen).toEqual(['a ', 'b ', 'c ']);
    } finally {
      sandbox.dispose();
    }
  });
});
