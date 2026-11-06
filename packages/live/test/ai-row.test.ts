/**
 * The live-ai row over the real `firebase/ai` (its browser build, in Bun),
 * against the in-process replay server playing the committed AI Logic
 * observations, so every call crosses real HTTP and gets the envelope
 * production sent. One app sends an App Check token (a server app's
 * `appCheckToken`); one sends none and gets production's enforced 401.
 * Each record must name the model and production's token counts, and never
 * the prompt or the response text. Each observed call must pass the host's
 * reader.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/ai-row.test.ts'`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as realApp from 'firebase/app';
import type { AI, ChatSession, GenerativeModel } from 'firebase/ai';
import { UNREAD_MODEL } from '../src/ai.js';
import { observedCallOf } from '../src/page-observer.js';
import { LIVE_REFUSED, wrapLiveModule, type LiveCallRecord, type LiveModuleSite, type LiveObserver } from '../src/index.js';

/** The in-process replay server `test/apps/replay/server.ts` starts. */
interface ReplayServer {
  readonly origin: string;
  readonly unmatched: unknown[];
  readonly ai: unknown[];
  close(): Promise<void>;
}

/** The replay helper and host reader this test uses, loaded at run time so this package's typecheck stays out of them. */
interface Loaded {
  startReplayServer(recordings: unknown[], options: { ai: boolean }): Promise<ReplayServer>;
  readObservedCall(value: unknown): unknown;
  observedCallEvent(call: unknown): { path?: string; observation?: { ai?: Record<string, unknown>; response?: unknown } };
}

async function load(): Promise<Loaded> {
  const at = (path: string) => import(new URL(path, import.meta.url).href);
  const [server, observed] = await Promise.all([at('../../../test/apps/replay/server.ts'), at('../../pyric/src/sandbox/internal/observed-call.ts')]);
  return { ...server, ...observed } as Loaded;
}

const loaded = await load();
const PROJECT = 'demo-live-ai';
const CONFIG = { projectId: PROJECT, apiKey: 'test-api-key', appId: '1:1:web:live-ai' };
const MODEL = 'gemini-flash-lite-latest';
const MODEL_RESOURCE = `models/${MODEL}`;
/** The captured `generateContent` envelope's answer, which no record may carry. */
const ENVELOPE_TEXT = 'pyric';
const PROMPT = 'Reply with the single word pyric.';

type FirebaseAi = typeof import('firebase/ai');

/** `@firebase/ai`'s browser ESM build, found next to the Node build that `firebase/ai` resolves to. */
function aiBrowserEntry(): string {
  const firebaseAi = createRequire(import.meta.url).resolve('firebase/ai');
  const nodeEntry = createRequire(firebaseAi).resolve('@firebase/ai');
  return join(dirname(nodeEntry), 'esm', 'index.esm.js');
}

