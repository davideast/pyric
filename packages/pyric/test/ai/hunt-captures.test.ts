/**
 * Replays the App Check and AI Logic hunt's `ai-request-edge-` captures
 * through `pyric/ai` and the sandbox `AiBroker`.
 */
import { describe, expect, test } from 'bun:test';
import {
  AIError,
  getAI,
  getGenerativeModel,
  type GenerateContentRequest,
} from '../../src/ai/index.js';
import { deleteApp } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import { CustomProvider, initializeAppCheck } from '../../src/app-check/index.js';
import { AiBroker, AiBrokerError } from '../../src/ai/broker/index.js';
import { mintAppCheckToken } from '../../src/sandbox/internal/app-check-token.js';
import { initializeSandbox } from 'pyric/sandbox';
import {
  replayMismatches,
  type Behavior,
} from '../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import { dataKeys, observedBehavior } from './support.ts';

interface EdgeRequest {
  model: string;
  body: {
    contents: Array<{ role?: string; parts: Array<{ text: string }> }>;
    systemInstruction?: string;
  };
}

type Outcome = { outcome: 'answered' | 'refused'; httpStatus: number };

function productionOutcome(name: string): Outcome & {
  request: EdgeRequest;
  facts: Record<string, unknown>;
} {
  const facts = observedBehavior(name) as Record<string, unknown> & {
    httpStatus: number;
    request: EdgeRequest;
  };
  let outcome: Outcome['outcome'] = 'refused';
  if (facts.httpStatus === 200) {
    outcome = 'answered';
  }
  return { outcome, httpStatus: facts.httpStatus, request: facts.request, facts };
}

async function pyricOutcome(call: () => Promise<unknown>): Promise<{
  outcome: Outcome;
  error?: AIError;
}> {
  try {
    await call();
    return { outcome: { outcome: 'answered', httpStatus: 200 } };
  } catch (err) {
    const aiError = err as AIError;
    const rawStatus = aiError.customErrorData?.status;
    let httpStatus = 0;
    if (typeof rawStatus === 'number') {
      httpStatus = rawStatus;
    }
    return {
      outcome: { outcome: 'refused', httpStatus },
      error: aiError,
    };
  }
}

function compare(production: Outcome, pyric: Outcome): string[] {
  return replayMismatches({
    production: {
      outcome: production.outcome,
      httpStatus: production.httpStatus,
    } as Behavior,
    pyric: pyric as unknown as Behavior,
    pins: [],
  });
}

