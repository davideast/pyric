import { describe, expect, it } from 'bun:test';
import { probe as midStreamProbe } from '../../../conformance/probes/ai/ai-offline-mid-stream-error-handling.ts';
import { GeminiEngine } from '../../src/ai/broker/gemini-engine.js';
import { maskStreamErrors } from '../../src/ai/internal.js';

describe('mid-stream SSE error handling SDK baseline and #3198 redaction preservation (#1753)', () => {
  it('verifies installed @firebase/ai skips candidate-less JSON error chunks while surfacing trailing parse errors', async () => {
    expect(midStreamProbe.pendingRowLink).toBe(true);
    expect(midStreamProbe.rowIds).toEqual([]);
    const observed = (await midStreamProbe.observe()) as {
      objectMidStreamError: {
        yieldedTexts: string[];
        yieldedChunkCount: number;
        aggregateText: string | null;
        threw: unknown;
      };
      arrayMidStreamError: {
        yieldedTexts: string[];
        yieldedChunkCount: number;
        aggregateText: string | null;
        threw: unknown;
      };
      trailingUnparsedFrame: {
        yieldedTexts: string[];
        yieldedChunkCount: number;
        aggregateText: string | null;
        threw: { isAIError: boolean; code: string | null } | null;
      };
    };

    expect(observed.objectMidStreamError).toEqual({
      yieldedTexts: ['alpha ', 'beta'],
      yieldedChunkCount: 2,
      aggregateText: 'alpha beta',
      threw: null,
    });
    expect(observed.arrayMidStreamError).toEqual({
      yieldedTexts: ['alpha ', 'beta'],
      yieldedChunkCount: 2,
      aggregateText: 'alpha beta',
      threw: null,
    });
    expect(observed.trailingUnparsedFrame.threw?.isAIError).toBe(true);
    expect(observed.trailingUnparsedFrame.threw?.code).toContain('parse-failed');
  });

  it('preserves #3198/#1600 mid-stream credential masking on GeminiEngine and maskStreamErrors until live wire capture lands', async () => {
    const secretKey = 'AIzaSy-MidStreamSecret-1753';
    const rawFrames =
      'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"part-1"}]}}]}\r\n\r\n' +
      `data: {"error":{"code":500,"message":"Upstream fault for ${secretKey}","status":"INTERNAL"}}\r\n\r\n`;

    const maskedText = await new Response(
      maskStreamErrors(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(rawFrames));
            controller.close();
          },
        }),
        [secretKey],
      ),
    ).text();
    expect(maskedText).not.toContain(secretKey);
    expect(maskedText).toContain('"Upstream fault for ***"');

    const engine = new GeminiEngine({
      apiKey: secretKey,
      baseUrl: 'http://127.0.0.1:19999',
      fetch: Object.assign(
        async () =>
          new Response(rawFrames, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        { preconnect: fetch.preconnect },
      ),
    });

    const chunks: unknown[] = [];
    for await (const chunk of engine.streamGenerateContent(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      'gemini-2.5-flash',
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(JSON.stringify(chunks[1])).not.toContain(secretKey);
    expect(JSON.stringify(chunks[1])).toContain('Upstream fault for ***');
  });
});