const records: LiveCallRecord[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
const site: LiveModuleSite = { observer, sdkVersion: realApp.SDK_VERSION, client: 'node' };

let server: ReplayServer;
let real: FirebaseAi;
let live: FirebaseAi;
let withToken: realApp.FirebaseApp;
let withoutToken: realApp.FirebaseApp;

beforeAll(async () => {
  server = await loaded.startReplayServer([], { ai: true });
  real = (await import(pathToFileURL(aiBrowserEntry()).href)) as FirebaseAi;
  live = wrapLiveModule('live-ai', 'firebase/ai', real, site);
  withToken = realApp.initializeServerApp(CONFIG, { appCheckToken: 'replay-app-check-token' });
  withoutToken = realApp.initializeApp(CONFIG, 'live-ai-no-app-check');
});

afterAll(async () => {
  for (const app of realApp.getApps()) await realApp.deleteApp(app);
  await realApp.deleteApp(withToken);
  await server.close();
});

function aiOf(app: realApp.FirebaseApp, ai: FirebaseAi = live): AI {
  return ai.getAI(app, { backend: new ai.GoogleAIBackend() });
}

function model(app: realApp.FirebaseApp = withToken, name = MODEL, ai: FirebaseAi = live): GenerativeModel {
  return ai.getGenerativeModel(aiOf(app, ai), { model: name }, { baseUrl: server.origin });
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** A Live API model, as `connect` is all the tests below call on one. */
interface Connectable {
  connect(): Promise<unknown>;
}

/** `new cls(...args)`, for the SDK classes whose constructors its types hide. */
function construct(cls: unknown, args: readonly unknown[]): Connectable {
  return Reflect.construct(cls as new (...values: unknown[]) => Connectable, args);
}

/**
 * Every WebSocket and fetch `act` opens, from `globalThis`, while it runs,
 * and what it threw. Each socket fails at once and each fetch rejects, so
 * nothing leaves the process.
 */
async function reachedHosts(act: () => unknown): Promise<{ reached: string[]; error: unknown }> {
  const reached: string[] = [];
  const realWebSocket = globalThis.WebSocket;
  const realFetch = globalThis.fetch;
  class ObservedWebSocket extends EventTarget {
    readonly readyState = 3;
    binaryType = 'blob';
    constructor(url: string | URL) {
      super();
      reached.push(`websocket ${String(url)}`);
      queueMicrotask(() => this.dispatchEvent(new Event('error')));
    }
    close(): void {}
    send(): void {}
  }
  Reflect.set(globalThis, 'WebSocket', ObservedWebSocket);
  Reflect.set(globalThis, 'fetch', async (input: unknown) => {
    reached.push(`fetch ${String(input)}`);
    throw new TypeError('the test reaches no host');
  });
  let error: unknown;
  try {
    await act();
  } catch (thrown) {
    error = thrown;
  } finally {
    Reflect.set(globalThis, 'WebSocket', realWebSocket);
    Reflect.set(globalThis, 'fetch', realFetch);
  }
  return { reached, error };
}

/** The records one action makes, once `count` have arrived. */
async function recordsOf(count: number, act: () => Promise<unknown>): Promise<LiveCallRecord[]> {
  const from = records.length;
  await act();
  await until(() => records.length >= from + count);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return records.slice(from);
}

/** The observed call the page plane sends for a record, read back by the host's own reader. */
function hostRead(record: LiveCallRecord): unknown {
  const call = observedCallOf(record, Date.now());
  expect(call).not.toBeNull();
  return loaded.readObservedCall(JSON.parse(JSON.stringify(call)));
}

describe('the live-ai row records each call with production\'s answer and token counts', () => {
  test('generateContent: ok, with the model and the captured usage, and no modelVersion the SDK dropped', async () => {
    let text = '';
    const made = await recordsOf(1, async () => {
      text = (await model().generateContent(PROMPT)).response.text();
    });
    expect(text).toBe(ENVELOPE_TEXT);
    expect(made).toEqual([{
      module: 'firebase/ai',
      name: 'generateContent',
      outcome: 'resolved',
      projectId: PROJECT,
      ai: { model: MODEL_RESOURCE, usage: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 } },
    }]);
    const event = loaded.observedCallEvent(hostRead(made[0]!));
    expect(event.path).toBe(MODEL_RESOURCE);
    expect(event.observation?.ai).toMatchObject({ usageSource: 'backend' });
    expect(event.observation?.response).toBeUndefined();
  });

  test('generateContentStream: one record when the response settles, with the last chunk\'s usage and firstChunkMs', async () => {
    const chunks: string[] = [];
    const made = await recordsOf(1, async () => {
      const result = await model().generateContentStream('Count from 1 to 10.');
      for await (const chunk of result.stream) chunks.push(chunk.text());
      const response = await result.response;
      expect(response.candidates?.[0]?.finishReason).toBe('STOP');
    });
    expect(chunks.join('')).toBe('1 2 3 4 5 6 7 8 9 10');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ name: 'generateContentStream', outcome: 'resolved', projectId: PROJECT });
    expect(made[0]!.ai).toMatchObject({ model: MODEL_RESOURCE, usage: { totalTokenCount: 35 } });
    expect(made[0]!.ai?.firstChunkMs).toBeGreaterThanOrEqual(0);
    hostRead(made[0]!);
  });

  test('generateContentStream: the record is made even when the app never reads the stream', async () => {
    const made = await recordsOf(1, async () => {
      const result = await model().generateContentStream('Count from 1 to 10.');
      await result.response;
    });
    expect(made[0]!.ai?.usage).toMatchObject({ totalTokenCount: 35 });
  });

  test('countTokens: ok, keeping only totalTokens', async () => {
    const made = await recordsOf(1, async () => {
      expect((await model().countTokens(PROMPT)).totalTokens).toBe(11);
    });
    expect(made).toEqual([{ module: 'firebase/ai', name: 'countTokens', outcome: 'resolved', projectId: PROJECT, ai: { model: MODEL_RESOURCE, usage: { totalTokens: 11 } } }]);
    hostRead(made[0]!);
  });

  test('chat.sendMessage and chat.sendMessageStream: ok, with usage, and the chat keeps its history', async () => {
    let chat: ChatSession | undefined;
    const made = await recordsOf(2, async () => {
      chat = model().startChat();
      expect((await chat.sendMessage(PROMPT)).response.text()).toBe(ENVELOPE_TEXT);
      const streamed = await chat.sendMessageStream('Count from 1 to 10.');
      for await (const _chunk of streamed.stream) {
        // Read to the end, as an app would.
      }
      await streamed.response;
    });
    expect(made.map((record) => record.name)).toEqual(['chat.sendMessage', 'chat.sendMessageStream']);
    expect(made[0]!.ai).toEqual({ model: MODEL_RESOURCE, usage: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 } });
    expect(made[1]!.ai?.usage).toMatchObject({ totalTokenCount: 35 });
    expect(chat).toBeInstanceOf(live.ChatSession);
    expect(chat).toBeInstanceOf(real.ChatSession);
    const history = await chat!.getHistory();
    expect(history.map((content) => content.role)).toEqual(['user', 'model', 'user', 'model']);
    for (const record of made) expect(observedCallOf(record, 0)).toMatchObject({ service: 'ai', method: record.name });
  });

  test('a model with no App Check token: failed unauthenticated, production\'s enforced 401', async () => {
    const made = await recordsOf(1, async () => {
      await expect(model(withoutToken).generateContent(PROMPT)).rejects.toMatchObject({ customErrorData: { status: 401 } });
    });
    expect(made).toEqual([{ module: 'firebase/ai', name: 'generateContent', outcome: 'rejected', code: 'unauthenticated', projectId: PROJECT, ai: { model: MODEL_RESOURCE } }]);
    expect(observedCallOf(made[0]!, 0)?.outcome).toEqual({ status: 'error', code: 'unauthenticated' });
    hostRead(made[0]!);
  });

  test('a stream with no App Check token: the method\'s rejection is the record', async () => {
    const made = await recordsOf(1, async () => {
      await expect(model(withoutToken).generateContentStream('x')).rejects.toMatchObject({ customErrorData: { status: 401 } });
    });
    expect(made).toEqual([{ module: 'firebase/ai', name: 'generateContentStream', outcome: 'rejected', code: 'unauthenticated', projectId: PROJECT, ai: { model: MODEL_RESOURCE } }]);
  });

  test('an unknown model: failed not_found', async () => {
    const made = await recordsOf(1, async () => {
      await expect(model(withToken, 'not-served-model').generateContent('x')).rejects.toMatchObject({ customErrorData: { status: 404 } });
    });
    expect(made[0]).toMatchObject({ outcome: 'rejected', code: 'not_found', ai: { model: 'models/not-served-model' } });
  });

  test('no record, and no observed call, carries the prompt or the response text', () => {
    const recorded = JSON.stringify(records);
    const sent = JSON.stringify(records.map((record) => observedCallOf(record, 0)));
    for (const text of [ENVELOPE_TEXT, PROMPT, 'Count from', '1 2 3']) {
      expect(recorded).not.toContain(text);
      expect(sent).not.toContain(text);
    }
    expect(server.unmatched).toEqual([]);
  });
});

