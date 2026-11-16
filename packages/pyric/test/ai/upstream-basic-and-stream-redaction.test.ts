import { describe, expect, it } from 'bun:test';
import { OpenAiEngine } from '../../src/ai/broker/openai-engine.js';
import {
  GeminiUpstream,
  isJsonErrorEnvelope,
  maskStreamErrors,
  redactUpstreamSuccessBody,
  urlCredentials,
} from '../../src/ai/internal.js';

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

  it('joins query-bearing baseUrl paths cleanly and redacts baseUrl query credentials in both GeminiUpstream and OpenAiEngine', async () => {
    const geminiBaseKey = 'GEMINI_BASE_QUERY_SECRET_11/';
    const geminiApiKey = 'GEMINI_STATIC_API_KEY_22';
    const seenGemini: string[] = [];
    const geminiUpstream = new GeminiUpstream({
      baseUrl: `http://127.0.0.1:9999/gw/?api_key=${geminiBaseKey}`,
      apiKey: geminiApiKey,
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const url = String(input);
          seenGemini.push(url);
          return new Response(
            JSON.stringify({ error: { code: 401, message: `Rejected ${geminiBaseKey} at ${url}`, status: 'UNAUTHENTICATED' } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        },
        { preconnect: fetch.preconnect },
      ),
    });
    const sent = await geminiUpstream.sendWithCredentials('models/gemini-2.5-flash', 'generateContent', '{}');
    expect(seenGemini).toEqual([
      `http://127.0.0.1:9999/gw/v1beta/models/gemini-2.5-flash:generateContent?api_key=${geminiBaseKey}&key=${geminiApiKey}`,
    ]);
    expect(sent.credentials).toContain(geminiBaseKey);

    const openAiBaseKey = 'OPENAI_BASE_QUERY_SECRET_33/';
    const seenOpenAi: string[] = [];
    const openAiEngine = new OpenAiEngine({
      baseUrl: `http://127.0.0.1:9999/v1/?api_key=${openAiBaseKey}`,
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const url = String(input);
          seenOpenAi.push(url);
          return new Response(`Unauthorized key=${openAiBaseKey} url=${url}`, { status: 401 });
        },
        { preconnect: fetch.preconnect },
      ),
    });
    let openAiError = '';
    try {
      await openAiEngine.generateContent(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        'models/gemini-2.5-flash',
      );
    } catch (err) {
      openAiError = err instanceof Error ? err.message : String(err);
    }
    expect(seenOpenAi).toEqual([
      `http://127.0.0.1:9999/v1/chat/completions?api_key=${openAiBaseKey}`,
    ]);
    expect(openAiError).not.toContain(openAiBaseKey);
    expect(openAiError).not.toContain(encodeURIComponent(openAiBaseKey));
  });

  it('masks array-wrapped and multi-line SSE JSON errors, multi-line event:error, and EOF frames without altering normal chunks', async () => {
    const encoder = new TextEncoder();
    const secretKey = 'synthetic-stream-secret-key-42';
    const normalArray =
      'data: [{"candidates":[{"content":{"parts":[{"text":"docs https://example.test/?key=public-doc"}]}}]}]\n\n';
    const arrayError =
      `data: [{"error":{"code":400,"message":"Invalid key ${secretKey}"}}]\n\n`;
    const multilineError =
      `data: {"error":{"code":400,\r\ndata: "message":"Split key ${secretKey}"}}\r\n\r\n`;
    const multilineArrayError =
      `data: [\ndata: {"error":{"code":500,"message":"Array split ${secretKey}"}}\ndata: ]\n\n`;
    const multilinePlainError =
      `event: error\ndata: line one ${secretKey}\ndata: line two ${encodeURIComponent(secretKey)}\n\n`;
    const eofMultilineError =
      `data: {"error":{"code":403,\ndata: "message":"EOF key ${secretKey}"}}`;
    const combined =
      normalArray +
      arrayError +
      multilineError +
      multilineArrayError +
      multilinePlainError +
      eofMultilineError;

    // Split across tiny chunks to exercise cross-read reassembly mid-credential and mid-newline.
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = encoder.encode(combined);
        for (let offset = 0; offset < bytes.length; offset += 13) {
          controller.enqueue(bytes.slice(offset, offset + 13));
        }
        controller.close();
      },
    });
    const result = await new Response(maskStreamErrors(input, [secretKey])).text();

    expect(result).toContain(normalArray);
    expect(result).not.toContain(secretKey);
    expect(result).not.toContain(encodeURIComponent(secretKey));
    expect(result).toContain('data: [{"error":{"code":400,"message":"Invalid key ***"}}]\n\n');
    expect(result).toContain('data: {"error":{"code":400,"message":"Split key ***"}}' + '\r\n\r\n');
    expect(result).toContain('data: [{"error":{"code":500,"message":"Array split ***"}}]\n\n');
    expect(result).toContain('event: error\ndata: line one ***\ndata: line two ***\n\n');
    expect(result).toContain('data: {"error":{"code":403,"message":"EOF key ***"}}');
  });

  it('masks individual error lines when multiple data lines appear without a blank separator and flushes complete events immediately', async () => {
    const encoder = new TextEncoder();
    const secretKey = 'synthetic-unseparated-secret-99';
    const noBlankBody =
      'data: {"candidates":[{"content":{"parts":[{"text":"ok https://example.test/?key=keep"}]}}]}\n' +
      `data: [{"error":{"code":500,"message":"Failed for ${secretKey}"}}]\n`;
    const unseparatedOut = await new Response(
      maskStreamErrors(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(noBlankBody));
            controller.close();
          },
        }),
        [secretKey],
      ),
    ).text();
    expect(unseparatedOut).toContain('https://example.test/?key=keep');
    expect(unseparatedOut).not.toContain(secretKey);
    expect(unseparatedOut).toContain('data: [{"error":{"code":500,"message":"Failed for ***"}}]\n');

    // Verify first event flushes while upstream stream stays open.
    let releaseSecond: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const incremental = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"n":1}\n\n'));
        await secondGate;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const reader = maskStreamErrors(incremental, [secretKey]).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe('data: {"n":1}\n\n');
    if (releaseSecond !== undefined) releaseSecond();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: [DONE]\n\n');
  });

  it('classifies JSON error envelopes and masks 2xx non-streaming bodies selectively per ADR 0024', () => {
    const serverKey = 'synthetic-server-key-987654/';
    const shortCred = 'ab';

    expect(isJsonErrorEnvelope({ error: { code: 400 } })).toBe(true);
    expect(isJsonErrorEnvelope([{ error: { code: 400 } }])).toBe(true);
    expect(isJsonErrorEnvelope([{ candidates: [] }, { error: { code: 500 } }])).toBe(true);
    expect(isJsonErrorEnvelope({ candidates: [] })).toBe(false);
    expect(isJsonErrorEnvelope([{ candidates: [] }])).toBe(false);

    // 200 JSON error envelopes (object or array) get full error redaction even with maskExactCredentials: false.
    const objErr = JSON.stringify({ error: { code: 400, message: `Refused https://x.test/?key=other and ${serverKey}` } });
    const maskedObjErr = redactUpstreamSuccessBody(objErr, [serverKey], { maskExactCredentials: false });
    expect(maskedObjErr).not.toContain(serverKey);
    expect(maskedObjErr).toContain('?key=***');

    const arrErr = JSON.stringify([{ error: { code: 400, message: `Refused ${serverKey}` } }]);
    const maskedArrErr = redactUpstreamSuccessBody(arrErr, [serverKey], { maskExactCredentials: false });
    expect(JSON.parse(maskedArrErr)).toEqual([{ error: { code: 400, message: 'Refused ***' } }]);

    // Error-free 200 JSON with unrelated ?key= stays untouched byte-for-byte.
    const normalJson = '{\n  "candidates": [{"text": "see https://x.test/?key=not-a-credential about abc"}]\n}';
    expect(redactUpstreamSuccessBody(normalJson, [serverKey, shortCred], { maskExactCredentials: true })).toBe(
      normalJson,
    );
    expect(redactUpstreamSuccessBody(normalJson, [serverKey], { maskExactCredentials: false })).toBe(normalJson);

    // Exact server credential echoed in 200 JSON (raw, JSON-escaped, or percent-encoded) is masked cleanly.
    const echoedJson = `{"text":"echo ${serverKey.replace('/', '\\/')} and ${encodeURIComponent(serverKey)} plus ?key=keep-me"}`;
    const maskedEcho = redactUpstreamSuccessBody(echoedJson, [serverKey, shortCred], {
      maskExactCredentials: true,
    });
    expect(maskedEcho).not.toContain(serverKey);
    expect(maskedEcho).not.toContain(encodeURIComponent(serverKey));
    expect(JSON.parse(maskedEcho)).toEqual({ text: 'echo *** and *** plus ?key=keep-me' });
  });
});
