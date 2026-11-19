import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { CustomProvider, initializeAppCheck } from 'pyric/app-check';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
);

interface GenerateEnvelopeBehavior {
  wireEnvelope: {
    topLevelKeySet: string[];
    candidateKeySet: string[];
    candidateWireIndex: number;
    contentRole: string;
    contentKeySet: string[];
    finishReason: string;
    usageKeySet: string[];
    usageServiceTierPresent: boolean;
    modelVersionNonEmptyString: boolean;
    responseIdNonEmptyString: boolean;
  };
  enhancedResponse: {
    helperTextIsNonEmptyString: boolean;
    helperInlineDataPartsIsUndefined: boolean;
    helperFunctionCallsIsUndefined: boolean;
  };
}

interface StructuredSystemThinkingBehavior {
  systemInstruction: {
    wireTopLevelKeySet: string[];
    finishReason: string;
  };
  structuredOutput: {
    outboundResponseSchema: Record<string, unknown>;
    parsedKeySet: string[];
    finishReason: string;
  };
  thinking: {
    anyThoughtPart: boolean;
    anyThoughtSignature: boolean;
    helperThoughtSummaryIsUndefined: boolean;
    finishReason: string;
  };
}

interface FunctionCallsHelperBehavior {
  wireFunctionCall: {
    functionCallKeySet: string[];
    hasThoughtSignature: boolean;
    finishReason: string;
  };
  helperFunctionCalls: {
    isArray: boolean;
    count: number;
    firstName: string;
    argsIsPlainObject: boolean;
    argsHasCityString: boolean;
    inlineDataPartsIsUndefined: boolean;
  };
}

function loadObservation<T>(fileName: string): T {
  const raw = readFileSync(join(OBS_DIR, fileName), 'utf8');
  const parsed = JSON.parse(raw) as { behavior: T };
  return parsed.behavior;
}

function dataKeysOf(response: object): string[] {
  return Object.keys(response)
    .filter((key) => typeof (response as Record<string, unknown>)[key] !== 'function')
    .sort();
}

let appSeq = 0;