describe('instances, not prototypes', () => {
  test('a model from getGenerativeModel is the SDK\'s own class, and its prototype is untouched', () => {
    const made = model();
    expect(made).toBeInstanceOf(live.GenerativeModel);
    expect(made).toBeInstanceOf(real.GenerativeModel);
    expect(live.GenerativeModel.prototype).toBe(real.GenerativeModel.prototype);
    expect(Object.hasOwn(made, 'generateContent')).toBe(true);
    expect(Object.keys(made)).not.toContain('generateContent');
  });

  test('new GenerativeModel(ai, params) is observed', async () => {
    const made = await recordsOf(1, async () => {
      const built = new live.GenerativeModel(aiOf(withToken), { model: MODEL }, { baseUrl: server.origin });
      expect(built).toBeInstanceOf(real.GenerativeModel);
      await built.countTokens(PROMPT);
    });
    expect(made).toEqual([{ module: 'firebase/ai', name: 'countTokens', outcome: 'resolved', projectId: PROJECT, ai: { model: MODEL_RESOURCE, usage: { totalTokens: 11 } } }]);
  });

  test('new ChatSession(...) is observed, reading its project from the SDK\'s settings', async () => {
    const source = model() as GenerativeModel & { _apiSettings: unknown };
    const made = await recordsOf(1, async () => {
      const chat = new live.ChatSession(source._apiSettings as never, source.model, undefined, {}, { baseUrl: server.origin });
      expect(chat).toBeInstanceOf(real.ChatSession);
      await chat.sendMessage(PROMPT);
    });
    expect(made).toEqual([{ module: 'firebase/ai', name: 'chat.sendMessage', outcome: 'resolved', projectId: PROJECT, ai: { model: MODEL_RESOURCE, usage: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 } } }]);
  });

  test('a second wrap of the same SDK records each call once', async () => {
    const twice = wrapLiveModule('live-ai', 'firebase/ai', real, site);
    const made = await recordsOf(1, async () => {
      await model(withToken, MODEL, twice).countTokens(PROMPT);
    });
    expect(made).toHaveLength(1);
  });

  test('the SDK unwrapped records nothing', async () => {
    const from = records.length;
    await model(withToken, MODEL, real).countTokens(PROMPT);
    expect(records.length).toBe(from);
  });
});

