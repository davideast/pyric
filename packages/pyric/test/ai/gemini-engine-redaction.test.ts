/**
 * Security regression: the Gemini engine appends the API key as a
 * `?key=...` query parameter on upstream REST requests (Google AI Studio
 * auth). When the upstream fetch fails (network error, timeout, DNS
 * failure), the thrown `AiBrokerError` must NOT leak the plaintext key in
 * its message — that message flows into `AiBroker`'s `request_rejected`
 * event, Studio traffic captures, and (via `toAIError`/`aiErrorFromEnvelope`)
 * the public `AIError` surface, any of which can land in terminal output or
 * CI logs.
 *
 * T1.7. Host + path are still expected in the message for diagnosability —
 * only the key VALUE must be redacted.
 *
 * #1631: an upstream or gateway can quote the credential in any form, not
 * only in a URL. On `hosted: true` the Node host runs this engine with the
 * server's key, so the engine masks what the gemini proxy masks: the exact
 * credentials the request carried, in plain text, in an echoed bearer, and
 * in a body that is not a Gemini envelope.
 */
import { describe, expect, it } from 'bun:test';
import { AiBrokerError, GeminiEngine, type GenerateContentRequest } from '../../src/ai/broker/index.js';
import { aiErrorFromEnvelope } from '../../src/ai/errors.js';

const EMPTY_REQUEST: GenerateContentRequest = { contents: [] };

const FAKE_KEY = 'test-key-SECRET123';

function engineWithFailingFetch(): GeminiEngine {
  return new GeminiEngine({
    apiKey: FAKE_KEY,
    fetch: (async () => {
      throw new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com');
    }) as unknown as typeof fetch,
  });
}

async function captureError(fn: () => Promise<unknown>): Promise<AiBrokerError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AiBrokerError);
    return err as AiBrokerError;
  }
  throw new Error('expected fn() to reject');
}

describe('GeminiEngine: API key redaction on upstream failure', () => {
  it('generateContent: does not leak the API key when the upstream connection fails', async () => {
    const engine = engineWithFailingFetch();
    const err = await captureError(() => engine.generateContent(EMPTY_REQUEST, 'gemini-2.5-flash'));

    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.envelope.error.message).not.toContain(FAKE_KEY);
    // Diagnosability: host + path should survive redaction.
    expect(err.envelope.error.message).toContain('generativelanguage.googleapis.com');
  });

  it('streamGenerateContent: does not leak the API key when the upstream connection fails', async () => {
    const engine = engineWithFailingFetch();
    const stream = engine.streamGenerateContent(EMPTY_REQUEST, 'gemini-2.5-flash');
    const err = await captureError(() => stream.next());

    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.envelope.error.message).not.toContain(FAKE_KEY);
  });

  it('countTokens: does not leak the API key when the upstream connection fails', async () => {
    const engine = engineWithFailingFetch();
    const err = await captureError(() => engine.countTokens(EMPTY_REQUEST, 'gemini-2.5-flash'));

    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.envelope.error.message).not.toContain(FAKE_KEY);
  });

  it('does not leak the API key when the upstream returns a non-OK status', async () => {
    // A proxy or gateway error page can echo the key-bearing request URL back
    // in its body; that body is interpolated into the thrown error message.
    const engine = new GeminiEngine({
      apiKey: FAKE_KEY,
      fetch: (async () =>
        new Response(
          `upstream proxy error: https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${FAKE_KEY} refused`,
          { status: 502 },
        )) as unknown as typeof fetch,
    });
    const err = await captureError(() => engine.generateContent(EMPTY_REQUEST, 'gemini-2.5-flash'));

    expect(err.message).toContain('status 502');
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.envelope.error.message).not.toContain(FAKE_KEY);
  });
});

const FAKE_ADC_TOKEN = 'ya29.fake-adc-token-1631';

function engineAnswering(status: number, body: string, apiKey = FAKE_KEY): GeminiEngine {
  return new GeminiEngine({
    apiKey,
    printAdcToken: async () => FAKE_ADC_TOKEN,
    fetch: (async () => new Response(body, { status })) as unknown as typeof fetch,
  });
}

function envelope(message: string): string {
  return JSON.stringify({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } });
}

/** The engine's error, the page's AIError, and the message the terminal block prints. */
async function surfaces(engine: GeminiEngine): Promise<{ err: AiBrokerError; texts: string[] }> {
  const err = await captureError(() => engine.generateContent(EMPTY_REQUEST, 'gemini-2.5-flash'));
  const aiError = aiErrorFromEnvelope(err.envelope, 'models/gemini-2.5-flash', 'generateContent');
  return { err, texts: [err.message, err.envelope.error.message, aiError.message] };
}

function assertNone(texts: string[], secret: string): void {
  for (const text of texts) expect(text).not.toContain(secret);
}

