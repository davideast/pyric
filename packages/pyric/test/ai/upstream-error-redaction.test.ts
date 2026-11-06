/**
 * The upstream error masking the gemini proxy (#1584) and the gemini engine
 * (#1631) share: the credential a request carried
 * is removed in every form an upstream can quote it, and a JSON envelope
 * stays JSON with Gemini's own status and message.
 */
import { describe, expect, it } from 'bun:test';
import { redactUpstreamError } from '../../src/ai/broker/upstream-error-redaction.js';

const KEY = 'AIzaSy-test/key+1584';
const TOKEN = 'ya29.a0AfB_test-adc-token';
const URL_WITH_KEY = `https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse&key=${KEY}`;

function envelope(message: string, status = 'INVALID_ARGUMENT') {
  return JSON.stringify({ error: { code: 400, message, status } });
}

describe('redactUpstreamError', () => {
  it('masks a key joined with & in a JSON echo, where JSON escapes the &', () => {
    const body = `{"error":{"code":400,"message":"Bad request to ${URL_WITH_KEY.replace('&', '\\u0026')}","status":"INVALID_ARGUMENT"}}`;
    const masked = redactUpstreamError(body, [KEY]);
    expect(masked).not.toContain(KEY);
    expect(JSON.parse(masked).error.message).toBe(`Bad request to ${URL_WITH_KEY.replace(KEY, '***')}`);
  });

  it('masks a percent-encoded key', () => {
    const body = `gateway refused /v1beta/models/m:generateContent?alt%3Dsse%26key%3D${encodeURIComponent(KEY)}`;
    const masked = redactUpstreamError(body, [KEY]);
    expect(masked).not.toContain(encodeURIComponent(KEY));
    expect(masked).not.toContain(KEY);
    expect(masked).toBe('gateway refused /v1beta/models/m:generateContent?alt%3Dsse%26key%3D***');
  });

  it('masks a key quoted in plain text, in a JSON value, and in an echoed header', () => {
    const text = `API key ${KEY} is invalid.\nx-goog-api-key: ${KEY}`;
    expect(redactUpstreamError(text, [KEY])).toBe('API key *** is invalid.\nx-goog-api-key: ***');
    const json = JSON.stringify({ key: KEY, [KEY]: 'as a name' });
    expect(JSON.parse(redactUpstreamError(json, [KEY]))).toEqual({ key: '***', '***': 'as a name' });
  });

  it('masks an ADC token echoed in an Authorization header', () => {
    const text = `upstream rejected: Authorization: Bearer ${TOKEN}`;
    expect(redactUpstreamError(text, [TOKEN])).toBe('upstream rejected: Authorization: Bearer ***');
  });

  it('keeps a JSON envelope parseable, with Gemini\'s status, when a URL ends its message', () => {
    const body = envelope(`Request failed: ${URL_WITH_KEY}`, 'PERMISSION_DENIED');
    const parsed = JSON.parse(redactUpstreamError(body, [KEY]));
    expect(parsed).toEqual({ error: { code: 400, message: `Request failed: ${URL_WITH_KEY.replace(KEY, '***')}`, status: 'PERMISSION_DENIED' } });
  });

  it('keeps an envelope parseable when only the URL pattern catches a credential', () => {
    const body = envelope('Request failed: https://x.test/v1beta/m?key=some-other-key');
    const parsed = JSON.parse(redactUpstreamError(body, [KEY]));
    expect(parsed.error).toEqual({ code: 400, message: 'Request failed: https://x.test/v1beta/m?key=***', status: 'INVALID_ARGUMENT' });
  });

  it('masks a body that is not JSON as text, with the URL pattern as a second pass', () => {
    const text = `<html>502 from ${URL_WITH_KEY} and https://x.test/?access_token=other here</html>`;
    expect(redactUpstreamError(text, [KEY])).toBe(
      `<html>502 from ${URL_WITH_KEY.replace(KEY, '***')} and https://x.test/?access_token=*** here</html>`,
    );
  });

  it('leaves an error with no credential in it unchanged', () => {
    const body = envelope('Resource exhausted.', 'RESOURCE_EXHAUSTED');
    expect(redactUpstreamError(body, [KEY])).toBe(body);
    expect(redactUpstreamError('plain', [])).toBe('plain');
  });
});