describe('what live mode does not observe', () => {
  test('getLiveGenerativeModel, startAudioConversation and getTemplateGenerativeModel throw the refusal before any request', () => {
    const received = server.ai.length;
    const ai = aiOf(withToken);
    expect(() => live.getLiveGenerativeModel(ai, { model: MODEL })).toThrow(expect.objectContaining({ code: LIVE_REFUSED }));
    expect(() => live.getLiveGenerativeModel(ai, { model: MODEL })).toThrow('@pyric/live: getLiveGenerativeModel is refused in live mode, from a Node process: it would reach the Gemini Live API');
    expect(() => live.startAudioConversation({} as never)).toThrow(expect.objectContaining({ code: LIVE_REFUSED }));
    expect(() => live.getTemplateGenerativeModel(ai)).toThrow(expect.objectContaining({ code: LIVE_REFUSED }));
    expect(server.ai.length).toBe(received);
    expect(server.unmatched).toEqual([]);
  });

  test('new LiveGenerativeModel, new LiveSession and new TemplateGenerativeModel throw the refusal at construction', () => {
    const ai = aiOf(withToken);
    const constructed = [
      ['LiveGenerativeModel', [ai, { model: MODEL }], 'the Gemini Live API'],
      ['LiveSession', [{ setup: { model: MODEL_RESOURCE } }, {}], 'the Gemini Live API'],
      ['TemplateGenerativeModel', [ai], 'Firebase AI Logic server prompt templates'],
    ] as const;
    for (const [name, args, reaches] of constructed) {
      expect(() => construct(Reflect.get(live, name), args)).toThrow(expect.objectContaining({ code: LIVE_REFUSED }));
      expect(() => construct(Reflect.get(live, name), args)).toThrow(`@pyric/live: new ${name} is refused in live mode, from a Node process: it would reach ${reaches}`);
    }
  });

  test('Imagen\'s classes are refused at construction where the installed SDK exports them, and absent where it does not', () => {
    let built = 0;
    class Built {
      constructor() {
        built++;
      }
    }
    const older = wrapLiveModule('live-ai', 'firebase/ai', { ImagenModel: Built, TemplateImagenModel: Built }, site);
    expect(() => construct(older.ImagenModel, [{}, { model: 'imagen-3.0-generate-002' }])).toThrow('@pyric/live: new ImagenModel is refused in live mode, from a Node process: it would reach Imagen image generation');
    expect(() => construct(older.TemplateImagenModel, [{}])).toThrow('@pyric/live: new TemplateImagenModel is refused in live mode, from a Node process: it would reach Firebase AI Logic server prompt templates for Imagen');
    expect(built).toBe(0);
    expect(Object.hasOwn(live, 'ImagenModel')).toBe(Object.hasOwn(real, 'ImagenModel'));
  });

  test('the real SDK\'s Live API opens a WebSocket on connect, which the observer below sees', async () => {
    const seen = await reachedHosts(() => construct(real.LiveGenerativeModel, [aiOf(withToken, real), { model: MODEL }]).connect());
    expect(seen.reached).toEqual([expect.stringMatching(/^websocket wss:\/\/firebasevertexai\.googleapis\.com\//)]);
  });

  test('getLiveGenerativeModel(...).connect() and new LiveGenerativeModel(...).connect() open no WebSocket and send no request', async () => {
    const received = server.ai.length;
    const ai = aiOf(withToken);
    const fromFactory = await reachedHosts(() => live.getLiveGenerativeModel(ai, { model: MODEL }).connect());
    const fromClass = await reachedHosts(() => construct(live.LiveGenerativeModel, [ai, { model: MODEL }]).connect());
    const fromSession = await reachedHosts(() => construct(live.LiveSession, [{ setup: { model: MODEL_RESOURCE } }, {}]));
    for (const seen of [fromFactory, fromClass, fromSession]) {
      expect(seen).toEqual({ reached: [], error: expect.objectContaining({ code: LIVE_REFUSED }) });
    }
    expect(server.ai.length).toBe(received);
    expect(server.unmatched).toEqual([]);
  });

  test('an answer made on device makes no record', async () => {
    const languageModel = {
      availability: async () => 'available',
      create: async () => ({ prompt: async () => 'from the device' }),
    };
    Reflect.set(globalThis, 'LanguageModel', languageModel);
    try {
      const hybrid = live.getGenerativeModel(aiOf(withToken), { mode: 'prefer_on_device' }, { baseUrl: server.origin });
      const from = records.length;
      const received = server.ai.length;
      expect((await hybrid.generateContent(PROMPT)).response.inferenceSource).toBe('on_device');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(records.length).toBe(from);
      expect(server.ai.length).toBe(received);
    } finally {
      Reflect.deleteProperty(globalThis, 'LanguageModel');
    }
  });

  test('a model that runs only on device makes no record at all', async () => {
    Reflect.set(globalThis, 'LanguageModel', { availability: async () => 'unavailable' });
    try {
      const onDevice = live.getGenerativeModel(aiOf(withToken), { mode: 'only_on_device' }, { baseUrl: server.origin });
      const from = records.length;
      await expect(onDevice.countTokens(PROMPT)).rejects.toThrow();
      await expect(onDevice.generateContent(PROMPT)).rejects.toThrow();
      expect(records.length).toBe(from);
    } finally {
      Reflect.deleteProperty(globalThis, 'LanguageModel');
    }
  });
});

describe('a stream whose response fails', () => {
  /** A stand-in AI Logic host: one good SSE chunk, then a frame the SDK cannot parse. */
  function brokenStreamServer(): { origin: string; stop(): void } {
    const good = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"1"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\r\n\r\n';
    const served = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(good));
          await new Promise((resolve) => setTimeout(resolve, 30));
          controller.enqueue(new TextEncoder().encode('data: {not json\r\n\r\n'));
          controller.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    });
    return { origin: `http://127.0.0.1:${served.port}`, stop: () => served.stop(true) };
  }

  test('a stream whose response fails after its first chunk: the response\'s rejection is the record', async () => {
    const broken = brokenStreamServer();
    try {
      const made = await recordsOf(1, async () => {
        const streaming = live.getGenerativeModel(aiOf(withToken), { model: MODEL }, { baseUrl: broken.origin });
        const result = await streaming.generateContentStream('x');
        const read = (async () => {
          for await (const _chunk of result.stream) {
            // The stream errors where the SDK's does.
          }
        })();
        const settled = await Promise.allSettled([read, result.response]);
        expect(settled).toMatchObject([{ status: 'rejected', reason: { code: 'parse-failed' } }, { status: 'rejected', reason: { code: 'parse-failed' } }]);
      });
      expect(made).toEqual([{ module: 'firebase/ai', name: 'generateContentStream', outcome: 'rejected', code: 'parse-failed', projectId: PROJECT, ai: { model: MODEL_RESOURCE } }]);
    } finally {
      broken.stop();
    }
  });
});

