/**
 * Red conformance suite: `GenerativeModel.generateContent` envelope rows
 * (ai#generate-*). One test per registry row id. Envelope facts replay the
 * frozen capture ai-generate-minimal-envelope and friends; generated text
 * values are never asserted here.
 * RED BY DESIGN until the ai mirror lands (CDD map #92).
 */
import { describe, expect, test } from 'bun:test';
import { dataKeys, aiSeam, observedBehavior, PROBE_MODEL, type AiSeam } from './support.ts';

const envelope = observedBehavior('ai-generate-minimal-envelope');

let seam: AiSeam;
let sandbox: any;
let model: any;

async function minimalResponse(): Promise<any> {
  const result = await model.generateContent('Reply with exactly one word.');
  return result.response;
}

/** Loads the seam inside the test so every row id reports its own red. */
function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    if (!model) {
      sandbox = seam.sandboxMod.initializeSandbox();
      model = seam.ai.getGenerativeModel(seam.ai.getAI(sandbox), { model: PROBE_MODEL });
    }
    await fn();
  });
}

describe('ai: generateContent envelope', () => {
  rowTest('ai#generate-envelope-keys the top-level key set matches the capture', async () => {
    const response = await minimalResponse();
    expect(dataKeys(response)).toEqual([...envelope.topLevelKeySet].sort());
  });

  rowTest('ai#generate-candidate-keys the candidate key set matches the capture and index is 0', async () => {
    const response = await minimalResponse();
    const candidate = response.candidates[0];
    expect(Object.keys(candidate).sort()).toEqual([...envelope.candidateKeySet].sort());
    expect(envelope.candidateHasIndexOnWire).toBe(true);
    expect(candidate.index).toBe(0);
  });

  rowTest('ai#generate-role-model candidate content carries role model with the captured content key set', async () => {
    const response = await minimalResponse();
    const content = response.candidates[0].content;
    expect(content.role).toBe(envelope.contentRole);
    expect(Object.keys(content).sort()).toEqual([...envelope.contentKeySet].sort());
  });

  rowTest('ai#generate-finish-stop a normal completion finishes STOP', async () => {
    const response = await minimalResponse();
    expect(response.candidates[0].finishReason).toBe(envelope.finishReason);
    expect(response.candidates[0].finishReason).toBe(seam.ai.FinishReason.STOP);
  });

  rowTest('ai#generate-usage-key-set the usageMetadata key set matches the capture', async () => {
    const response = await minimalResponse();
    expect(Object.keys(response.usageMetadata).sort()).toEqual([...envelope.usageKeySet].sort());
  });

  rowTest('ai#generate-usage-service-tier serviceTier rides usageMetadata despite being untyped', async () => {
    const response = await minimalResponse();
    expect(envelope.usageServiceTierPresent).toBe(true);
    expect('serviceTier' in response.usageMetadata).toBe(true);
  });

  rowTest('ai#generate-modelversion-responseid modelVersion and responseId are minted deterministically', async () => {
    const first = await minimalResponse();
    const second = await minimalResponse();
    expect(typeof first.modelVersion).toBe('string');
    expect(first.modelVersion.length).toBeGreaterThan(0);
    expect(typeof first.responseId).toBe('string');
    expect(first.responseId.length).toBeGreaterThan(0);
    expect(second.modelVersion).toBe(first.modelVersion);
  });

  rowTest('ai#generate-string-request a plain string request is wrapped as a single user turn', async () => {
    const scriptedSandbox = seam.sandboxMod.initializeSandbox();
    const ai = seam.ai.getAI(scriptedSandbox);
    seam.scripting.script(ai, [
      {
        match: (request: any) =>
          Array.isArray(request.contents) &&
          request.contents.length === 1 &&
          request.contents[0].role === 'user' &&
          request.contents[0].parts[0].text === 'wrap me',
        respond: { text: 'wrapped' },
      },
    ]);
    const scriptedModel = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
    const result = await scriptedModel.generateContent('wrap me');
    expect(result.response.text()).toBe('wrapped');
  });

  rowTest('ai#generate-system-instruction systemInstruction is accepted and the envelope shape is unaffected', async () => {
    const facts = observedBehavior('ai-system-instruction-accepted');
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly one word.' }] }],
      systemInstruction: 'You always answer in lowercase.',
    });
    expect(dataKeys(result.response)).toEqual([...facts.topLevelKeySet].sort());
    expect(result.response.candidates[0].finishReason).toBe(facts.finishReason);
  });

  rowTest('ai#generate-structured-output responseSchema yields a text part parsing as JSON with the schema key set', async () => {
    const facts = observedBehavior('ai-structured-output-shape');
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
    expect(result.response.candidates[0].finishReason).toBe(facts.finishReason);
  });

  rowTest('ai#generate-thinking-signature text parts carry thoughtSignature and no thought parts on the lite model', async () => {
    const facts = observedBehavior('ai-thinking-thought-parts');
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly one word.' }] }],
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    });
    const parts = result.response.candidates[0].content.parts;
    expect(facts.anyThoughtPart).toBe(false);
    expect(facts.anyThoughtSignature).toBe(true);
    expect(parts.some((part: any) => part.thought === true)).toBe(false);
    expect(parts.some((part: any) => typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0)).toBe(true);
  });

  rowTest('ai#generate-abort-signal a pre-aborted SingleRequestOptions.signal rejects the call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      model.generateContent(
        { contents: [{ role: 'user', parts: [{ text: 'never delivered' }] }] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  rowTest('ai#generate-decoration-synthesized token counts are minted and the minimal envelope omits safetyRatings', async () => {
    const response = await minimalResponse();
    const usage = response.usageMetadata;
    expect(Number.isInteger(usage.promptTokenCount)).toBe(true);
    expect(Number.isInteger(usage.totalTokenCount)).toBe(true);
    expect(usage.totalTokenCount).toBeGreaterThan(0);
    // The captured candidate key set has no safetyRatings; the sandbox matches.
    expect(envelope.candidateKeySet).not.toContain('safetyRatings');
    expect('safetyRatings' in response.candidates[0]).toBe(false);
  });
});
