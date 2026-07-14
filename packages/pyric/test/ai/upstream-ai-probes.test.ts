/**
 * Upstream-mined modular AI probes (optional series PR 4).
 *
 * Sourced from firebase-js-sdk `packages/ai` unit suites against claimed
 * COMPAT rows:
 *   I1. `validateChatHistory` corpus via `startChat({ history })`
 *       — chat-session-helpers.test.ts
 *   I2. Schema builder edges — schema-builder.test.ts
 *       (empty optionalProperties, propertyOrdering, empty anyOf throw)
 *   I3. Response helper mixes — response-helpers.test.ts
 *       (text + functionCall; thoughtSummary from thought parts)
 */
import { describe, expect, test } from 'bun:test';
import { aiSeam, PROBE_MODEL, type AiSeam } from './support.ts';

let seam: AiSeam;

function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    await fn();
  });
}

function toJson(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function freshModel(entries?: unknown[]): any {
  const sandbox = seam.sandboxMod.initializeSandbox();
  const ai = seam.ai.getAI(sandbox);
  if (entries) seam.scripting.script(ai, entries);
  return seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
}

describe('I1 validateChatHistory via startChat (upstream AI probes)', () => {
  rowTest('accepts a user → model functionCall → functionResponse history', async () => {
    const model = freshModel();
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: 'hi' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'greet', args: { name: 'user' } } }],
        },
        {
          role: 'function',
          parts: [
            {
              functionResponse: { name: 'greet', response: { name: 'user' } },
            },
          ],
        },
      ],
    });
    const history = await chat.getHistory();
    expect(history.map((c: { role: string }) => c.role)).toEqual([
      'user',
      'model',
      'function',
    ]);
  });

  rowTest('rejects empty parts and a model-first history', () => {
    const model = freshModel();
    expect(() => model.startChat({ history: [{ role: 'user', parts: [] }] })).toThrow(
      /at least one part/,
    );
    expect(() =>
      model.startChat({ history: [{ role: 'model', parts: [{ text: 'hi' }] }] }),
    ).toThrow(/First Content should be with role 'user'/);
  });
});

describe('I2 Schema builder edges (upstream AI probes)', () => {
  rowTest('empty optionalProperties marks every property required', () => {
    const schema = seam.ai.Schema.object({
      properties: {
        a: seam.ai.Schema.string(),
        b: seam.ai.Schema.integer(),
      },
      optionalProperties: [],
    });
    expect(toJson(schema).required).toEqual(['a', 'b']);
  });

  rowTest('propertyOrdering is preserved on toJSON', () => {
    const schema = seam.ai.Schema.object({
      title: 'User Data',
      properties: {
        name: seam.ai.Schema.string(),
        age: seam.ai.Schema.integer(),
        email: seam.ai.Schema.string(),
      },
      propertyOrdering: ['name', 'email', 'age'],
    });
    const json = toJson(schema);
    expect(json.propertyOrdering).toEqual(['name', 'email', 'age']);
    expect(json.required).toEqual(['name', 'age', 'email']);
  });

  rowTest('empty anyOf throws invalid-schema', () => {
    expect(() => seam.ai.Schema.anyOf({ anyOf: [] })).toThrow(/anyOf.*must not be empty/i);
    try {
      seam.ai.Schema.anyOf({ anyOf: [] });
    } catch (e) {
      expect((e as { code?: string }).code).toBe('invalid-schema');
    }
  });
});

describe('I3 response helper mixes (upstream AI probes)', () => {
  rowTest('text() + functionCalls() coexist; thoughtSummary() reads thought parts', async () => {
    const model = freshModel([
      {
        respond: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'some text' },
                  { functionCall: { name: 'do', args: { x: 1 } } },
                  { text: ' and more text' },
                  { text: 'and some thoughts', thought: true },
                ],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      },
    ]);
    const result = await model.generateContent('mix');
    expect(result.response.text()).toBe('some text and more text');
    expect(result.response.functionCalls()).toEqual([{ name: 'do', args: { x: 1 } }]);
    expect(result.response.thoughtSummary()).toBe('and some thoughts');
  });
});
