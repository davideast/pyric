import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirebaseError, deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { CustomProvider, initializeAppCheck } from 'pyric/app-check';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
  'ai-offline-chat-roles-errors-and-abort.json',
);

interface ObservedThrowShape {
  threw: boolean;
  isAIError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  name: string | null;
}

interface ChatErrorsAbortBehavior {
  fetchCalls: number;
  abortSignal: {
    abortContentRequest: ObservedThrowShape;
    abortStringRequest: ObservedThrowShape;
  };
  startChat: {
    isChatSession: boolean;
    defaultHistoryLength: number;
    seededRoles: string[];
    seededHistoryMatchesInput: boolean;
    emptyPartsHistoryThrow: ObservedThrowShape;
    modelFirstHistoryThrow: ObservedThrowShape;
  };
  possibleRoles: string[];
  errorVocabulary: {
    codeCount: number;
    codesSorted: string[];
    constructedIsAIError: boolean;
    constructedIsFirebaseError: boolean;
    constructedCode: string;
    constructedCustomErrorData: {
      status: number;
      statusText: string;
      errorDetails: Array<Record<string, unknown>>;
    } | null;
  };
}

function loadChatErrorsAbortObservation(): {
  fbSdkVersion: string;
  behavior: ChatErrorsAbortBehavior;
} {
  return JSON.parse(readFileSync(OBS_PATH, 'utf8')) as {
    fbSdkVersion: string;
    behavior: ChatErrorsAbortBehavior;
  };
}

function captureServedErrorShape(
  err: unknown,
  aiErrorCtor: abstract new (...args: never[]) => unknown,
): ObservedThrowShape {
  let code: string | null = null;
  let name: string | null = null;
  if (err && typeof err === 'object') {
    const record = err as { code?: unknown; name?: unknown };
    if (typeof record.code === 'string') {
      code = record.code;
    }
    if (typeof record.name === 'string') {
      name = record.name;
    }
  }
  return {
    threw: true,
    isAIError: err instanceof aiErrorCtor,
    isFirebaseError: err instanceof FirebaseError,
    code,
    name,
  };
}

function observeSyncServedCall(
  fn: () => unknown,
  aiErrorCtor: abstract new (...args: never[]) => unknown,
): ObservedThrowShape {
  try {
    fn();
    return { threw: false, isAIError: false, isFirebaseError: false, code: null, name: null };
  } catch (err) {
    return captureServedErrorShape(err, aiErrorCtor);
  }
}

async function observeAsyncServedCall(
  fn: () => Promise<unknown>,
  aiErrorCtor: abstract new (...args: never[]) => unknown,
): Promise<ObservedThrowShape> {
  try {
    await fn();
    return { threw: false, isAIError: false, isFirebaseError: false, code: null, name: null };
  } catch (err) {
    return captureServedErrorShape(err, aiErrorCtor);
  }
}

let appSeq = 0;

