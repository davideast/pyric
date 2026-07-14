import { describe, expect, it } from 'bun:test';
import type { FirebaseApp } from 'firebase/app';
import { getGenerativeModel, TARGET_SYMBOL } from '../../src/ai/index.ts';
import { aiErrorFromEnvelope, createTransportAI } from '../../src/ai/internal.ts';
import type { AnswerEngine } from '../../src/ai/broker/types.ts';

describe('AI transport targets', () => {
  it('shares the production-shaped wire error translator with served transports', () => {
    const error = aiErrorFromEnvelope(
      { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } },
      'models/gemini-test',
      'generateContent',
    );

    expect(error.code).toBe('fetch-error');
    expect(error.message).toContain('[503 Service Unavailable] overloaded');
    expect(error.customErrorData).toMatchObject({ status: 503, statusText: 'Service Unavailable' });
  });

  it('dispatches directly to the transport without constructing a page-local broker', async () => {
    const calls: string[] = [];
    const transport: AnswerEngine = {
      async generateContent() {
        calls.push('generateContent');
        return {
          candidates: [{ content: { role: 'model', parts: [{ text: 'worker' }] } }],
        };
      },
      streamGenerateContent() {
        calls.push('streamGenerateContent');
        return (async function* stream() {
          yield { candidates: [{ content: { role: 'model', parts: [{ text: 'worker' }] } }] };
        })();
      },
      async countTokens() {
        calls.push('countTokens');
        return { totalTokens: 1, promptTokensDetails: [] };
      },
    };
    const app = {
      name: 'transport-app',
      options: { projectId: 'transport-project' },
      automaticDataCollectionEnabled: false,
    } as FirebaseApp;

    const ai = createTransportAI(app, undefined, transport);
    const repeated = createTransportAI(app, undefined, transport);
    const target = (ai as unknown as Record<PropertyKey, unknown>)[TARGET_SYMBOL] as Record<string, unknown>;
    const model = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });

    expect(repeated).toBe(ai);
    expect(target.kind).toBe('transport');
    expect('broker' in target).toBe(false);
    expect('sandbox' in target).toBe(false);
    expect((await model.generateContent('hello')).response.text()).toBe('worker');
    expect((await model.countTokens('hello')).totalTokens).toBe(1);
    const streamed = await model.generateContentStream('hello');
    for await (const _chunk of streamed.stream) {
      // Drain the stream so the transport operation completes.
    }
    expect(calls).toEqual(['generateContent', 'countTokens', 'streamGenerateContent']);
  });
});