describe('served AI entry and SharedWorker generateContent, Schema, and response-helper parity', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  it('replays unary envelope, structured output, thinking, and functionCalls() across SharedWorker MessagePort', async () => {
    const genFacts = loadObservation<GenerateEnvelopeBehavior>(
      'ai-sdk-generate-envelope-and-string-request.json',
    );
    const structFacts = loadObservation<StructuredSystemThinkingBehavior>(
      'ai-sdk-structured-system-and-thinking.json',
    );
    const fnFacts = loadObservation<FunctionCallsHelperBehavior>(
      'ai-sdk-response-helpers-functioncalls.json',
    );

    const ctx = await makeHostCtx();
    const inboundAiOps: InboundMessage[] = [];
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          const msg = event.data as InboundMessage;
          if (msg.t === 'op' && msg.method.startsWith('ai.')) {
            inboundAiOps.push(msg);
          }
          void handleMessage(ctx, hostPortLike, msg);
        };
        this.port = clientPort;
      }
    };

    const servedAi = await import('../../../src/serve/entries/ai.js');
    appSeq += 1;
    const app = createAppForSandbox(
      ctx.sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-worker-wave2',
        appId: '1:100000000000:web:deadbeef0022',
      },
      `worker-ai-wave2-${appSeq}`,
    );
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          const minted = await mintAppCheckToken(
            {
              appId: '1:100000000000:web:deadbeef0022',
              projectId: 'demo-ai-worker-wave2',
            },
            3600,
          );
          return {
            token: minted.token,
            expireTimeMillis: Date.now() + 3_600_000,
          };
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });

    try {
      const ai = servedAi.getAI(app);
      const model = servedAi.getGenerativeModel(ai, { model: 'gemini-flash-lite-latest' });

      const unary = await model.generateContent('Reply with one word: pong');
      expect(inboundAiOps.length).toBe(1);
      const response = unary.response;
      expect(dataKeysOf(response)).toEqual(genFacts.wireEnvelope.topLevelKeySet);

      const candidate = response.candidates?.[0];
      expect(candidate).toBeDefined();
      if (!candidate) {
        throw new Error('Expected candidate over SharedWorker');
      }
      expect(Object.keys(candidate).sort()).toEqual(genFacts.wireEnvelope.candidateKeySet);
      expect(candidate.index).toBe(genFacts.wireEnvelope.candidateWireIndex);
      expect(candidate.content?.role).toBe(genFacts.wireEnvelope.contentRole);
      expect(Object.keys(candidate.content ?? {}).sort()).toEqual(
        genFacts.wireEnvelope.contentKeySet,
      );
      expect(candidate.finishReason).toBe(genFacts.wireEnvelope.finishReason);

      const usage = response.usageMetadata;
      expect(Object.keys(usage ?? {}).sort()).toEqual(genFacts.wireEnvelope.usageKeySet);
      expect(usage !== undefined && 'serviceTier' in usage).toBe(
        genFacts.wireEnvelope.usageServiceTierPresent,
      );
      expect(typeof response.modelVersion === 'string' && response.modelVersion.length > 0).toBe(
        genFacts.wireEnvelope.modelVersionNonEmptyString,
      );
      expect(typeof response.responseId === 'string' && response.responseId.length > 0).toBe(
        genFacts.wireEnvelope.responseIdNonEmptyString,
      );
      expect(response.text().length > 0).toBe(genFacts.enhancedResponse.helperTextIsNonEmptyString);
      expect(response.inlineDataParts() === undefined).toBe(
        genFacts.enhancedResponse.helperInlineDataPartsIsUndefined,
      );
      expect(response.functionCalls() === undefined).toBe(
        genFacts.enhancedResponse.helperFunctionCallsIsUndefined,
      );

      const sysResult = await model.generateContent({
        systemInstruction: 'Answer in lowercase.',
        contents: [{ role: 'user', parts: [{ text: 'Say pong.' }] }],
      });
      expect(dataKeysOf(sysResult.response)).toEqual(
        structFacts.systemInstruction.wireTopLevelKeySet,
      );
      expect(sysResult.response.candidates?.[0]?.finishReason).toBe(
        structFacts.systemInstruction.finishReason,
      );

      const wordSchema = servedAi.Schema.object({
        properties: {
          word: servedAi.Schema.string(),
        },
      });
      expect(JSON.parse(JSON.stringify(wordSchema))).toEqual(
        structFacts.structuredOutput.outboundResponseSchema,
      );
      const schemaResult = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'Give one English word for water.' }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: wordSchema,
        },
      });
      const parsedJson = JSON.parse(schemaResult.response.text()) as Record<string, unknown>;
      expect(Object.keys(parsedJson).sort()).toEqual(structFacts.structuredOutput.parsedKeySet);
      expect(schemaResult.response.candidates?.[0]?.finishReason).toBe(
        structFacts.structuredOutput.finishReason,
      );

      const thinkingResult = await model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: 'A basket has 9 apples. You take 2. How many remain?' }],
          },
        ],
        generationConfig: {
          thinkingConfig: { includeThoughts: true },
        },
      });
      const thinkingParts = thinkingResult.response.candidates?.[0]?.content?.parts ?? [];
      expect(thinkingParts.some((part) => part.thought === true)).toBe(
        structFacts.thinking.anyThoughtPart,
      );
      expect(
        thinkingParts.some(
          (part) => typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0,
        ),
      ).toBe(structFacts.thinking.anyThoughtSignature);
      expect(thinkingResult.response.thoughtSummary() === undefined).toBe(
        structFacts.thinking.helperThoughtSummaryIsUndefined,
      );

      const fnResult = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'What is the weather in Paris?' }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Look up weather for a city',
                parameters: servedAi.Schema.object({
                  properties: {
                    city: servedAi.Schema.string(),
                  },
                }),
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: servedAi.FunctionCallingMode.ANY,
          },
        },
      });
      const fnParts = fnResult.response.candidates?.[0]?.content?.parts ?? [];
      const wireFnPart = fnParts.find((part) => part.functionCall !== undefined);
      expect(Object.keys(wireFnPart?.functionCall ?? {}).sort()).toEqual(
        fnFacts.wireFunctionCall.functionCallKeySet,
      );
      expect(wireFnPart !== undefined && 'thoughtSignature' in wireFnPart).toBe(
        fnFacts.wireFunctionCall.hasThoughtSignature,
      );
      expect(fnResult.response.candidates?.[0]?.finishReason).toBe(
        fnFacts.wireFunctionCall.finishReason,
      );

      const calls = fnResult.response.functionCalls();
      expect(Array.isArray(calls)).toBe(fnFacts.helperFunctionCalls.isArray);
      const callList = calls ?? [];
      expect(callList.length).toBe(fnFacts.helperFunctionCalls.count);
      expect(callList[0]?.name).toBe(fnFacts.helperFunctionCalls.firstName);
      const args = callList[0]?.args;
      const isPlainObject =
        args !== undefined && args !== null && typeof args === 'object' && !Array.isArray(args);
      expect(isPlainObject).toBe(fnFacts.helperFunctionCalls.argsIsPlainObject);
      expect(typeof args?.city === 'string').toBe(fnFacts.helperFunctionCalls.argsHasCityString);
      expect(fnResult.response.inlineDataParts() === undefined).toBe(
        fnFacts.helperFunctionCalls.inlineDataPartsIsUndefined,
      );
      expect(inboundAiOps.length).toBe(5);
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });
});
