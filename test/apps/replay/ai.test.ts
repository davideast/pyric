/**
 * The real `firebase/ai` SDK, from this checkout's node_modules, calls a
 * replay server started with `ai` as if it were production AI Logic: the
 * model's `baseUrl` (the SDK's own request option) is the server's origin,
 * and the answers are the committed AI Logic observations. One app sends an
 * App Check token (a server app's `appCheckToken`), one sends none.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/ai.test.ts'`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteApp, initializeApp, initializeServerApp, type FirebaseApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend, type GenerativeModel } from 'firebase/ai';
import { aiAnswers, type AiReceived } from './ai.ts';
import { receivedBy, startReplayProcess, unmatchedBy } from './process.ts';
import { startReplayServer, type ReplayServer } from './server.ts';

const CONFIG = { projectId: 'demo-replay-ai', apiKey: 'test-api-key', appId: '1:1:web:replay-ai' };
const MODEL = 'gemini-flash-lite-latest';

let server: ReplayServer;
let withToken: FirebaseApp;
let withoutToken: FirebaseApp;

beforeAll(async () => {
  server = await startReplayServer([], { ai: true });
  withToken = initializeServerApp(CONFIG, { appCheckToken: 'replay-app-check-token' });
  withoutToken = initializeApp(CONFIG, 'replay-ai-no-app-check');
});

afterAll(async () => {
  await deleteApp(withToken);
  await deleteApp(withoutToken);
  await server.close();
});

function model(app: FirebaseApp, name = MODEL): GenerativeModel {
  return getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), { model: name }, { baseUrl: server.origin });
}

function lastReceived(): AiReceived {
  return server.ai.at(-1)!;
}

describe('AI Logic answered from the committed observations', () => {
  test('generateContent returns the captured envelope and its token usage', async () => {
    const result = await model(withToken).generateContent('Reply with the single word pyric.');
    expect(result.response.text()).toBe('pyric');
    expect(result.response.usageMetadata).toMatchObject({ promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 });
    // The wire carries `modelVersion`, but firebase 12.19 neither types it nor keeps it on a GoogleAI response.
    expect('modelVersion' in result.response).toBe(false);
    expect(lastReceived()).toEqual({ rpc: 'ai', as: null, message: { project: 'demo-replay-ai', model: MODEL, task: 'generateContent', appCheck: true } });
    expect(server.unmatched).toEqual([]);
  });

  test('generateContentStream plays the captured SSE frames, with usage on every chunk', async () => {
    const result = await model(withToken).generateContentStream('Count from 1 to 10.');
    const chunks: string[] = [];
    const totals: Array<number | undefined> = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk.text());
      totals.push(chunk.usageMetadata?.totalTokenCount);
    }
    const response = await result.response;
    expect(chunks.join('')).toBe('1 2 3 4 5 6 7 8 9 10');
    expect(totals).toEqual([17, 35, 35]);
    expect(response.candidates?.[0]?.finishReason).toBe('STOP');
    // The SDK's aggregated response keeps no usageMetadata: only the chunks carry it.
    expect(response.usageMetadata).toBeUndefined();
    expect(lastReceived().message).toMatchObject({ task: 'streamGenerateContent', appCheck: true });
    expect(server.unmatched).toEqual([]);
  });

  test('countTokens returns the captured total', async () => {
    const result = await model(withToken).countTokens('Reply with the single word pyric.');
    expect(result.totalTokens).toBe(11);
    expect(server.unmatched).toEqual([]);
  });

  test('a chat turn is answered with the same envelope', async () => {
    const reply = await model(withToken).startChat().sendMessage('Reply with the single word pyric.');
    expect(reply.response.text()).toBe('pyric');
    expect(reply.response.usageMetadata?.totalTokenCount).toBe(11);
  });

  test('answers are not consumed: the same call is answered again', async () => {
    const first = await model(withToken).generateContent('again');
    const second = await model(withToken).generateContent('again');
    expect(second.response.text()).toBe(first.response.text());
  });

  test('a call with no App Check token gets the captured 401 on every task', async () => {
    const generate = model(withoutToken).generateContent('Reply with the single word pyric.');
    await expect(generate).rejects.toMatchObject({ customErrorData: { status: 401 } });
    await expect(generate).rejects.toThrow('Firebase App Check token is invalid.');
    await expect(model(withoutToken).generateContentStream('x')).rejects.toMatchObject({ customErrorData: { status: 401 } });
    await expect(model(withoutToken).countTokens('x')).rejects.toMatchObject({ customErrorData: { status: 401 } });
    expect(lastReceived().message).toMatchObject({ task: 'countTokens', appCheck: false });
    expect(server.unmatched).toEqual([]);
  });

  test('a model the observations never served gets the captured 404, naming that model', async () => {
    const generate = model(withToken, 'not-served-model').generateContent('x');
    await expect(generate).rejects.toMatchObject({ customErrorData: { status: 404 } });
    await expect(generate).rejects.toThrow('models/not-served-model is not found');
    expect(server.unmatched).toEqual([]);
  });

  test('any other AI path is refused and listed in unmatched', async () => {
    const response = await fetch(`${server.origin}/v1beta/projects/demo-replay-ai/models/${MODEL}:embedContent`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
    expect(server.unmatched.at(-1)).toMatchObject({ rpc: 'http', request: { method: 'POST', path: `/v1beta/projects/demo-replay-ai/models/${MODEL}:embedContent` } });
    server.unmatched.length = 0;
  });

  test('a page\'s CORS preflight for an AI call is allowed with the headers the SDK sends', async () => {
    const response = await fetch(`${server.origin}/v1beta/projects/demo-replay-ai/models/${MODEL}:generateContent`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-firebase-appcheck,x-goog-api-client,x-goog-api-key' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type,x-firebase-appcheck,x-goog-api-client,x-goog-api-key');
  });

  test('every answer comes from a committed observation', () => {
    const answers = aiAnswers();
    expect(answers.servedModels).toEqual([MODEL]);
    expect(answers.unauthenticated.status).toBe(401);
    expect(answers.unknownModel.status).toBe(404);
  });
});

test('without the ai option an AI request is unmatched, as before', async () => {
  const plain = await startReplayServer([]);
  try {
    const call = getGenerativeModel(getAI(withToken, { backend: new GoogleAIBackend() }), { model: MODEL }, { baseUrl: plain.origin }).generateContent('x');
    await expect(call).rejects.toMatchObject({ customErrorData: { status: 404 } });
    expect(plain.unmatched).toHaveLength(1);
    expect(plain.ai).toEqual([]);
  } finally {
    await plain.close();
  }
});

test('a replay process started with ai answers the SDK and reports the calls it received', async () => {
  const replay = await startReplayProcess([], undefined, { ai: true });
  try {
    const result = await getGenerativeModel(getAI(withToken, { backend: new GoogleAIBackend() }), { model: MODEL }, { baseUrl: replay.origin }).countTokens('x');
    expect(result.totalTokens).toBe(11);
    expect(await receivedBy(replay.origin)).toEqual([{ rpc: 'ai', as: null, message: { project: 'demo-replay-ai', model: MODEL, task: 'countTokens', appCheck: true } }]);
    expect(await unmatchedBy(replay.origin)).toEqual([]);
  } finally {
    await replay.stop();
  }
}, 30_000);