describe('GeminiEngine: credential masking in an upstream error body (#1631)', () => {
  it('masks a key the upstream quotes in plain text, and keeps its status and message', async () => {
    const engine = engineAnswering(400, envelope(`API key ${FAKE_KEY} not valid. Please pass a valid API key.`));
    const { err, texts } = await surfaces(engine);
    assertNone(texts, FAKE_KEY);
    expect(err.envelope.error.message).toBe('API key *** not valid. Please pass a valid API key.');
    expect(err.envelope.error.status).toBe('INVALID_ARGUMENT');
    expect(err.envelope.error.code).toBe(400);
  });

  it('masks a key the upstream quotes in a URL parameter', async () => {
    const engine = engineAnswering(400, envelope(`Request to https://gw.example/v1beta/models/m:generateContent?key=${FAKE_KEY} refused`));
    const { err, texts } = await surfaces(engine);
    assertNone(texts, FAKE_KEY);
    expect(err.envelope.error.message).toContain('key=***');
  });

  it('masks a percent-encoded key', async () => {
    const key = 'fake/key+1631';
    const { texts } = await surfaces(engineAnswering(400, envelope(`refused ${encodeURIComponent(key)}`), key));
    assertNone(texts, encodeURIComponent(key));
    assertNone(texts, key);
  });

  it('masks an ADC bearer token the upstream echoes', async () => {
    const body = envelope(`Request had invalid authentication credentials: Bearer ${FAKE_ADC_TOKEN}`);
    const { err, texts } = await surfaces(engineAnswering(403, body, ''));
    assertNone(texts, FAKE_ADC_TOKEN);
    expect(err.envelope.error.message).toBe('Request had invalid authentication credentials: Bearer ***');
  });

  it('masks a key quoted in a gateway body that is not a Gemini envelope', async () => {
    const { err, texts } = await surfaces(engineAnswering(502, `<html>gateway error for key ${FAKE_KEY}</html>`));
    assertNone(texts, FAKE_KEY);
    expect(err.envelope.error.message).toBe('Gemini API returned status 502: <html>gateway error for key ***</html>');
  });
});

/** An engine whose upstream answers a 200 stream with these SSE frames. */
function engineStreaming(frames: string): GeminiEngine {
  return new GeminiEngine({
    apiKey: FAKE_KEY,
    fetch: (async () => new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch,
  });
}

async function drain(engine: GeminiEngine): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of engine.streamGenerateContent(EMPTY_REQUEST, 'gemini-2.5-flash')) chunks.push(chunk);
  return chunks;
}

const ANSWER_CHUNK = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'see https://x.example/?key=not-a-credential' }] } }] };

describe('GeminiEngine: the error status and mid-stream errors are masked too (#1660)', () => {
  it('masks a key the upstream quotes in the error status', async () => {
    const body = JSON.stringify({ error: { code: 400, message: 'x', status: `BAD ${FAKE_KEY}` } });
    const { err, texts } = await surfaces(engineAnswering(400, body));
    assertNone([...texts, err.envelope.error.status], FAKE_KEY);
    expect(err.envelope.error.status).toBe('BAD ***');
    expect(err.envelope.error.message).toBe('x');
  });

  it('masks a key quoted in a mid-stream error event, and passes the event through', async () => {
    const error = { error: { code: 500, message: `Quota check failed for API key ${FAKE_KEY}.`, status: 'INTERNAL' } };
    const chunks = await drain(engineStreaming(`data: ${JSON.stringify(ANSWER_CHUNK)}\r\n\r\ndata: ${JSON.stringify(error)}\r\n\r\n`));
    expect(JSON.stringify(chunks)).not.toContain(FAKE_KEY);
    expect(chunks).toEqual([
      ANSWER_CHUNK,
      { error: { code: 500, message: 'Quota check failed for API key ***.', status: 'INTERNAL' } },
    ]);
  });

  it('masks a mid-stream error event the stream ends on without a separator', async () => {
    const error = { error: { code: 500, message: `refused ${FAKE_KEY}`, status: 'INTERNAL' } };
    const chunks = await drain(engineStreaming(`data: ${JSON.stringify(error)}`));
    expect(chunks).toEqual([{ error: { code: 500, message: 'refused ***', status: 'INTERNAL' } }]);
  });
});

/** An engine whose upstream fetch rejects with this message, as Node's does for a header it refuses. */
function engineFailingWith(message: string, apiKey = FAKE_KEY): GeminiEngine {
  return new GeminiEngine({
    apiKey,
    printAdcToken: async () => FAKE_ADC_TOKEN,
    fetch: (async () => {
      throw new TypeError(message);
    }) as unknown as typeof fetch,
  });
}

describe('GeminiEngine: a fetch error is masked with the exact credentials (#1737)', () => {
  it('masks a key the fetch error quotes in plain text', async () => {
    const { err, texts } = await surfaces(engineFailingWith(`connect refused for key ${FAKE_KEY}`));
    assertNone(texts, FAKE_KEY);
    expect(err.envelope.error.message).toEndWith(': connect refused for key ***');
    expect(err.envelope.error.status).toBe('UNAVAILABLE');
  });

  it('masks an ADC bearer token the fetch error quotes from the Authorization header', async () => {
    const message = `Headers.append: "Bearer ${FAKE_ADC_TOKEN}" is an invalid header value.`;
    const { err, texts } = await surfaces(engineFailingWith(message, ''));
    assertNone(texts, FAKE_ADC_TOKEN);
    expect(err.envelope.error.message).toEndWith(': Headers.append: "Bearer ***" is an invalid header value.');
  });

  it('masks a percent-encoded key in the URL and in the fetch error', async () => {
    const key = 'fake/key+1737';
    const { texts } = await surfaces(engineFailingWith(`refused ${key}`, key));
    assertNone(texts, key);
    assertNone(texts, encodeURIComponent(key));
  });
});
