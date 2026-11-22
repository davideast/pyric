import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { CustomProvider, initializeAppCheck } from 'pyric/app-check';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const MODEL = 'gemini-2.5-flash';
const APP_OPTIONS = {
  apiKey: 'fake-api-key',
  projectId: 'demo-stream-worker',
  appId: '1:100000000000:web:deadbeef0042',
};

function makeChunk(text: string, finishReason?: string): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    index: 0,
    content: { role: 'model', parts: [{ text }] },
  };
  if (finishReason !== undefined) {
    candidate.finishReason = finishReason;
  }
  return { candidates: [candidate] };
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  throw new Error('Expected promise to reject');
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let appSeq = 0;

describe('worker AI stream refusal (#1553) and mid-stream abort (#1633)', () => {
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

  async function setupServedAi(customCtx?: (ctx: HostCtx) => void) {
    const ctx = await makeHostCtx();
    customCtx?.(ctx);
    const inboundMessages: InboundMessage[] = [];
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor() {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          const msg = event.data as InboundMessage;
          inboundMessages.push(msg);
          void handleMessage(ctx, hostPortLike, msg);
        };
        this.port = clientPort;
      }
    };
    const servedAi = await import('../../../src/serve/entries/ai.js');
    return { ctx, inboundMessages, servedAi };
  }

  it('rejects await model.generateContentStream() directly on App Check 401 over the worker port (#1553)', async () => {
    const { ctx, servedAi } = await setupServedAi();
    const unauthApp = createAppForSandbox(ctx.sandbox, APP_OPTIONS, `worker-refuse-401-${++appSeq}`);
    try {
      const model = servedAi.getGenerativeModel(servedAi.getAI(unauthApp), { model: MODEL });
      // Do NOT touch .stream or .response; the generateContentStream() call itself must reject.
      const err = await captureRejection(() => model.generateContentStream('ping'));
      expect(err).toBeInstanceOf(servedAi.AIError);
      const aiErr = err as { code?: string; customErrorData?: { status?: number }; message?: string };
      expect(aiErr.code).toBe('fetch-error');
      expect(aiErr.customErrorData?.status).toBe(401);
      expect(aiErr.message).toContain('401 Unauthorized');
    } finally {
      await deleteApp(unauthApp);
    }
  });

  it('rejects await model.generateContentStream() directly on empty contents over the worker port (#1553)', async () => {
    const { ctx, servedAi } = await setupServedAi();
    const app = createAppForSandbox(ctx.sandbox, APP_OPTIONS, `worker-refuse-400-${++appSeq}`);
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId: APP_OPTIONS.appId, projectId: APP_OPTIONS.projectId }, 3600),
      }),
      isTokenAutoRefreshEnabled: false,
    });
    try {
      const model = servedAi.getGenerativeModel(servedAi.getAI(app), { model: MODEL });
      const err = await captureRejection(() => model.generateContentStream({ contents: [] }));
      expect(err).toBeInstanceOf(servedAi.AIError);
      const aiErr = err as { code?: string; customErrorData?: { status?: number } };
      expect(aiErr.code).toBe('fetch-error');
      expect(aiErr.customErrorData?.status).toBe(400);
    } finally {
      await deleteApp(app);
    }
  });

  it('unsub immediately aborts the host AbortSignal and stops upstream chunks mid-stream (#1633)', async () => {
    let hostSignal: AbortSignal | undefined;
    let produced = 0;
    const { ctx, inboundMessages, servedAi } = await setupServedAi((hostCtx) => {
      hostCtx.aiBroker = {
        admitAppCheck: async () => undefined,
        generateContent: async () => makeChunk('unused', 'STOP'),
        countTokens: async () => ({ totalTokens: 1, promptTokensDetails: [] }),
        streamGenerateContent: (_req, _model, _ac, options) => {
          hostSignal = options?.signal;
          return (async function* () {
            for (let i = 0; i < 40; i += 1) {
              if (options?.signal?.aborted) {
                throw new DOMException('aborted', 'AbortError');
              }
              produced += 1;
              yield makeChunk(`c${i} `, i === 39 ? 'STOP' : undefined);
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, 25);
                options?.signal?.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(timer);
                    reject(new DOMException('aborted', 'AbortError'));
                  },
                  { once: true },
                );
              });
            }
          })();
        },
      };
    });

    const app = createAppForSandbox(ctx.sandbox, APP_OPTIONS, `worker-abort-mid-${++appSeq}`);
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId: APP_OPTIONS.appId, projectId: APP_OPTIONS.projectId }, 3600),
      }),
      isTokenAutoRefreshEnabled: false,
    });

    try {
      const model = servedAi.getGenerativeModel(servedAi.getAI(app), { model: MODEL });
      const controller = new AbortController();
      const result = await model.generateContentStream('stream', { signal: controller.signal });
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
      await waitFor(() => hostSignal?.aborted === true);

      expect(seen).toEqual(['c0 ', 'c1 ', 'c2 ']);
      expect((streamErr as Error).name).toBe('AbortError');
      expect((responseErr as Error).name).toBe('AbortError');
      expect(inboundMessages.some((m) => m.t === 'unsub')).toBe(true);
      expect(produced).toBeLessThan(15);
    } finally {
      await deleteApp(app);
    }
  });

  it('aborts pending stream before the first chunk arrives and sends unsub to cancel host (#1633)', async () => {
    let hostSignal: AbortSignal | undefined;
    const { ctx, inboundMessages, servedAi } = await setupServedAi((hostCtx) => {
      hostCtx.aiBroker = {
        admitAppCheck: async () => undefined,
        generateContent: async () => makeChunk('unused', 'STOP'),
        countTokens: async () => ({ totalTokens: 1, promptTokensDetails: [] }),
        streamGenerateContent: (_req, _model, _ac, options) => {
          hostSignal = options?.signal;
          return (async function* () {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 5000);
              options?.signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(new DOMException('aborted before first chunk', 'AbortError'));
                },
                { once: true },
              );
            });
            yield makeChunk('late', 'STOP');
          })();
        },
      };
    });

    const app = createAppForSandbox(ctx.sandbox, APP_OPTIONS, `worker-abort-early-${++appSeq}`);
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId: APP_OPTIONS.appId, projectId: APP_OPTIONS.projectId }, 3600),
      }),
      isTokenAutoRefreshEnabled: false,
    });

    try {
      const model = servedAi.getGenerativeModel(servedAi.getAI(app), { model: MODEL });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      const err = await captureRejection(() =>
        model.generateContentStream('slow headers', { signal: controller.signal }),
      );
      await waitFor(() => hostSignal?.aborted === true);

      expect((err as Error).name).toBe('AbortError');
      expect(inboundMessages.some((m) => m.t === 'unsub')).toBe(true);
    } finally {
      await deleteApp(app);
    }
  });
});
