import { describe, expect, it } from 'bun:test';
import { probe as midStreamProbe } from '../../../conformance/probes/ai/ai-offline-mid-stream-error-handling.ts';
import { AIError, AIErrorCode, getAI, getGenerativeModel } from '../../src/ai/index.js';
import { GeminiEngine } from '../../src/ai/broker/gemini-engine.js';
import type { WireChunk, WireResponse } from '../../src/ai/broker/types.js';
import { createTransportAI, maskStreamErrors } from '../../src/ai/internal.js';
import type { FirebaseApp } from '../../src/app/types.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { packAiEvidence, unpackAiEvidence } from '../../src/sandbox/internal/ai-evidence.js';
import { sdkActivity, type SdkActivityRecord } from '../../src/sandbox/internal/sdk-activity.js';

const MODEL = 'gemini-flash-lite-latest';

const FIRST_CHUNK =
  'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"alpha "}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5},"modelVersion":"gemini-2.5-flash","responseId":"resp-1753"}\r\n\r\n';
const OBJECT_ERROR_CHUNK =
  'data: {"error":{"code":500,"message":"Internal stream error","status":"INTERNAL"}}\r\n\r\n';
const ARRAY_ERROR_CHUNK =
  'data: [{"error":{"code":500,"message":"Array stream error","status":"INTERNAL"}}]\r\n\r\n';
const FINAL_CHUNK =
  'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"beta"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6},"modelVersion":"gemini-2.5-flash","responseId":"resp-1753"}\r\n\r\n';

function makeFakeApp(name: string): FirebaseApp {
  return {
    name,
    options: {
      apiKey: 'fake-api-key',
      projectId: 'demo-ai-mid-stream-error',
      appId: '1:100000000000:web:deadbeef1753',
    },
    automaticDataCollectionEnabled: false,
  };
}

function makeSseFetch(frames: string | string[] | Uint8Array[]): typeof fetch {
  const parts: Array<string | Uint8Array> = Array.isArray(frames) ? frames : [frames];
  const encoder = new TextEncoder();
  return Object.assign(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
            }
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    { preconnect: fetch.preconnect },
  );
}

interface StreamSummary {
  yieldedTexts: string[];
  yieldedChunkCount: number;
  anyChunkHasErrorKey: boolean;
  aggregateText: string | null;
  aggregateHasErrorKey: boolean;
  aggregateUsageTotal: number | null;
  aggregateModelVersion: string | null;
  aggregateResponseId: string | null;
  threw: { isAIError: boolean; code: string | null; message: string } | null;
}

