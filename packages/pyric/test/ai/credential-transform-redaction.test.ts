/**
 * Security regressions for #1600:
 * - Short credentials (< 8 chars) never trigger exact/transformed text
 *   matching that would corrupt JSON error keys ("error" -> "***rror"), while
 *   URL parameter redaction still masks `?key=`, `&key=`, HTML-escaped
 *   `&amp;key=` / `&#38;key=` / `&#x26;key=`, JSON-escaped `\u0026key=`, and
 *   percent-encoded `%26key%3D`.
 * - Credentials >= 8 chars are masked across raw, percent-encoded, base64,
 *   unpadded base64, base64url, unpadded base64url, percent-encoded base64,
 *   case-changed, HTML-entity, and backslash/Unicode-escaped forms in both
 *   Node and Buffer-less worker runtimes.
 */
import { describe, expect, it } from 'bun:test';
import { redactUpstreamError } from '../../src/ai/broker/upstream-error-redaction.js';

function envelope(message: string, status = 'INVALID_ARGUMENT'): string {
  return JSON.stringify({ error: { code: 400, message, status } });
}

describe('credential transform redaction (#1600)', () => {
  it('does not corrupt JSON envelope keys when a credential is shorter than 8 characters, while still masking URL params', () => {
    for (const shortKey of ['e', 'a', 'error', '1234567']) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?alt=sse&key=${shortKey}`;
      const body = envelope(`Request to ${url} failed`);
      const masked = redactUpstreamError(body, [shortKey]);
      const parsed = JSON.parse(masked) as { error: { code: number; message: string; status: string } };
      expect(parsed.error.code).toBe(400);
      expect(parsed.error.status).toBe('INVALID_ARGUMENT');
      expect(parsed.error.message).toBe(
        'Request to https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?alt=sse&key=*** failed',
      );
    }

    const htmlBody =
      '<html>Refused https://x.test/?alt=sse&amp;key=e and https://x.test/?alt=sse&#38;key=e and https://x.test/?alt=sse&#x26;key=e</html>';
    expect(redactUpstreamError(htmlBody, ['e'])).toBe(
      '<html>Refused https://x.test/?alt=sse&amp;key=*** and https://x.test/?alt=sse&#38;key=*** and https://x.test/?alt=sse&#x26;key=***</html>',
    );

    const malformedJson = '{"error":{"message":"https://x.test/?alt=sse\\u0026key=e"';
    expect(redactUpstreamError(malformedJson, ['e'])).toBe(
      '{"error":{"message":"https://x.test/?alt=sse\\u0026key=***"',
    );

    const percentEncoded = 'gateway refused /v1beta/models/m?alt%3Dsse%26key%3De%26foo%3D1';
    expect(redactUpstreamError(percentEncoded, ['e'])).toBe(
      'gateway refused /v1beta/models/m?alt%3Dsse%26key%3D***%26foo%3D1',
    );
  });

  it('masks base64, base64url, unpadded, and case-changed credential echoes without Buffer', () => {
    const secret = 'synthetic-Secret/Key+1600=';
    const b64Std = btoa(secret);
    const b64NoPad = b64Std.replace(/=+$/, '');
    const b64Url = b64Std.replace(/\+/g, '-').replace(/\//g, '_');
    const b64UrlNoPad = b64Url.replace(/=+$/, '');
    const body = [
      `std=${b64Std}`,
      `nopad=${b64NoPad}`,
      `url=${b64Url}`,
      `urlnopad=${b64UrlNoPad}`,
      `pctb64=${encodeURIComponent(b64Std)}`,
      `lower=${secret.toLowerCase()}`,
      `upper=${secret.toUpperCase()}`,
    ].join(' ');

    const savedBuffer = (globalThis as Record<string, unknown>).Buffer;
    delete (globalThis as Record<string, unknown>).Buffer;
    try {
      const masked = redactUpstreamError(body, [secret]);
      expect(masked).toBe('std=*** nopad=*** url=*** urlnopad=*** pctb64=*** lower=*** upper=***');
    } finally {
      (globalThis as Record<string, unknown>).Buffer = savedBuffer;
    }
  });

  it('masks HTML-entity and backslash/Unicode-escaped credential echoes while preserving unrelated markup', () => {
    const secret = 'synthetic-test/key+1600';
    const htmlEcho =
      '<html><p>Docs &amp; error: synthetic&#45;test&#x2f;key&plus;1600</p><code>&lt;ok&gt;</code></html>';
    const maskedHtml = redactUpstreamError(htmlEcho, [secret]);
    expect(maskedHtml).toBe('<html><p>Docs &amp; error: ***</p><code>&lt;ok&gt;</code></html>');

    const malformedEscaped =
      '{"error":{"message":"Bad \\u0073\\u0079nthetic\\x2dtest\\/key\\u{2b}1600 and keep \\n text"';
    const maskedEscaped = redactUpstreamError(malformedEscaped, [secret]);
    expect(maskedEscaped).toBe('{"error":{"message":"Bad *** and keep \\n text"');
  });
});
