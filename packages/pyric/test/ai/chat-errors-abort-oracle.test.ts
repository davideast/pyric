/**
 * Oracle conformance replay for `ai-offline-chat-roles-errors-and-abort`:
 *   - `ai#generate-abort-signal` (AI-GENERATE-ABORT-SIGNAL)
 *   - `ai#chat-startchat` (AI-CHAT-STARTCHAT)
 *   - `ai#chat-role-vocabulary` (AI-CHAT-ROLE-VOCABULARY)
 *   - `ai#error-aierror-shape` (AI-ERROR-AIERROR-SHAPE)
 *   - `ai#error-code-vocabulary` (AI-ERROR-CODE-VOCABULARY)
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirebaseError } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import {
  AIError,
  AIErrorCode,
  ChatSession,
  POSSIBLE_ROLES,
  getAI,
  getGenerativeModel,
} from 'pyric/ai';

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

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
  'ai-offline-chat-roles-errors-and-abort.json',
);

function loadChatErrorsAbortObservation(): ChatErrorsAbortBehavior {
  const parsed = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as {
    behavior: ChatErrorsAbortBehavior;
  };
  return parsed.behavior;
}

function captureErrorShape(err: unknown): ObservedThrowShape {
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

function observeSyncCall(fn: () => unknown): ObservedThrowShape {
  try {
    fn();
    return { threw: false, isAIError: false, isFirebaseError: false, code: null, name: null };
  } catch (err) {
    return captureErrorShape(err);
  }
}

async function observeAsyncCall(fn: () => Promise<unknown>): Promise<ObservedThrowShape> {
  try {
    await fn();
    return { threw: false, isAIError: false, isFirebaseError: false, code: null, name: null };
  } catch (err) {
    return captureErrorShape(err);
  }
}

describe('oracle replay: ai-offline-chat-roles-errors-and-abort', () => {
  it('replays pre-aborted SingleRequestOptions.signal rejection before fetch (ai#generate-abort-signal)', async () => {
    const facts = loadChatErrorsAbortObservation();
    expect(facts.fetchCalls).toBe(0);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in abort-signal replay');
      },
      { preconnect: originalFetch.preconnect },
    );

    const sandbox = initializeSandbox();
    try {
      const model = getGenerativeModel(getAI(sandbox), { model: 'gemini-flash-lite-latest' });

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

      expect(abortContentRequest).toEqual(facts.abortSignal.abortContentRequest);
      expect(abortStringRequest).toEqual(facts.abortSignal.abortStringRequest);
      expect(fetchCalls).toBe(facts.fetchCalls);
    } finally {
      globalThis.fetch = originalFetch;
      sandbox.dispose();
    }
  });

  it('replays startChat seeded history and validateChatHistory guards (ai#chat-startchat)', async () => {
    const facts = loadChatErrorsAbortObservation();
    const sandbox = initializeSandbox();
    try {
      const model = getGenerativeModel(getAI(sandbox), { model: 'gemini-flash-lite-latest' });

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

      expect({
        isChatSession: seededChat instanceof ChatSession,
        defaultHistoryLength: defaultHistory.length,
        seededRoles: seededHistory.map((entry) => entry.role),
        seededHistoryMatchesInput: JSON.stringify(seededHistory) === JSON.stringify(seededTurns),
        emptyPartsHistoryThrow,
        modelFirstHistoryThrow,
      }).toEqual(facts.startChat);
    } finally {
      sandbox.dispose();
    }
  });

  it('replays POSSIBLE_ROLES vocabulary (ai#chat-role-vocabulary)', () => {
    const facts = loadChatErrorsAbortObservation();
    expect([...POSSIBLE_ROLES]).toEqual(facts.possibleRoles);
  });

  it('replays AIErrorCode 14-code vocabulary and AIError constructor shape (ai#error-code-vocabulary, ai#error-aierror-shape)', () => {
    const facts = loadChatErrorsAbortObservation();
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

    expect({
      codeCount: errorCodesSorted.length,
      codesSorted: errorCodesSorted,
      constructedIsAIError: constructedError instanceof AIError,
      constructedIsFirebaseError: constructedError instanceof FirebaseError,
      constructedCode: constructedError.code,
      constructedCustomErrorData: customErrorData,
    }).toEqual(facts.errorVocabulary);
  });
});