/** One good SSE chunk, as AI Logic frames it, and a frame the SDK cannot parse. */
const GOOD_FRAME = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"1"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\r\n\r\n';
const BAD_FRAME = 'data: {not json\r\n\r\n';

/**
 * The stream calls an app makes, as the app below starts each one, and what
 * the SDK does with the failed response without live mode: a model's
 * `generateContentStream` leaves it unhandled, and a chat's
 * `sendMessageStream` handles it on its own send queue and logs it.
 */
const STREAM_CASES = {
  generateContentStream: { start: "await model.generateContentStream('x');", unhandled: ['parse-failed'], logged: 0 },
  'chat.sendMessageStream': { start: "await model.startChat().sendMessageStream('x');", unhandled: [], logged: 1 },
} as const;

type StreamCall = keyof typeof STREAM_CASES;

/** The SDK's log lines on stderr, without their timestamp. */
function loggedLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => /^\[\d{4}-/.test(line)).map((line) => line.replace(/^\[[^\]]+\]\s+/, ''));
}

/**
 * Runs, in a Node process of its own, an app whose stream call's response
 * fails and that never handles the response: the real SDK against a
 * stand-in host that sends one good chunk, then a frame the SDK cannot
 * parse. Bun's test runner fails a test on any unhandled rejection, so the
 * runtime's own behavior is checked in Node, as `observe.test.ts` does. The
 * source imports its siblings as `.js`, so a resolve hook finds the `.ts`.
 */
