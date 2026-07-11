/**
 * Red conformance suite: function-calling rows (ai#fncall-*). One test per
 * registry row id. Facts replay ai-function-call-shape,
 * ai-function-response-round, and ai-error-fncall-missing-thought-signature.
 * RED BY DESIGN until the ai mirror lands (CDD map #92).
 */
import { describe, expect, test } from 'bun:test';
import { aiSeam, observedBehavior, PROBE_MODEL, type AiSeam } from './support.ts';

const callShape = observedBehavior('ai-function-call-shape');
const roundTrip = observedBehavior('ai-function-response-round');
const missingSignature = observedBehavior('ai-error-fncall-missing-thought-signature');

let seam: AiSeam;

function weatherTools(ai: any): any[] {
  return [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: seam.ai.Schema.object({ properties: { city: seam.ai.Schema.string() } }),
        },
      ],
    },
  ];
}

function freshAi(entries?: any[]): { ai: any; model: any } {
  const sandbox = seam.sandboxMod.initializeSandbox();
  const ai = seam.ai.getAI(sandbox);
  if (entries) seam.scripting.script(ai, entries);
  const model = seam.ai.getGenerativeModel(ai, {
    model: PROBE_MODEL,
    tools: weatherTools(ai),
  });
  return { ai, model };
}

async function scriptedFunctionCallPart(): Promise<any> {
  const { model } = freshAi([
    { match: /weather/, respond: { functionCall: { name: 'get_weather', args: { city: 'Paris' } } } },
  ]);
  const result = await model.generateContent('What is the weather in Paris?');
  const parts = result.response.candidates[0].content.parts;
  return { part: parts.find((candidate: any) => candidate.functionCall), response: result.response };
}

/** Loads the seam inside the test so every row id reports its own red. */
function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    await fn();
  });
}

describe('ai: function calling', () => {
  rowTest('ai#fncall-part-shape the functionCall part carries args, id, name with args as a parsed object', async () => {
    const { part } = await scriptedFunctionCallPart();
    expect(part).toBeDefined();
    expect(Object.keys(part.functionCall).sort()).toEqual([...callShape.functionCallKeySet].sort());
    expect(callShape.argsIsObjectNotString).toBe(true);
    expect(typeof part.functionCall.args).toBe('object');
    expect(typeof part.functionCall.args).not.toBe('string');
    expect(part.functionCall.args.city).toBe('Paris');
  });

  rowTest('ai#fncall-mode-any toolConfig mode ANY forces a functionCall part finishing STOP', async () => {
    // Zero-config: no script. The synthesizer must honor mode ANY.
    const { model } = freshAi();
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'What is the weather in Paris?' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    });
    const parts = result.response.candidates[0].content.parts;
    expect(parts.some((part: any) => part.functionCall)).toBe(true);
    expect(result.response.candidates[0].finishReason).toBe(callShape.finishReason);
  });

  rowTest('ai#fncall-id-present functionCall.id is present as captured on the GoogleAI wire', async () => {
    expect(callShape.functionCallKeySet).toContain('id');
    const { part } = await scriptedFunctionCallPart();
    expect(part.functionCall.id).toBeDefined();
    expect(String(part.functionCall.id).length).toBeGreaterThan(0);
  });

  rowTest('ai#fncall-round-trip a verbatim replay of the model functionCall turn with thoughtSignature is accepted', async () => {
    const { part } = await scriptedFunctionCallPart();
    expect(roundTrip.threadedModelTurnHadThoughtSignature).toBe(true);
    const { model } = freshAi([{ respond: { text: 'It is sunny in Paris.' } }]);
    const result = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: 'What is the weather in Paris?' }] },
        { role: 'model', parts: [part] },
        {
          role: 'function',
          parts: [{ functionResponse: { name: 'get_weather', response: { conditions: 'sunny' } } }],
        },
      ],
    });
    const answerParts = result.response.candidates[0].content.parts;
    expect(roundTrip.answerHasTextPart).toBe(true);
    expect(roundTrip.answerHasFunctionCallPart).toBe(false);
    expect(answerParts.some((answerPart: any) => typeof answerPart.text === 'string')).toBe(true);
    expect(answerParts.some((answerPart: any) => answerPart.functionCall)).toBe(false);
    expect(result.response.candidates[0].finishReason).toBe(roundTrip.finishReason);
  });

  rowTest('ai#fncall-thought-signature-required a replayed model functionCall turn without thoughtSignature is rejected 400 INVALID_ARGUMENT', async () => {
    const { part } = await scriptedFunctionCallPart();
    const stripped = { functionCall: part.functionCall };
    const { model } = freshAi();
    expect(missingSignature.httpStatus).toBe(400);
    expect(missingSignature.errorStatus).toBe('INVALID_ARGUMENT');
    let thrown: any;
    try {
      await model.generateContent({
        contents: [
          { role: 'user', parts: [{ text: 'What is the weather in Paris?' }] },
          { role: 'model', parts: [stripped] },
          {
            role: 'function',
            parts: [{ functionResponse: { name: 'get_weather', response: { conditions: 'sunny' } } }],
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown.message)).toContain('thought_signature');
    expect(thrown.customErrorData?.status).toBe(missingSignature.httpStatus);
  });

  rowTest('ai#fncall-signature-minted the engine mints thoughtSignature on every synthesized functionCall part', async () => {
    const { part } = await scriptedFunctionCallPart();
    expect(typeof part.thoughtSignature).toBe('string');
    expect(part.thoughtSignature.length).toBeGreaterThan(0);
  });
});
