import { mintWithRetry } from '../../src/capture/app-check/mint.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import type { Probe } from '../../rigs/types.ts';

type DebugTokenGlobal = {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown;
};

interface ChatResponseLike {
  text(): string;
  candidates?: Array<{
    finishReason?: string;
    content?: {
      role?: string;
      parts?: Array<{ text?: string }>;
    };
  }>;
  usageMetadata?: unknown;
  modelVersion?: string;
  responseId?: string;
  inferenceSource?: string;
}

interface ChatHistoryTurnLike {
  role: string;
  parts: Array<{ text?: string }>;
}

interface ChatSessionLike {
  sendMessage(prompt: string): Promise<{ response: ChatResponseLike }>;
  sendMessageStream(prompt: string): Promise<{
    stream: AsyncIterable<ChatResponseLike>;
    response: Promise<ChatResponseLike>;
  }>;
  getHistory(): Promise<ChatHistoryTurnLike[]>;
}

export interface ChatSessionProbeModelSubject {
  startChat(): ChatSessionLike;
}

function finishReasonOf(response: ChatResponseLike): string | null {
  if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
    return null;
  }
  const first = response.candidates[0];
  if (!first || typeof first.finishReason !== 'string') {
    return null;
  }
  return first.finishReason;
}

function candidateRoleOf(response: ChatResponseLike): string | null {
  if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
    return null;
  }
  const first = response.candidates[0];
  if (!first || !first.content || typeof first.content.role !== 'string') {
    return null;
  }
  return first.content.role;
}

function joinedTurnText(turn: ChatHistoryTurnLike | undefined): string {
  if (!turn || !Array.isArray(turn.parts)) {
    return '';
  }
  const segments: string[] = [];
  for (const part of turn.parts) {
    if (typeof part.text === 'string') {
      segments.push(part.text);
    }
  }
  return segments.join('');
}

function nonFunctionOwnKeysSorted(target: ChatResponseLike): string[] {
  const record = target as unknown as Record<string, unknown>;
  return Object.keys(record)
    .filter((key) => typeof record[key] !== 'function')
    .sort();
}

export async function observeChatSessionSendAndStream(
  model: ChatSessionProbeModelSubject,
): Promise<Record<string, unknown>> {
  const sendChat = model.startChat();
  const sendResult = await sendChat.sendMessage('Reply with the single word: alpha');
  const sendResponse = sendResult.response;
  const historyFirstRead = await sendChat.getHistory();
  const historySecondRead = await sendChat.getHistory();

  const wireFourKeysPresent =
    Array.isArray(sendResponse.candidates) &&
    sendResponse.candidates.length > 0 &&
    sendResponse.usageMetadata !== undefined &&
    typeof sendResponse.modelVersion === 'string' &&
    sendResponse.modelVersion.length > 0 &&
    typeof sendResponse.responseId === 'string' &&
    sendResponse.responseId.length > 0;

  const streamChat = model.startChat();
  const streamResult = await streamChat.sendMessageStream(
    'Count from 1 to 25, digits separated by spaces, nothing else.',
  );
  const streamIterator = (streamResult.stream as { [Symbol.asyncIterator]?: unknown })[
    Symbol.asyncIterator
  ];
  const responseThen = (streamResult.response as { then?: unknown }).then;

  const streamedTexts: string[] = [];
  let streamChunkCount = 0;
  for await (const chunk of streamResult.stream) {
    streamChunkCount += 1;
    streamedTexts.push(chunk.text());
  }
  const streamAggregate = await streamResult.response;
  const historyAfterStream = await streamChat.getHistory();
  const lastTurnAfterStream = historyAfterStream[historyAfterStream.length - 1];

  return {
    model: 'gemini-flash-lite-latest',
    sendMessage: {
      wireFourKeysPresent,
      nonFunctionOwnKeysSorted: nonFunctionOwnKeysSorted(sendResponse),
      candidateRole: candidateRoleOf(sendResponse),
      finishReason: finishReasonOf(sendResponse),
      textHelperNonEmpty: sendResponse.text().trim().length > 0,
      historyLengthAfterSend: historyFirstRead.length,
      historyRolesAfterSend: historyFirstRead.map((turn) => turn.role),
      getHistoryReturnsSameArrayReference: historyFirstRead === historySecondRead,
    },
    sendMessageStream: {
      hasAsyncIterableStream: typeof streamIterator === 'function',
      hasResponsePromise: typeof responseThen === 'function',
      chunkCountAtLeastOne: streamChunkCount >= 1,
      aggregateFinishReason: finishReasonOf(streamAggregate),
      aggregateCandidateRole: candidateRoleOf(streamAggregate),
      aggregateTextMatchesConcatenatedChunks:
        streamAggregate.text() === streamedTexts.join(''),
      historyLengthAfterStream: historyAfterStream.length,
      historyRolesAfterStream: historyAfterStream.map((turn) => turn.role),
      userTurnCountAfterStream: historyAfterStream.filter((turn) => turn.role === 'user').length,
      modelTurnCountAfterStream: historyAfterStream.filter((turn) => turn.role === 'model').length,
      recordedModelTurnTextMatchesAggregate:
        joinedTurnText(lastTurnAfterStream) === streamAggregate.text(),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'ai#chat-sendmessage-envelope',
  rowIds: [
    'ai#chat-sendmessage-envelope',
    'ai#chat-sendmessagestream',
    'ai#chat-stream-single-user-turn',
    'ai#chat-history-threads',
  ],
  description:
    'Live firebase/ai ChatSession.sendMessage(), sendMessageStream(), and getHistory() behavior on the GoogleAI backend with Admin-minted App Check token: verifies sendMessage four-key response envelope and model role, history turn threading, sendMessageStream stream/response settlement, and single-user-turn history recording.',
  async observe() {
    const [appSdk, appCheckSdk, aiSdk, adminAppMod, adminAppCheckMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/app-check'),
      import('firebase/ai'),
      import('firebase-admin/app'),
      import('firebase-admin/app-check'),
    ]);

    const debugGlobal = globalThis as DebugTokenGlobal;
    const hadDebugToken = Object.prototype.hasOwnProperty.call(
      debugGlobal,
      'FIREBASE_APPCHECK_DEBUG_TOKEN',
    );
    const previousDebugToken = debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
    delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const appId = webConfig.appId;
    if (!appId) {
      throw new Error('Oracle webConfig missing appId');
    }
    const runSuffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const adminApp = adminAppMod.initializeApp(
      oracleAppOptions(sa),
      `sdk-probe-ai-chat-admin-${runSuffix}`,
    );
    const adminAppCheck = adminAppCheckMod.getAppCheck(adminApp);
    const clientApp = appSdk.initializeApp(webConfig, `sdk-probe-ai-chat-client-${runSuffix}`);

    try {
      const provider = new appCheckSdk.CustomProvider({
        getToken: async () => {
          const minted = await mintWithRetry(adminAppCheck, appId);
          return {
            token: minted.token,
            expireTimeMillis: Date.now() + minted.ttlMillis,
          };
        },
      });
      appCheckSdk.initializeAppCheck(clientApp, {
        provider,
        isTokenAutoRefreshEnabled: false,
      });

      const model = aiSdk.getGenerativeModel(aiSdk.getAI(clientApp), {
        model: 'gemini-flash-lite-latest',
      });
      return await observeChatSessionSendAndStream(model);
    } finally {
      await appSdk.deleteApp(clientApp).catch(() => undefined);
      await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      if (hadDebugToken) {
        debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
      } else {
        delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
      }
    }
  },
};
