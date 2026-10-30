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