function unhandledInNode(wrapped: boolean, call: StreamCall): { unhandled: string[]; records: LiveCallRecord[]; logged: string[] } {
  const app = [
    "import { registerHooks } from 'node:module';",
    "registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) { if (!specifier.endsWith('.js')) throw error; return next(`${specifier.slice(0, -3)}.ts`, context); } } });",
    "import { createServer } from 'node:http';",
    "const realApp = await import('firebase/app');",
    `const real = await import(${JSON.stringify(pathToFileURL(aiBrowserEntry()).href)});`,
    `const { wrapLiveModule } = await import(${JSON.stringify(new URL('../src/modules.ts', import.meta.url).href)});`,
    'const records = [];',
    'const unhandled = [];',
    "process.on('unhandledRejection', (reason) => { unhandled.push(String(reason?.code)); });",
    'const server = createServer((request, response) => {',
    "  response.writeHead(200, { 'content-type': 'text/event-stream' });",
    `  response.write(${JSON.stringify(GOOD_FRAME)});`,
    `  setTimeout(() => response.end(${JSON.stringify(BAD_FRAME)}), 30);`,
    '});',
    "await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
    'const origin = `http://127.0.0.1:${server.address().port}`;',
    `const ai = ${wrapped} ? wrapLiveModule('live-ai', 'firebase/ai', real, { observer: (record) => records.push(record), sdkVersion: realApp.SDK_VERSION, client: 'node' }) : real;`,
    `const firebaseApp = realApp.initializeApp(${JSON.stringify(CONFIG)});`,
    `const model = ai.getGenerativeModel(ai.getAI(firebaseApp, { backend: new ai.GoogleAIBackend() }), { model: ${JSON.stringify(MODEL)} }, { baseUrl: origin });`,
    STREAM_CASES[call].start,
    'await new Promise((resolve) => setTimeout(resolve, 200));',
    'server.close();',
    'console.log(JSON.stringify({ unhandled, records }));',
    'process.exit(0);',
  ].join('\n');
  const cwd = dirname(fileURLToPath(import.meta.url));
  const run = spawnSync('node', ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', app], { encoding: 'utf8', cwd });
  const logged = loggedLines(run.stderr);
  if (logged.length === 0) expect(run.stderr).toBe('');
  const ran = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { unhandled: string[]; records: LiveCallRecord[] };
  return { ...ran, logged };
}

test.each(Object.keys(STREAM_CASES) as StreamCall[])('a %s response the app never handles fails as it does without live mode, and is the record', (call) => {
  const withoutLive = unhandledInNode(false, call);
  const withLive = unhandledInNode(true, call);
  expect(withoutLive.unhandled).toEqual([...STREAM_CASES[call].unhandled]);
  expect(withoutLive.logged).toHaveLength(STREAM_CASES[call].logged);
  expect(withLive.unhandled).toEqual(withoutLive.unhandled);
  expect(withLive.logged).toEqual(withoutLive.logged);
  expect(withLive.records).toEqual([{ module: 'firebase/ai', name: call, outcome: 'rejected', code: 'parse-failed', projectId: PROJECT, ai: { model: MODEL_RESOURCE } }]);
}, 20_000);

test('a record with no model names the unread model, which the host takes', () => {
  const call = observedCallOf({ module: 'firebase/ai', name: 'generateContent', outcome: 'resolved' }, 0);
  expect(call?.ai).toEqual({ model: UNREAD_MODEL });
  loaded.readObservedCall(call);
});
