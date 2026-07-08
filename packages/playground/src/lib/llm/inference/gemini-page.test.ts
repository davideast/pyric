import { describe, expect, test } from 'bun:test';
import { buildGeminiThinkingConfig, geminiEventsFromResponse } from './gemini-page';

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

async function drain(response: Response) {
  const out: any[] = [];
  for await (const e of geminiEventsFromResponse(response)) out.push(e);
  return out;
}

describe('gemini-page — thinking config', () => {
  test('off or absent omits Gemini thinkingConfig', () => {
    expect(buildGeminiThinkingConfig('gemini-3.5-flash', undefined)).toBeUndefined();
    expect(buildGeminiThinkingConfig('gemini-3.5-flash', 'off')).toBeUndefined();
  });

  test('Gemini 3.5 and 3 Flash use thinkingLevel', () => {
    expect(buildGeminiThinkingConfig('gemini-3.5-flash', 'medium')).toEqual({
      includeThoughts: true,
      thinkingLevel: 'medium',
    });
    expect(buildGeminiThinkingConfig('gemini-3-flash-preview', 'low')).toEqual({
      includeThoughts: true,
      thinkingLevel: 'low',
    });
  });

  test('Gemini 2.5 uses thinkingBudget', () => {
    expect(buildGeminiThinkingConfig('gemini-2.5-pro', 'high')).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
  });
});

describe('gemini-page — structured no-output errors', () => {
  test('thinking-only STOP is retryable and classified', async () => {
    const response = new Response(
      sse([
        {
          candidates: [
            {
              content: { parts: [{ text: 'thinking...', thought: true }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
      { status: 200 },
    );

    const events = await drain(response);
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      code: 'gemini.thinking_only_stop',
      retryable: true,
      details: {
        finishReason: 'STOP',
        sawThinking: true,
        sawVisibleText: false,
        sawFunctionCall: false,
      },
    });
  });
});
