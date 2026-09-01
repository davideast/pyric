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
 */
import { describe, expect, it } from 'bun:test';
import { AiBrokerError, GeminiEngine } from '../../src/ai/broker/index.js';

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
    const err = await captureError(() => engine.generateContent({ contents: [] } as any, 'gemini-2.5-flash'));

    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.envelope.error.message).not.toContain(FAKE_KEY);
    // Diagnosability: host + path should survive redaction.
    expect(err.envelope.error.message).toContain('generativelanguage.googleapis.com');
  });

  it('streamGenerateContent: does not leak the API key when the upstream connection fails', async () => {
    const engine = engineWithFailingFetch();
    const stream = engine.streamGenerateContent({ contents: [] } as any, 'gemini-2.5-flash');
    const err = await captureError(() => stream.next());

    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.envelope.error.message).not.toContain(FAKE_KEY);
  });

  it('countTokens: does not leak the API key when the upstream connection fails', async () => {
    const engine = engineWithFailingFetch();
    const err = await captureError(() => engine.countTokens({ contents: [] } as any, 'gemini-2.5-flash'));

    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.envelope.error.message).not.toContain(FAKE_KEY);
  });
});
