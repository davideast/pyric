/**
 * Red conformance suite: response helper rows (ai#helper-*) and Schema
 * builder rows (ai#schema-*). One test per registry row id. Helper text
 * values are asserted only where the scripted engine was explicitly
 * scripted to return them.
 * RED BY DESIGN until the ai mirror lands (CDD map #92).
 */
import { describe, expect, test } from 'bun:test';
import { aiSeam, observedBehavior, PROBE_MODEL, type AiSeam } from './support.ts';

let seam: AiSeam;

/** Loads the seam inside the test so every row id reports its own red. */
function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    await fn();
  });
}

function freshModel(entries?: any[]): any {
  const sandbox = seam.sandboxMod.initializeSandbox();
  const ai = seam.ai.getAI(sandbox);
  if (entries) seam.scripting.script(ai, entries);
  return seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
}

function toJson(schema: any): any {
  return JSON.parse(JSON.stringify(schema));
}

describe('ai: response helpers', () => {
  rowTest('ai#helper-text text() concatenates the text parts of the first candidate', async () => {
    const model = freshModel([
      {
        respond: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hello' }, { text: ' world' }] },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      },
    ]);
    const result = await model.generateContent('greet');
    expect(result.response.text()).toBe('Hello world');
  });

  rowTest('ai#helper-text-throws text() throws on bad finish reasons such as SAFETY', async () => {
    const model = freshModel([
      {
        respond: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'partial' }] },
              finishReason: 'SAFETY',
              index: 0,
              safetyRatings: [],
            },
          ],
        },
      },
    ]);
    const result = await model.generateContent('blocked');
    expect(() => result.response.text()).toThrow();
  });

  rowTest('ai#helper-functioncalls functionCalls() returns the FunctionCall array with parsed args', async () => {
    const facts = observedBehavior('ai-function-call-shape');
    const model = freshModel([
      { respond: { functionCall: { name: 'get_weather', args: { city: 'Paris' } } } },
    ]);
    const result = await model.generateContent('weather please');
    const calls = result.response.functionCalls();
    expect(Array.isArray(calls)).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('get_weather');
    expect(facts.argsIsObjectNotString).toBe(true);
    expect(typeof calls[0].args).toBe('object');
    expect(calls[0].args.city).toBe('Paris');
  });

  rowTest('ai#helper-thoughtsummary thoughtSummary() returns undefined when no part is flagged thought', async () => {
    const facts = observedBehavior('ai-thinking-thought-parts');
    expect(facts.anyThoughtPart).toBe(false);
    const model = freshModel([{ respond: { text: 'plain answer' } }]);
    const result = await model.generateContent('think about it');
    expect(result.response.thoughtSummary()).toBeUndefined();
  });

  rowTest('ai#helper-inlinedataparts inlineDataParts() returns InlineDataPart entries and undefined when none exist', async () => {
    const withInline = freshModel([
      {
        respond: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'here is a pixel' },
                  { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
                ],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      },
    ]);
    const inlineResult = await withInline.generateContent('draw');
    const parts = inlineResult.response.inlineDataParts();
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBe(1);
    expect(parts[0].inlineData.mimeType).toBe('image/png');

    const withoutInline = freshModel([{ respond: { text: 'no media' } }]);
    const textResult = await withoutInline.generateContent('draw');
    expect(textResult.response.inlineDataParts()).toBeUndefined();
  });

  rowTest('ai#helper-tolerates-missing-decor helpers tolerate an envelope without decoration', async () => {
    const model = freshModel([
      {
        respond: {
          candidates: [{ content: { role: 'model', parts: [{ text: 'bare' }] } }],
        },
      },
    ]);
    const result = await model.generateContent('bare envelope');
    expect(result.response.text()).toBe('bare');
    expect(result.response.functionCalls()).toBeUndefined();
  });
});

describe('ai: Schema builders', () => {
  rowTest('ai#schema-object-tojson Schema.object serializes properties and derives required from optionalProperties', () => {
    const schema = seam.ai.Schema.object({
      properties: {
        city: seam.ai.Schema.string(),
        days: seam.ai.Schema.integer(),
      },
      optionalProperties: ['days'],
    });
    const json = toJson(schema);
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties).sort()).toEqual(['city', 'days']);
    expect(json.required).toEqual(['city']);
  });

  rowTest('ai#schema-string-enum Schema.enumString carries the enum values with format enum', () => {
    const json = toJson(seam.ai.Schema.enumString({ enum: ['red', 'green', 'blue'] }));
    expect(json.type).toBe('string');
    expect(json.enum).toEqual(['red', 'green', 'blue']);
    expect(json.format).toBe('enum');
  });

  rowTest('ai#schema-primitives each primitive builder serializes its SchemaType and array carries items', () => {
    expect(toJson(seam.ai.Schema.string()).type).toBe('string');
    expect(toJson(seam.ai.Schema.integer()).type).toBe('integer');
    expect(toJson(seam.ai.Schema.number()).type).toBe('number');
    expect(toJson(seam.ai.Schema.boolean()).type).toBe('boolean');
    const arrayJson = toJson(seam.ai.Schema.array({ items: seam.ai.Schema.string() }));
    expect(arrayJson.type).toBe('array');
    expect(arrayJson.items.type).toBe('string');
  });

  rowTest('ai#schema-anyof Schema.anyOf produces an AnyOfSchema with an anyOf array and no top-level type', () => {
    const schema = seam.ai.Schema.anyOf({ anyOf: [seam.ai.Schema.string(), seam.ai.Schema.integer()] });
    expect(schema).toBeInstanceOf(seam.ai.AnyOfSchema);
    const json = toJson(schema);
    expect(Array.isArray(json.anyOf)).toBe(true);
    expect(json.anyOf.length).toBe(2);
    expect(json.type).toBeUndefined();
  });

  rowTest('ai#schema-rides-request a built Schema serializes into generationConfig.responseSchema on the request', async () => {
    const facts = observedBehavior('ai-structured-output-shape');
    const sandbox = seam.sandboxMod.initializeSandbox();
    const ai = seam.ai.getAI(sandbox);
    seam.scripting.script(ai, [
      {
        match: (request: any) =>
          request.generationConfig?.responseMimeType === 'application/json' &&
          request.generationConfig?.responseSchema?.type === 'object' &&
          'word' in (request.generationConfig?.responseSchema?.properties ?? {}),
        respond: { json: { word: 'ember' } },
      },
    ]);
    const model = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'Pick a word.' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: seam.ai.Schema.object({ properties: { word: seam.ai.Schema.string() } }),
      },
    });
    expect(facts.textParsesAsJson).toBe(true);
    const parsed = JSON.parse(result.response.text());
    expect(Object.keys(parsed).sort()).toEqual([...facts.parsedKeySet].sort());
  });
});
