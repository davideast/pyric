import { describe, expect, mock, test } from 'bun:test';

import { generateSeedProposal } from './generate';

describe('generateSeedProposal', () => {
  test('streams text chunks from inference client', async () => {
    async function* fakeStream() {
      yield { kind: 'text' as const, chunk: '{"version":1,' };
      yield { kind: 'text' as const, chunk: '"firestore":{"items":{"a":{}}}' };
      yield { kind: 'text' as const, chunk: '}' };
    }

    mock.module('~/lib/llm/inference', () => ({
      createInference: () => ({
        stream: () => fakeStream(),
      }),
    }));

    const { generateSeedProposal: gen } = await import('./generate');
    const chunks: string[] = [];
    for await (const c of gen({
      contextPayload: '{}',
      providerId: 'gemini',
      modelId: 'test',
      apiKey: 'key',
    })) {
      chunks.push(c);
    }
    expect(chunks.join('')).toContain('"version":1');
  });
});