async function runModelStream(
  model: ReturnType<typeof getGenerativeModel>,
): Promise<StreamSummary> {
  const yieldedTexts: string[] = [];
  let yieldedChunkCount = 0;
  let anyChunkHasErrorKey = false;
  try {
    const result = await model.generateContentStream('probe mid-stream error');
    result.response.catch(() => undefined);
    for await (const chunk of result.stream) {
      yieldedChunkCount += 1;
      if ('error' in (chunk as unknown as Record<string, unknown>)) {
        anyChunkHasErrorKey = true;
      }
      yieldedTexts.push(chunk.text());
    }
    const aggregate = await result.response;
    return {
      yieldedTexts,
      yieldedChunkCount,
      anyChunkHasErrorKey,
      aggregateText: aggregate.text(),
      aggregateHasErrorKey: 'error' in (aggregate as unknown as Record<string, unknown>),
      aggregateUsageTotal: aggregate.usageMetadata?.totalTokenCount ?? null,
      aggregateModelVersion:
        (aggregate as { modelVersion?: string }).modelVersion ?? null,
      aggregateResponseId: (aggregate as { responseId?: string }).responseId ?? null,
      threw: null,
    };
  } catch (err) {
    return {
      yieldedTexts,
      yieldedChunkCount,
      anyChunkHasErrorKey,
      aggregateText: null,
      aggregateHasErrorKey: false,
      aggregateUsageTotal: null,
      aggregateModelVersion: null,
      aggregateResponseId: null,
      threw: {
        isAIError: err instanceof AIError,
        code: err instanceof AIError ? err.code : null,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function makeSandboxGeminiModel(
  frames: string | string[] | Uint8Array[],
  apiKey = 'synthetic-key-1753',
) {
  const sandbox = initializeSandbox();
  const ai = getAI(sandbox, {
    engine: {
      kind: 'gemini',
      apiKey,
      baseUrl: 'http://127.0.0.1:19999',
      fetch: makeSseFetch(frames),
    },
  });
  return {
    model: getGenerativeModel(ai, { model: MODEL }),
    dispose: () => sandbox.dispose(),
  };
}

/**
 * Worker/hosted transport plane backed by GeminiEngine and pack/unpack evidence
 * framing (matching `host-ai.ts` over MessagePort/WebSocket).
 */
function makeTransportGeminiModel(
  frames: string | string[] | Uint8Array[],
  apiKey = 'synthetic-key-1753',
) {
  const engine = new GeminiEngine({
    apiKey,
    baseUrl: 'http://127.0.0.1:19999',
    fetch: makeSseFetch(frames),
  });
  const ai = createTransportAI(makeFakeApp(`transport-1753-${Math.random()}`), undefined, {
    generateContent: (req, model, appCheck, opts) =>
      engine.generateContent(req, model, appCheck, opts),
    streamGenerateContent: (req, model, appCheck, opts) =>
      (async function* transportStream(): AsyncGenerator<WireChunk> {
        for await (const chunk of engine.streamGenerateContent(req, model, appCheck, opts)) {
          const packed = packAiEvidence(chunk as object);
          yield unpackAiEvidence(structuredClone(packed)) as WireChunk;
        }
      })(),
    countTokens: (req, model, appCheck, opts) => engine.countTokens(req, model, appCheck, opts),
  });
  return {
    model: getGenerativeModel(ai, { model: MODEL }),
    dispose: () => undefined,
  };
}

describe('mid-stream SSE error handling SDK parity and #3198 redaction preservation (#1753)', () => {
  it('matches installed @firebase/ai on object/array mid-stream error chunks and truncated frames across sandbox and transport planes', async () => {
    expect(midStreamProbe.pendingRowLink).toBe(true);
    expect(midStreamProbe.rowIds).toEqual([]);
    const observed = (await midStreamProbe.observe()) as {
      objectMidStreamError: {
        yieldedTexts: string[];
        yieldedChunkCount: number;
        aggregateText: string | null;
        threw: unknown;
      };
      arrayMidStreamError: {
        yieldedTexts: string[];
        yieldedChunkCount: number;
        aggregateText: string | null;
        threw: unknown;
      };
      trailingUnparsedFrame: {
        yieldedTexts: string[];
        yieldedChunkCount: number;
        aggregateText: string | null;
        threw: { isAIError: boolean; code: string | null } | null;
      };
    };

    for (const makePlane of [makeSandboxGeminiModel, makeTransportGeminiModel]) {
      const objPlane = makePlane(FIRST_CHUNK + OBJECT_ERROR_CHUNK + FINAL_CHUNK);
      try {
        const objRes = await runModelStream(objPlane.model);
        expect({
          yieldedTexts: objRes.yieldedTexts,
          yieldedChunkCount: objRes.yieldedChunkCount,
          aggregateText: objRes.aggregateText,
          threw: objRes.threw,
        }).toEqual(observed.objectMidStreamError);
        expect(objRes.anyChunkHasErrorKey).toBe(false);
        expect(objRes.aggregateHasErrorKey).toBe(false);
        expect(objRes.aggregateUsageTotal).toBe(6);
      } finally {
        objPlane.dispose();
      }

      const arrPlane = makePlane(FIRST_CHUNK + ARRAY_ERROR_CHUNK + FINAL_CHUNK);
      try {
        const arrRes = await runModelStream(arrPlane.model);
        expect({
          yieldedTexts: arrRes.yieldedTexts,
          yieldedChunkCount: arrRes.yieldedChunkCount,
          aggregateText: arrRes.aggregateText,
          threw: arrRes.threw,
        }).toEqual(observed.arrayMidStreamError);
        expect(arrRes.anyChunkHasErrorKey).toBe(false);
        expect(arrRes.aggregateHasErrorKey).toBe(false);
      } finally {
        arrPlane.dispose();
      }

      const secret = 'AIzaSy-TruncatedMidStreamSecret-1753';
      const truncPlane = makePlane(`${FIRST_CHUNK}data: {"error":"${secret}`, secret);
      try {
        const truncRes = await runModelStream(truncPlane.model);
        expect(truncRes.threw?.isAIError).toBe(observed.trailingUnparsedFrame.threw?.isAIError);
        expect(truncRes.threw?.code).toBe(AIErrorCode.PARSE_FAILED);
        expect(truncRes.threw?.message).not.toContain(secret);
      } finally {
        truncPlane.dispose();
      }
    }
  });

  it('drops leading, trailing, and standalone mid-stream error chunks without clobbering final stream metadata on both planes', async () => {
    const secret = 'AIzaSy-MidStreamDropSecret-1753';
    const secretErrFrame = `data: {"error":{"code":500,"message":"Quota failed for ${secret}","status":"INTERNAL"}}\r\n\r\n`;

    for (const makePlane of [makeSandboxGeminiModel, makeTransportGeminiModel]) {
      // Error first, then valid chunks across separate reads.
      const leading = makePlane([secretErrFrame, FIRST_CHUNK, FINAL_CHUNK], secret);
      try {
        const res = await runModelStream(leading.model);
        expect(res.threw).toBeNull();
        expect(res.yieldedTexts).toEqual(['alpha ', 'beta']);
        expect(res.yieldedChunkCount).toBe(2);
        expect(res.aggregateText).toBe('alpha beta');
        expect(res.anyChunkHasErrorKey).toBe(false);
        expect(res.aggregateHasErrorKey).toBe(false);
      } finally {
        leading.dispose();
      }

      // Error last: valid chunk is yielded once and its metadata survives on the aggregate.
      const trailing = makePlane([FIRST_CHUNK, secretErrFrame], secret);
      try {
        const res = await runModelStream(trailing.model);
        expect(res.threw).toBeNull();
        expect(res.yieldedTexts).toEqual(['alpha ']);
        expect(res.yieldedChunkCount).toBe(1);
        expect(res.aggregateText).toBe('alpha ');
        expect(res.anyChunkHasErrorKey).toBe(false);
        expect(res.aggregateHasErrorKey).toBe(false);
        expect(res.aggregateUsageTotal).toBe(5);
        expect(res.aggregateModelVersion).toBe('gemini-2.5-flash');
        expect(res.aggregateResponseId).toBe('resp-1753');
      } finally {
        trailing.dispose();
      }

      // Error-only 200 stream: 0 chunks yielded, empty aggregate, no throw, no secret leak.
      const onlyObj = makePlane(secretErrFrame, secret);
      try {
        const res = await runModelStream(onlyObj.model);
        expect(res.threw).toBeNull();
        expect(res.yieldedTexts).toEqual([]);
        expect(res.yieldedChunkCount).toBe(0);
        expect(res.aggregateText).toBe('');
        expect(res.aggregateHasErrorKey).toBe(false);
      } finally {
        onlyObj.dispose();
      }

      // Array-wrapped error-only 200 stream: 0 chunks yielded, empty aggregate.
      const onlyArr = makePlane(ARRAY_ERROR_CHUNK, secret);
      try {
        const res = await runModelStream(onlyArr.model);
        expect(res.threw).toBeNull();
        expect(res.yieldedTexts).toEqual([]);
        expect(res.yieldedChunkCount).toBe(0);
        expect(res.aggregateText).toBe('');
        expect(res.aggregateHasErrorKey).toBe(false);
      } finally {
        onlyArr.dispose();
      }
    }
  });

  it('matches @firebase/ai generateResponseSequence filtering for candidate-less and metadata-only frames', async () => {
    const emptyCand = 'data: {"candidates":[]}\r\n\r\n';
    const bareCand = 'data: {"candidates":[{"index":0}]}\r\n\r\n';
    const usageOnly =
      'data: {"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":3,"totalTokenCount":7}}\r\n\r\n';
    const citationOnly =
      'data: {"candidates":[{"index":0,"citationMetadata":{"citations":[{"uri":"https://example.test/ref"}]}}]}\r\n\r\n';
    const urlCtxOnly =
      'data: {"candidates":[{"index":0,"urlContextMetadata":{"urlMetadata":[]}}]}\r\n\r\n';
    const promptBlockOnly = 'data: {"promptFeedback":{"blockReason":"SAFETY"}}\r\n\r\n';

    const mixed = makeSandboxGeminiModel(
      FIRST_CHUNK + emptyCand + bareCand + citationOnly + urlCtxOnly + usageOnly,
    );
    try {
      const res = await runModelStream(mixed.model);
      expect(res.threw).toBeNull();
      // FIRST_CHUNK + citationOnly + urlCtxOnly are yieldable; emptyCand, bareCand, usageOnly are skipped.
      expect(res.yieldedChunkCount).toBe(3);
      expect(res.yieldedTexts).toEqual(['alpha ', '', '']);
      expect(res.aggregateText).toBe('alpha ');
      expect(res.aggregateUsageTotal).toBe(7);
    } finally {
      mixed.dispose();
    }

    // promptFeedback-only frame: skipped from result.stream, preserved on aggregate so response.text() throws.
    const blocked = makeSandboxGeminiModel(promptBlockOnly);
    try {
      const streamRes = await blocked.model.generateContentStream('blocked prompt');
      const yielded: WireResponse[] = [];
      for await (const chunk of streamRes.stream) yielded.push(chunk);
      expect(yielded).toHaveLength(0);
      const aggregate = await streamRes.response;
      expect(aggregate.promptFeedback?.blockReason).toBe('SAFETY');
      expect(() => aggregate.text()).toThrow('Response was blocked due to SAFETY');
    } finally {
      blocked.dispose();
    }
  });

  it('keeps ChatSession.sendMessageStream history clean when mid-stream error chunks occur', async () => {
    const withAnswer = makeSandboxGeminiModel(FIRST_CHUNK + OBJECT_ERROR_CHUNK + FINAL_CHUNK);
    try {
      const chat = withAnswer.model.startChat();
      const turn = await chat.sendMessageStream('hello');
      const texts: string[] = [];
      for await (const chunk of turn.stream) texts.push(chunk.text());
      expect(texts).toEqual(['alpha ', 'beta']);
      expect((await turn.response).text()).toBe('alpha beta');
      const history = await chat.getHistory();
      expect(history.map((entry) => entry.role)).toEqual(['user', 'model']);
      expect(history[1]?.parts.map((part) => part.text ?? '').join('')).toBe('alpha beta');
    } finally {
      withAnswer.dispose();
    }

    const errorOnly = makeSandboxGeminiModel(OBJECT_ERROR_CHUNK);
    try {
      const chat = errorOnly.model.startChat();
      const turn = await chat.sendMessageStream('hello');
      const chunks: unknown[] = [];
      for await (const chunk of turn.stream) chunks.push(chunk);
      expect(chunks).toEqual([]);
      expect((await turn.response).text()).toBe('');
      expect(await chat.getHistory()).toEqual([]);
    } finally {
      errorOnly.dispose();
    }
  });

  it('preserves #3198/#1600 mid-stream credential masking on GeminiEngine and maskStreamErrors', async () => {
    const secretKey = 'AIzaSy-MidStreamSecret-1753';
    const rawFrames =
      'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"part-1"}]}}]}\r\n\r\n' +
      `data: {"error":{"code":500,"message":"Upstream fault for ${secretKey}","status":"INTERNAL"}}\r\n\r\n`;

    const maskedText = await new Response(
      maskStreamErrors(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(rawFrames));
            controller.close();
          },
        }),
        [secretKey],
      ),
    ).text();
    expect(maskedText).not.toContain(secretKey);
    expect(maskedText).toContain('"Upstream fault for ***"');

    const engine = new GeminiEngine({
      apiKey: secretKey,
      baseUrl: 'http://127.0.0.1:19999',
      fetch: makeSseFetch(rawFrames),
    });

    const chunks: unknown[] = [];
    for await (const chunk of engine.streamGenerateContent(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      'gemini-2.5-flash',
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(JSON.stringify(chunks[1])).not.toContain(secretKey);
    expect(JSON.stringify(chunks[1])).toContain('Upstream fault for ***');
  });

  it('drops multi-line SSE JSON errors and frames split across CRLF and UTF-8 byte boundaries', async () => {
    const secret = 'AIzaSy-MultilineUtf8Secret-1753';
    const utf8Chunk =
      'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"price \\u20AC10 "}]}}]}\r\n\r\n';
    const multilineError =
      'event: error\r\n' +
      'data: {"error":\r\n' +
      `data: {"code":500,"message":"Fault for ${secret}","status":"INTERNAL"}}\r\n\r\n`;
    const fullBytes = new TextEncoder().encode(utf8Chunk + multilineError + FINAL_CHUNK);
    // Split mid-character (inside 3-byte UTF-8 sequence) and mid-CRLF (\r | \n).
    const splitParts: Uint8Array[] = [];
    for (let offset = 0; offset < fullBytes.length; offset += 7) {
      splitParts.push(fullBytes.subarray(offset, offset + 7));
    }

    const maskedWire = await new Response(
      maskStreamErrors(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of splitParts) controller.enqueue(part);
            controller.close();
          },
        }),
        [secret],
      ),
    ).text();
    expect(maskedWire).not.toContain(secret);
    expect(maskedWire).toContain('Fault for ***');

    for (const makePlane of [makeSandboxGeminiModel, makeTransportGeminiModel]) {
      const plane = makePlane(splitParts, secret);
      try {
        const res = await runModelStream(plane.model);
        expect(res.threw).toBeNull();
        expect(res.yieldedTexts).toEqual(['price \u20AC10 ', 'beta']);
        expect(res.yieldedChunkCount).toBe(2);
        expect(res.aggregateText).toBe('price \u20AC10 beta');
        expect(res.anyChunkHasErrorKey).toBe(false);
        expect(res.aggregateHasErrorKey).toBe(false);
      } finally {
        plane.dispose();
      }
    }
  });

  it('fails closed on promptFeedback followed by a trailing error frame and keeps sdkActivity clean', async () => {
    const secret = 'AIzaSy-ActivityPromptBlockSecret-1753';
    const promptBlock = 'data: {"promptFeedback":{"blockReason":"SAFETY"}}\r\n\r\n';
    const secretErr = `data: {"error":{"code":500,"message":"Quota failed for ${secret}","status":"INTERNAL"}}\r\n\r\n`;

    for (const makePlane of [makeSandboxGeminiModel, makeTransportGeminiModel]) {
      for (const trailingErr of [secretErr, ARRAY_ERROR_CHUNK]) {
        const blockedPlane = makePlane([promptBlock, trailingErr], secret);
        try {
          const streamRes = await blockedPlane.model.generateContentStream('blocked then err');
          const chunks: WireResponse[] = [];
          for await (const chunk of streamRes.stream) chunks.push(chunk);
          expect(chunks).toHaveLength(0);
          const aggregate = await streamRes.response;
          expect(aggregate.promptFeedback?.blockReason).toBe('SAFETY');
          expect('error' in (aggregate as unknown as Record<string, unknown>)).toBe(false);
          expect(() => aggregate.text()).toThrow('Response was blocked due to SAFETY');
        } finally {
          blockedPlane.dispose();
        }
      }
    }

    // Verify sdkActivity preserves backend usage evidence and never leaks secrets or error envelopes.
    const endedRecords: SdkActivityRecord[] = [];
    const unsubscribe = sdkActivity.subscribe((event) => {
      if (event.phase === 'end' && event.record.service === 'ai') {
        endedRecords.push(event.record);
      }
    });
    const plane = makeSandboxGeminiModel([FIRST_CHUNK, secretErr], secret);
    try {
      const res = await runModelStream(plane.model);
      expect(res.threw).toBeNull();
      expect(res.aggregateText).toBe('alpha ');
      const record = endedRecords[endedRecords.length - 1];
      expect(record).toBeDefined();
      expect(record?.status).toBe('completed');
      expect(record?.ai?.usageSource).toBe('backend');
      expect(record?.ai?.totalTokens).toBe(5);
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('Quota failed');
    } finally {
      unsubscribe();
      plane.dispose();
    }
  });
});