describe('served AI entry and SharedWorker chat, role, error, and abort parity', () => {
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

  async function setupServedAi() {
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
    return { ctx, inboundAiOps, servedAi };
  }

  it('replays ai-offline-chat-roles-errors-and-abort across served entries/ai without worker ops', async () => {
    const { fbSdkVersion, behavior: facts } = loadChatErrorsAbortObservation();
    const { ctx, inboundAiOps, servedAi } = await setupServedAi();
    const {
      AIError,
      AIErrorCode,
      POSSIBLE_ROLES,
      getAI,
      getGenerativeModel,
    } = servedAi;

    const app = createAppForSandbox(
      ctx.sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-offline',
        appId: '1:100000000000:web:deadbeef0010',
      },
      `served-ai-chat-abort-${++appSeq}`,
    );

    try {
      const model = getGenerativeModel(getAI(app), { model: 'gemini-flash-lite-latest' });

      const controller = new AbortController();
      controller.abort();
      const abortContentRequest = await observeAsyncServedCall(
        () =>
          model.generateContent(
            { contents: [{ role: 'user', parts: [{ text: 'never delivered', type: 'text' }] }] },
            { signal: controller.signal },
          ),
        AIError,
      );
      const abortStringRequest = await observeAsyncServedCall(
        () => model.generateContent('never delivered', { signal: AbortSignal.abort() }),
        AIError,
      );

      expect(abortContentRequest).toEqual(facts.abortSignal.abortContentRequest);
      expect(abortStringRequest).toEqual(facts.abortSignal.abortStringRequest);
      expect(inboundAiOps).toEqual([]);

      const defaultChat = model.startChat();
      const defaultHistory = await defaultChat.getHistory();

      const seededTurns = [
        { role: 'user' as const, parts: [{ text: 'hi', type: 'text' as const }] },
        {
          role: 'model' as const,
          parts: [
            {
              functionCall: { name: 'greet', args: { target: 'world' } },
              type: 'functionCall' as const,
            },
          ],
        },
        {
          role: 'function' as const,
          parts: [
            {
              functionResponse: { name: 'greet', response: { ok: true } },
              type: 'functionResponse' as const,
            },
          ],
        },
      ];
      const seededChat = model.startChat({ history: seededTurns });
      const seededHistory = await seededChat.getHistory();

      const emptyPartsHistoryThrow = observeSyncServedCall(
        () => model.startChat({ history: [{ role: 'user', parts: [] }] }),
        AIError,
      );
      const modelFirstHistoryThrow = observeSyncServedCall(
        () =>
          model.startChat({
            history: [{ role: 'model', parts: [{ text: 'first', type: 'text' }] }],
          }),
        AIError,
      );

      expect('ChatSession' in servedAi).toBe(false);
      expect({
        isChatSession:
          typeof seededChat.sendMessage === 'function' &&
          typeof seededChat.sendMessageStream === 'function' &&
          typeof seededChat.getHistory === 'function',
        defaultHistoryLength: defaultHistory.length,
        seededRoles: seededHistory.map((entry) => entry.role),
        seededHistoryMatchesInput: JSON.stringify(seededHistory) === JSON.stringify(seededTurns),
        emptyPartsHistoryThrow,
        modelFirstHistoryThrow,
      }).toEqual(facts.startChat);

      expect([...POSSIBLE_ROLES]).toEqual(facts.possibleRoles);

      const errorCodesSorted = Object.values(AIErrorCode).slice().sort();
      const constructedError = new AIError(AIErrorCode.FETCH_ERROR, 'sample failure', {
        status: 400,
        statusText: 'Bad Request',
        errorDetails: [{ reason: 'API_KEY_INVALID' }],
      });
      let customErrorData = null;
      if (constructedError.customErrorData !== undefined) {
        customErrorData = constructedError.customErrorData;
      }

      let expectedCodesSorted = facts.errorVocabulary.codesSorted;
      if (fbSdkVersion.startsWith('12.') && !expectedCodesSorted.includes('already-initialized')) {
        expectedCodesSorted = [...expectedCodesSorted, 'already-initialized'].sort();
      }

      expect({
        codeCount: errorCodesSorted.length,
        codesSorted: errorCodesSorted,
        constructedIsAIError: constructedError instanceof AIError,
        constructedIsFirebaseError: constructedError instanceof FirebaseError,
        constructedCode: constructedError.code,
        constructedCustomErrorData: customErrorData,
      }).toEqual({
        ...facts.errorVocabulary,
        codeCount: expectedCodesSorted.length,
        codesSorted: expectedCodesSorted,
      });
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });

  it('threads seeded ChatSession history across SharedWorker client and worker host ai.generateContent', async () => {
    const { ctx, inboundAiOps, servedAi } = await setupServedAi();
    const app = createAppForSandbox(
      ctx.sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-chat-worker',
        appId: '1:123456789012:web:abcdef',
      },
      `served-ai-chat-worker-${++appSeq}`,
    );
    try {
      initializeAppCheck(app, {
        provider: new CustomProvider({
          getToken: async () => {
            const minted = await mintAppCheckToken(
              { appId: '1:123456789012:web:abcdef', projectId: 'demo-ai-chat-worker' },
              3600,
            );
            return { token: minted.token, expireTimeMillis: Date.now() + 3_600_000 };
          },
        }),
        isTokenAutoRefreshEnabled: false,
      });
      const ai = servedAi.getAI(app, {
        engine: {
          kind: 'scripted',
          script: [{ respond: { text: 'welcome' } }],
        },
      });
      const model = servedAi.getGenerativeModel(ai, { model: 'gemini-flash-lite-latest' });
      const chat = model.startChat({
        history: [
          { role: 'user', parts: [{ text: 'hello', type: 'text' }] },
          { role: 'model', parts: [{ text: 'hi there', type: 'text' }] },
        ],
      });
      const reply = await chat.sendMessage('follow up');
      expect(reply.response.text()).toBe('welcome');
      expect(inboundAiOps.length).toBe(1);

      const updatedHistory = await chat.getHistory();
      expect(updatedHistory.map((entry) => entry.role)).toEqual([
        'user',
        'model',
        'user',
        'model',
      ]);
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });
});
