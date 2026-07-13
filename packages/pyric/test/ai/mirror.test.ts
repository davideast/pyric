/**
 * `pyric/ai` mirror mechanics — unit coverage for the SDK plumbing BETWEEN
 * the conformance rows (messaging precedent): instance identity, input
 * validation, history cloning, error translation, app-target routing, and the
 * scripting subpath's authoring guards. The registry rows themselves are
 * pinned by the oracle conformance suites in this directory; nothing here
 * weakens or repeats a row assertion.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from '../../src/app/index.js';

import {
  AIError,
  AIErrorCode,
  AIModel,
  GoogleAIBackend,
  Schema,
  VertexAIBackend,
  getAI,
  getGenerativeModel,
} from '../../src/ai/index.js';
import { encodeSse, script } from '../../src/ai/scripting.js';

const MODEL = 'gemini-flash-lite-latest';

function freshModel(entries?: Parameters<typeof script>[1]) {
  const sandbox = initializeSandbox();
  const ai = getAI(sandbox);
  if (entries) script(ai, entries);
  return { sandbox, ai, model: getGenerativeModel(ai, { model: MODEL }) };
}

async function rejectionFrom(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected rejection');
}

// ── Instance identity ────────────────────────────────────────────────────

describe('getAI instance identity', () => {
  it('repeat calls for one sandbox return the same handle', () => {
    const sandbox = initializeSandbox();
    expect(getAI(sandbox)).toBe(getAI(sandbox));
  });

  it('distinct sandboxes yield distinct handles and isolated scripts', async () => {
    const a = initializeSandbox();
    const b = initializeSandbox();
    const aiA = getAI(a);
    const aiB = getAI(b);
    expect(aiA).not.toBe(aiB);
    script(aiA, [{ respond: { text: 'only A' } }]);
    const modelB = getGenerativeModel(aiB, { model: MODEL });
    const result = await modelB.generateContent('hello');
    expect(result.response.text()).not.toBe('only A');
  });

  it('distinct backends on one sandbox yield distinct handles', () => {
    const sandbox = initializeSandbox();
    const googleAi = getAI(sandbox);
    const vertexAi = getAI(sandbox, { backend: new VertexAIBackend() });
    expect(googleAi).not.toBe(vertexAi);
    expect(vertexAi.backend).toBeInstanceOf(VertexAIBackend);
    // And the vertex handle is itself stable.
    expect(getAI(sandbox, { backend: new VertexAIBackend() })).toBe(vertexAi);
  });

  it('the default backend is GoogleAIBackend', () => {
    const ai = getAI(initializeSandbox());
    expect(ai.backend).toBeInstanceOf(GoogleAIBackend);
  });
});

// ── getGenerativeModel binding and input validation ──────────────────────

describe('getGenerativeModel binding', () => {
  it('binds and normalizes the model resource name', () => {
    const { ai } = freshModel();
    expect(getGenerativeModel(ai, { model: MODEL }).model).toBe(`models/${MODEL}`);
    expect(getGenerativeModel(ai, { model: `models/${MODEL}` }).model).toBe(`models/${MODEL}`);
  });

  it('normalizeModelName never double-prefixes', () => {
    expect(AIModel.normalizeModelName('models/x')).toBe('models/x');
    expect(AIModel.normalizeModelName('x')).toBe('models/x');
  });

  it('throws AIError no-model without modelParams.model', () => {
    const { ai } = freshModel();
    let thrown: any;
    try {
      getGenerativeModel(ai, {} as any);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AIError);
    expect(thrown.code).toBe(AIErrorCode.NO_MODEL);
  });

  it('rejects setting both thinkingBudget and thinkingLevel', () => {
    const { ai } = freshModel();
    expect(() =>
      getGenerativeModel(ai, {
        model: MODEL,
        generationConfig: { thinkingConfig: { thinkingBudget: 1, thinkingLevel: 'LOW' } },
      }),
    ).toThrow(AIError);
  });

  it('unrecognized AI handles are refused', () => {
    expect(() => getGenerativeModel({} as any, { model: MODEL })).toThrow(TypeError);
  });
});

describe('request validation surfaces AIError with the wire envelope', () => {
  it('empty contents → fetch-error with status 400', async () => {
    const { model } = freshModel();
    const error = await rejectionFrom(model.generateContent({ contents: [] }));
    expect(error).toBeInstanceOf(AIError);
    expect(error.code).toBe(AIErrorCode.FETCH_ERROR);
    expect(error.customErrorData?.status).toBe(400);
    expect(error.customErrorData?.statusText).toBe('Bad Request');
  });

  it('mixed functionResponse and text parts in one chat message throw invalid-content', async () => {
    const { model } = freshModel();
    const chat = model.startChat();
    const error = await rejectionFrom(
      chat.sendMessage([
        { text: 'words' },
        { functionResponse: { name: 'f', response: { ok: true } } },
      ] as any),
    );
    expect(error).toBeInstanceOf(AIError);
    expect(error.code).toBe(AIErrorCode.INVALID_CONTENT);
  });

  it('a pre-aborted signal rejects with AbortError before any engine work', async () => {
    const { model } = freshModel([{ respond: { text: 'never consumed' } }]);
    const controller = new AbortController();
    controller.abort();
    const error = await rejectionFrom(
      model.generateContent('hello', { signal: controller.signal }),
    );
    expect(error.name).toBe('AbortError');
    // The scripted entry was not consumed by the aborted call.
    const result = await model.generateContent('hello');
    expect(result.response.text()).toBe('never consumed');
  });
});

// ── History cloning ──────────────────────────────────────────────────────

describe('ChatSession history isolation', () => {
  it('mutating the array returned by getHistory never corrupts the session', async () => {
    const { model } = freshModel([
      { respond: { text: 'one' } },
      { respond: { text: 'two' } },
    ]);
    const chat = model.startChat();
    await chat.sendMessage('first');
    const stolen = await chat.getHistory();
    stolen.length = 0; // consumer vandalism
    (stolen as any).push({ role: 'user', parts: [{ text: 'forged' }] });
    const history = await chat.getHistory();
    expect(history.map((c: any) => c.role)).toEqual(['user', 'model']);
    expect(history[0]!.parts[0]!.text).toBe('first');
  });

  it('mutating the seeded history array after startChat does not leak in', async () => {
    const seeded = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ];
    const { model } = freshModel();
    const chat = model.startChat({ history: seeded });
    seeded.push({ role: 'user', parts: [{ text: 'sneaky' }] });
    const history = await chat.getHistory();
    expect(history.length).toBe(2);
  });

  it('startChat validates seeded history (first role must be user)', () => {
    const { model } = freshModel();
    expect(() =>
      model.startChat({ history: [{ role: 'model', parts: [{ text: 'x' }] }] }),
    ).toThrow(AIError);
  });

  it('sequential sendMessage calls thread history in order', async () => {
    const { model } = freshModel([
      { respond: { text: 'a1' } },
      { respond: { text: 'a2' } },
    ]);
    const chat = model.startChat();
    // Fire both without awaiting the first: the send chain must serialize.
    const [r1, r2] = await Promise.all([chat.sendMessage('q1'), chat.sendMessage('q2')]);
    expect(r1.response.text()).toBe('a1');
    expect(r2.response.text()).toBe('a2');
    const history = await chat.getHistory();
    expect(history.map((c: any) => c.parts[0].text)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });

  it('a failed send does not poison later sends or getHistory', async () => {
    const { model } = freshModel([{ respond: { text: 'recovered' } }]);
    const chat = model.startChat();
    await rejectionFrom(chat.sendMessage({} as any).then(() => undefined));
    const result = await chat.sendMessage('try again');
    expect(result.response.text()).toBe('recovered');
    const history = await chat.getHistory();
    expect(history.length).toBe(2);
  });
});

// ── Streaming plumbing ───────────────────────────────────────────────────

describe('generateContentStream plumbing', () => {
  it('the aggregate response resolves even if the stream is never drained', async () => {
    const { model } = freshModel([{ respond: { chunks: ['never', ' drained'] } }]);
    const result = await model.generateContentStream('go');
    const aggregated = await result.response;
    expect(aggregated.text()).toBe('never drained');
  });

  it('the stream can be drained after the aggregate resolved', async () => {
    const { model } = freshModel([{ respond: { chunks: ['a', 'b'] } }]);
    const result = await model.generateContentStream('go');
    await result.response;
    const texts: string[] = [];
    for await (const chunk of result.stream) {
      texts.push(chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
    }
    expect(texts).toEqual(['a', 'b']);
  });

  it('a scripted error entry rejects both the stream and the response', async () => {
    const { model } = freshModel([
      { respond: { error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } } },
    ]);
    const result = await model.generateContentStream('go');
    const streamError = await rejectionFrom(
      (async () => {
        for await (const _chunk of result.stream) {
          // drain
        }
      })(),
    );
    expect(streamError).toBeInstanceOf(AIError);
    expect(streamError.customErrorData?.status).toBe(429);
    const responseError = await rejectionFrom(result.response);
    expect(responseError).toBeInstanceOf(AIError);
  });
});

// ── Error translation ────────────────────────────────────────────────────

describe('sandbox error translation', () => {
  it('unknown models reject with the SDK fetch-error decoration', async () => {
    const { ai } = freshModel();
    const model = getGenerativeModel(ai, { model: 'not-a-real-model' });
    const error = await rejectionFrom(model.generateContent('hello'));
    expect(error).toBeInstanceOf(AIError);
    expect(error.code).toBe(AIErrorCode.FETCH_ERROR);
    expect(error.message).toContain('Error fetching from');
    expect(error.message).toContain('[404 Not Found]');
    expect(error.customErrorData?.status).toBe(404);
  });

  it('retired 1.5 models carry the ErrorInfo detail through customErrorData', async () => {
    const { ai } = freshModel();
    const model = getGenerativeModel(ai, { model: 'gemini-1.5-pro' });
    const error = await rejectionFrom(model.generateContent('hello'));
    expect(error.customErrorData?.errorDetails?.[0]?.reason).toBe('RETIRED_MODEL');
    // Upstream appends the JSON details to the message text.
    expect(error.message).toContain('RETIRED_MODEL');
  });

  it('countTokens rejects the same way generateContent does', async () => {
    const { ai } = freshModel();
    const model = getGenerativeModel(ai, { model: 'not-a-real-model' });
    const error = await rejectionFrom(
      model.countTokens({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }),
    );
    expect(error).toBeInstanceOf(AIError);
    expect(error.customErrorData?.status).toBe(404);
  });
});

// ── App target selected by package resolution ───────────────────────────

describe('sandbox app target', () => {
  it('getAI(app) carries the app and is idempotent', async () => {
    const app = initializeApp(
      { sandbox: initializeSandbox() },
      `ai-unit-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const ai = getAI(app);
      expect(ai.app).toBe(app);
      expect(getAI(app)).toBe(ai);
    } finally {
      await deleteApp(app);
    }
  });

  it('models minted from an app handle answer through its sandbox without network I/O', async () => {
    const app = initializeApp(
      { sandbox: initializeSandbox() },
      `ai-unit-${Math.random().toString(36).slice(2)}`,
    );
    const ai = getAI(app);
    script(ai, [{ respond: { text: 'sandbox says hi' } }]);
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = (input: unknown) => {
      throw new Error(`unexpected production fetch: ${String(input)}`);
    };
    try {
      const model = getGenerativeModel(ai, { model: MODEL });
      const result = await model.generateContent('ping');
      expect(result.response.text()).toBe('sandbox says hi');
    } finally {
      (globalThis as any).fetch = realFetch;
      await deleteApp(app);
    }
  });

  it('rejects a real Firebase app with package-resolution remediation', async () => {
    const firebaseApp = await import('firebase/app');
    const app = firebaseApp.initializeApp(
      { apiKey: 'k', projectId: 'p', appId: '1:0:web:wrong-package' },
      `ai-unit-${Math.random().toString(36).slice(2)}`,
    );
    try {
      expect(() => getAI(app as never)).toThrow(
        /sandbox-only mirror.*package resolution.*firebase\/ai.*production.*select the sandbox/i,
      );
    } finally {
      await firebaseApp.deleteApp(app);
    }
  });
});

// ── Scripting subpath guards and framing ─────────────────────────────────

describe('pyric/ai/scripting', () => {
  it('script() accepts a sandbox app handle', async () => {
    const app = initializeApp(
      { sandbox: initializeSandbox() },
      `ai-unit-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const ai = getAI(app);
      script(ai, [{ respond: { text: 'x' } }]);
      const model = getGenerativeModel(ai, { model: MODEL });
      expect((await model.generateContent('hello')).response.text()).toBe('x');
    } finally {
      await deleteApp(app);
    }
  });

  it('script() refuses a non-scripted engine', () => {
    const sandbox = initializeSandbox();
    const ai = getAI(sandbox, { engine: { kind: 'openai', baseUrl: 'http://localhost:1/v1' } });
    let thrown: any;
    try {
      script(ai, [{ respond: { text: 'x' } }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AIError);
    expect(thrown.code).toBe(AIErrorCode.UNSUPPORTED);
  });

  it('normalizes the pasted-HTTP-capture error form (httpStatus + body)', async () => {
    const { ai, model } = freshModel();
    script(ai, [
      {
        respond: {
          error: {
            httpStatus: 403,
            body: {
              error: {
                code: 403,
                message: 'nope',
                status: 'PERMISSION_DENIED',
                details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo' }],
              },
            },
          },
        },
      },
    ]);
    const error = await rejectionFrom(model.generateContent('hello'));
    expect(error).toBeInstanceOf(AIError);
    expect(error.customErrorData?.status).toBe(403);
    expect(error.customErrorData?.statusText).toBe('Forbidden');
    expect(error.message).toContain('nope');
    expect(error.customErrorData?.errorDetails?.[0]?.['@type']).toBe(
      'type.googleapis.com/google.rpc.ErrorInfo',
    );
  });

  it('encodeSse frames every envelope as data:-prefixed JSON with CRLF CRLF', () => {
    const raw = encodeSse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, index: 0 }] },
    ]);
    expect(raw.startsWith('data: ')).toBe(true);
    expect(raw.endsWith('\r\n\r\n')).toBe(true);
    expect(() => JSON.parse(raw.slice('data: '.length, -4))).not.toThrow();
    expect(encodeSse([])).toBe('');
  });

  it('a structured-output request honors the schema zero-config', async () => {
    const { model } = freshModel();
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'shape it' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: Schema.object({
          properties: {
            name: Schema.string(),
            count: Schema.integer(),
            tags: Schema.array({ items: Schema.enumString({ enum: ['a', 'b'] }) }),
          },
          optionalProperties: ['tags'],
        }),
      },
    });
    const parsed = JSON.parse(result.response.text());
    expect(Object.keys(parsed).sort()).toEqual(['count', 'name', 'tags']);
    expect(parsed.count).toBe(1);
    expect(parsed.tags).toEqual(['a']);
  });
});
