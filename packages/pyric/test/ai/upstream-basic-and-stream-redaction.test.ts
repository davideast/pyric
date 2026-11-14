import { describe, expect, it } from 'bun:test';
import { maskStreamErrors, urlCredentials } from '../../src/ai/internal.js';

const TEST_BEARER_CREDENTIAL = 'synthetic-adc-bearer-credential-01';
const TEST_QUERY_CREDENTIAL = 'synthetic-api-key-credential-02';

describe('urlCredentials and maskStreamErrors', () => {
  it('extracts raw, decoded, and synthesized Basic-auth base64 credentials from URL userinfo across Node and Buffer-less runtimes', () => {
    const basicTwoEqPad = btoa('ab:cd');
    const basicZeroPad = btoa('abc:de');
    const basicOneEqPad = btoa('abcd:ef');

    expect(urlCredentials('http://ab:cd@127.0.0.1:8080/v1')).toContain(basicTwoEqPad);
    expect(urlCredentials('http://abc:de@127.0.0.1:8080/v1')).toContain(basicZeroPad);
    expect(urlCredentials('http://abcd:ef@127.0.0.1:8080/v1')).toContain(basicOneEqPad);

    const savedBuffer = (globalThis as Record<string, unknown>).Buffer;
    delete (globalThis as Record<string, unknown>).Buffer;
    try {
      const credsWithoutBuffer = urlCredentials('http://gw-svc:GW_SECRET_99@127.0.0.1:8080');
      expect(credsWithoutBuffer).toContain('gw-svc');
      expect(credsWithoutBuffer).toContain('GW_SECRET_99');
      expect(credsWithoutBuffer).toContain(btoa('gw-svc:GW_SECRET_99'));
      expect(urlCredentials('http://127.0.0.1:8080/v1')).toEqual([]);
    } finally {
      (globalThis as Record<string, unknown>).Buffer = savedBuffer;
    }
  });

  it('masks credentials inside SSE error frames while passing completion deltas and [DONE] through unchanged', async () => {
    const encoder = new TextEncoder();
    const ssePayload =
      'data: {"choices":[{"delta":{"content":"hello https://example.test/?key=public-doc"}}]}\n\n' +
      `data: {"error":{"message":"Auth failed for ${TEST_BEARER_CREDENTIAL} and ${TEST_QUERY_CREDENTIAL}"}}\n\n` +
      'event: error\n' +
      `data: Gateway rejected Basic ${btoa('svc:pw-secret')}\n\n` +
      'data: [DONE]\n\n';
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload.slice(0, 45)));
        controller.enqueue(encoder.encode(ssePayload.slice(45)));
        controller.close();
      },
    });
    const maskedStream = maskStreamErrors(input, [
      TEST_BEARER_CREDENTIAL,
      TEST_QUERY_CREDENTIAL,
      btoa('svc:pw-secret'),
      'pw-secret',
    ]);
    const result = await new Response(maskedStream).text();
    expect(result).toContain(
      'data: {"choices":[{"delta":{"content":"hello https://example.test/?key=public-doc"}}]}',
    );
    expect(result).not.toContain(TEST_BEARER_CREDENTIAL);
    expect(result).not.toContain(TEST_QUERY_CREDENTIAL);
    expect(result).not.toContain(btoa('svc:pw-secret'));
    expect(result).toContain('data: [DONE]');
  });
});
