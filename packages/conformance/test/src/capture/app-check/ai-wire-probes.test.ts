import { afterEach, describe, expect, it } from 'bun:test';
import { captureAiWireBehavior } from '../../../../src/capture/app-check/ai-wire-probes.ts';
import type { ObservationContext } from '../../../../src/capture/app-check/observation-writer.ts';

const realFetch = globalThis.fetch;
const REFUSAL = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'refused' } };

interface SentRequest {
  url: string;
  appCheck: string | null;
}

/** Replaces fetch, so the test sends nothing, and refuses every request. */
function refuseEveryRequest(): SentRequest[] {
  const sent: SentRequest[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ url, appCheck: headers['X-Firebase-AppCheck'] ?? null });
    return new Response(JSON.stringify(REFUSAL), { status: 403 });
  }) as unknown as typeof fetch;
  return sent;
}

function capture() {
  return captureAiWireBehavior({
    context: {
      projectId: 'demo',
      secrets: { appId: 'app', apiKey: 'key', projectNumber: '1', values: [] },
    } as unknown as ObservationContext,
    apiKey: 'key',
    validToken: 'head.body.signature',
  });
}

describe('AI Logic wire probes', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('sends streamGenerateContent and countTokens with no App Check header', async () => {
    const sent = refuseEveryRequest();
    await capture();
    const [stream, count] = sent.slice(-2);
    expect(stream?.url).toEndWith('/models/gemini-flash-lite-latest:streamGenerateContent?alt=sse');
    expect(stream?.appCheck).toBeNull();
    expect(count?.url).toEndWith('/models/gemini-flash-lite-latest:countTokens');
    expect(count?.appCheck).toBeNull();
  });

  it('keeps the five generateContent cases and adds two, seven requests in all', async () => {
    const sent = refuseEveryRequest();
    await capture();
    expect(sent).toHaveLength(7);
    expect(sent.slice(0, 5).every(({ url }) => url.endsWith(':generateContent'))).toBe(true);
  });

  it('records the refusal envelope of each added method', async () => {
    refuseEveryRequest();
    const behavior = await capture();
    for (const refusal of [behavior.streamGenerateContentNoHeader, behavior.countTokensNoHeader]) {
      expect(refusal).toMatchObject({ httpStatus: 403, errorStatus: 'PERMISSION_DENIED', messageText: 'refused' });
    }
  });
});