describe('ai-request-edge replays', () => {
  test('ai-request-edge-roleless-contents: contents with no role succeed across unary, stream, and countTokens (AI-21)', async () => {
    const production = productionOutcome('ai-request-edge-roleless-contents');
    const sandbox = initializeSandbox();
    try {
      const targetModel = getGenerativeModel(getAI(sandbox), {
        model: production.request.model,
      });
      const request = production.request.body as unknown as GenerateContentRequest;

      const unary = await targetModel.generateContent(request);
      expect(compare(production, { outcome: 'answered', httpStatus: 200 })).toEqual([]);
      expect(dataKeys(unary.response)).toEqual(
        [...(production.facts.topLevelKeySet as string[])].sort(),
      );
      expect(unary.response.candidates?.length).toBe(production.facts.candidateCount);
      const firstCandidate = unary.response.candidates?.[0];
      expect(firstCandidate?.finishReason).toBe(production.facts.finishReason);
      expect(firstCandidate?.content.role).toBe(production.facts.contentRole);
      const partKeys = (firstCandidate?.content.parts ?? []).map((part) =>
        Object.keys(part).sort(),
      );
      expect(partKeys).toEqual(production.facts.partKeySets);

      const streamed = await targetModel.generateContentStream(request);
      const chunks: unknown[] = [];
      for await (const chunk of streamed.stream) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      const aggregated = await streamed.response;
      expect(aggregated.candidates?.[0]?.finishReason).toBe(production.facts.finishReason);

      const counted = await targetModel.countTokens(request);
      expect(counted.totalTokens).toBeGreaterThan(0);
    } finally {
      sandbox.dispose();
    }
  });

  test('ai-request-edge-string-system-instruction: wire broker refuses raw string while ChatSession wraps into Content (AI-22)', async () => {
    const production = productionOutcome('ai-request-edge-string-system-instruction');
    const rawBody = production.request.body;

    // 1. Raw wire contract captured by ai-request-edge-probes.ts: a top-level string
    // systemInstruction on the Gemini wire fails 400 INVALID_ARGUMENT with BadRequest details.
    const broker = new AiBroker({ validateModels: true });
    let wireEnvelope: AiBrokerError['envelope'] | undefined;
    try {
      await broker.generateContent(
        rawBody as unknown as Parameters<AiBroker['generateContent']>[0],
        production.request.model,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(AiBrokerError);
      wireEnvelope = (err as AiBrokerError).envelope;
    }
    expect(wireEnvelope).toEqual(production.facts.raw);

    // 2. SDK ChatSession contract in installed @firebase/ai@2.16.0 (firebase@12.19.0):
    // startChat wraps string and Part systemInstruction inputs via formatSystemInstruction.
    const sandbox = initializeSandbox();
    try {
      const ai = getAI(sandbox);
      const targetModel = getGenerativeModel(ai, { model: production.request.model });
      let systemInstruction = '';
      if (typeof rawBody.systemInstruction === 'string') {
        systemInstruction = rawBody.systemInstruction;
      }
      let prompt = '';
      const firstText = rawBody.contents[0]?.parts[0]?.text;
      if (typeof firstText === 'string') {
        prompt = firstText;
      }

      const chat = targetModel.startChat({ systemInstruction });
      expect(chat.params?.systemInstruction).toEqual({
        role: 'system',
        parts: [{ text: systemInstruction }],
      });
      const reply = await chat.sendMessage(prompt);
      expect(reply.response.candidates?.[0]?.finishReason).toBe('STOP');

      const streamReply = await chat.sendMessageStream(prompt);
      for await (const _chunk of streamReply.stream) {
        // Drain stream chunks.
      }
      expect((await streamReply.response).candidates?.[0]?.finishReason).toBe('STOP');
      expect((await chat.getHistory()).length).toBe(4);
    } finally {
      sandbox.dispose();
    }
  });

  test('ai-request-edge-model-gemini-pro: gemini-pro fails 404 NOT_FOUND after App Check and emits request_rejected (AI-23)', async () => {
    const production = productionOutcome('ai-request-edge-model-gemini-pro');
    const request = production.request.body as unknown as GenerateContentRequest;
    const options = {
      apiKey: 'demo-api-key',
      appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
      projectId: 'demo-ai-edge',
    };

    // Without App Check, an enforced project refuses with 401 UNAUTHENTICATED before model lookup.
    const unauthSandbox = initializeSandbox();
    const unauthApp = createAppForSandbox(unauthSandbox, options, 'ai-edge-unauth');
    try {
      const unauthModel = getGenerativeModel(getAI(unauthApp), {
        model: production.request.model,
      });
      const unauthResult = await pyricOutcome(() => unauthModel.generateContent(request));
      expect(unauthResult.outcome).toEqual({ outcome: 'refused', httpStatus: 401 });
    } finally {
      await deleteApp(unauthApp);
      unauthSandbox.dispose();
    }

    // With valid App Check, gemini-pro reaches the broker, emits request_rejected (404),
    // and surfaces the captured 404 NOT_FOUND message across unary, stream, and countTokens.
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(sandbox, options, 'ai-edge-authed');
    const rejectedOps: Array<Record<string, unknown>> = [];
    const stopEvents = sandbox.onEvent((event) => {
      if (event.kind === 'service_mutation' && event.service === 'ai' && event.op === 'request_rejected') {
        rejectedOps.push(event.detail);
      }
    });
    try {
      initializeAppCheck(app, {
        provider: new CustomProvider({
          getToken: () =>
            mintAppCheckToken({ appId: options.appId, projectId: options.projectId }, 3600),
        }),
      });
      const geminiProModel = getGenerativeModel(getAI(app), {
        model: production.request.model,
      });

      const unary = await pyricOutcome(() => geminiProModel.generateContent(request));
      expect(compare(production, unary.outcome)).toEqual([]);
      expect(unary.error?.message).toContain(String(production.facts.messageText));
      expect(unary.error?.customErrorData?.errorDetails ?? []).toEqual([]);

      const streamOutcome = await pyricOutcome(() =>
        geminiProModel.generateContentStream(request),
      );
      expect(streamOutcome.outcome).toEqual({ outcome: 'refused', httpStatus: 404 });

      const countOutcome = await pyricOutcome(() => geminiProModel.countTokens(request));
      expect(countOutcome.outcome).toEqual({ outcome: 'refused', httpStatus: 404 });

      expect(rejectedOps.length).toBe(3);
      expect(rejectedOps[0]).toMatchObject({
        code: 404,
        status: 'NOT_FOUND',
        message: production.facts.messageText,
      });
    } finally {
      stopEvents();
      await deleteApp(app);
      sandbox.dispose();
    }
  });
});
