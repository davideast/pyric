import { FirebaseError, deleteApp, initializeApp } from 'firebase/app';
import {
  AIError,
  AIErrorCode,
  ChatSession,
  POSSIBLE_ROLES,
  getAI,
  getGenerativeModel,
} from 'firebase/ai';
import type { Probe } from '../../rigs/types.ts';

interface ObservedThrow {
  threw: boolean;
  isAIError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  name: string | null;
}

function captureErrorShape(err: unknown): ObservedThrow {
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
    isAIError: err instanceof AIError,
    isFirebaseError: err instanceof FirebaseError,
    code,
    name,
  };
}

function observeSyncCall(fn: () => unknown): ObservedThrow {
  try {
    fn();
    return { threw: false, isAIError: false, isFirebaseError: false, code: null, name: null };
  } catch (err) {
    return captureErrorShape(err);
  }
}

async function observeAsyncCall(fn: () => Promise<unknown>): Promise<ObservedThrow> {
  try {
    await fn();
    return { threw: false, isAIError: false, isFirebaseError: false, code: null, name: null };
  } catch (err) {
    return captureErrorShape(err);
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: 'ai#generate-abort-signal',
  rowIds: [
    'ai#generate-abort-signal',
    'ai#chat-startchat',
    'ai#chat-role-vocabulary',
    'ai#error-aierror-shape',
    'ai#error-code-vocabulary',
  ],
  description:
    'Pure offline firebase/ai pre-aborted SingleRequestOptions.signal rejection before fetch, startChat seeded history and validateChatHistory guards, POSSIBLE_ROLES vocabulary, and AIErrorCode / AIError constructor contract with zero network calls.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in offline AI probe');
      },
      { preconnect: originalFetch.preconnect },
    );

    const app = initializeApp(
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-offline',
        appId: '1:100000000000:web:deadbeef0010',
      },
      'ai-offline-chat-errors-abort',
    );

    try {
      const model = getGenerativeModel(getAI(app), { model: 'gemini-flash-lite-latest' });

      const controller = new AbortController();
      controller.abort();
      const abortContentRequest = await observeAsyncCall(() =>
        model.generateContent(
          { contents: [{ role: 'user', parts: [{ text: 'never delivered' }] }] },
          { signal: controller.signal },
        ),
      );
      const abortStringRequest = await observeAsyncCall(() =>
        model.generateContent('never delivered', { signal: AbortSignal.abort() }),
      );

      const defaultChat = model.startChat();
      const defaultHistory = await defaultChat.getHistory();

      const seededTurns = [
        { role: 'user' as const, parts: [{ text: 'hi' }] },
        {
          role: 'model' as const,
          parts: [{ functionCall: { name: 'greet', args: { target: 'world' } } }],
        },
        {
          role: 'function' as const,
          parts: [{ functionResponse: { name: 'greet', response: { ok: true } } }],
        },
      ];
      const seededChat = model.startChat({ history: seededTurns });
      const seededHistory = await seededChat.getHistory();

      const emptyPartsHistoryThrow = observeSyncCall(() =>
        model.startChat({ history: [{ role: 'user', parts: [] }] }),
      );
      const modelFirstHistoryThrow = observeSyncCall(() =>
        model.startChat({ history: [{ role: 'model', parts: [{ text: 'first' }] }] }),
      );

      const errorCodesSorted = Object.values(AIErrorCode).slice().sort();
      const constructedError = new AIError(AIErrorCode.FETCH_ERROR, 'sample failure', {
        status: 400,
        statusText: 'Bad Request',
        errorDetails: [{ reason: 'API_KEY_INVALID' }],
      });

      return {
        fetchCalls,
        abortSignal: {
          abortContentRequest,
          abortStringRequest,
        },
        startChat: {
          isChatSession: seededChat instanceof ChatSession,
          defaultHistoryLength: defaultHistory.length,
          seededRoles: seededHistory.map((entry) => entry.role),
          seededHistoryMatchesInput: JSON.stringify(seededHistory) === JSON.stringify(seededTurns),
          emptyPartsHistoryThrow,
          modelFirstHistoryThrow,
        },
        possibleRoles: [...POSSIBLE_ROLES],
        errorVocabulary: {
          codeCount: errorCodesSorted.length,
          codesSorted: errorCodesSorted,
          constructedIsAIError: constructedError instanceof AIError,
          constructedIsFirebaseError: constructedError instanceof FirebaseError,
          constructedCode: constructedError.code,
          constructedCustomErrorData: constructedError.customErrorData ?? null,
        },
      };
    } finally {
      globalThis.fetch = originalFetch;
      await deleteApp(app);
    }
  },
};
