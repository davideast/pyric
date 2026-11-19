/**
 * Oracle conformance replay for the 3 live `firebase/ai` client SDK captures:
 *   - `ai-sdk-generate-envelope-and-string-request` (9 rows)
 *   - `ai-sdk-structured-system-and-thinking` (5 rows)
 *   - `ai-sdk-response-helpers-functioncalls` (1 row)
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  FinishReason,
  FunctionCallingMode,
  Schema,
  getAI,
  getGenerativeModel,
} from 'pyric/ai';
import { script } from 'pyric/ai/scripting';
import { dataKeys, PROBE_MODEL } from './support.ts';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
);

interface GenerateEnvelopeBehavior {
  httpStatus: number;
  wireCallCount: number;
  outboundStringPrompt: {
    contentsLength: number;
    firstRole: string;
    firstPartsLength: number;
    firstPartTextMatchesPrompt: boolean;
  };
  wireEnvelope: {
    topLevelKeySet: string[];
    candidateKeySet: string[];
    candidateHasIndexOnWire: boolean;
    candidateWireIndex: number;
    contentRole: string;
    contentKeySet: string[];
    finishReason: string;
    usageKeySet: string[];
    usageHasPromptTokenCount: boolean;
    usageHasCandidatesTokenCount: boolean;
    usageHasPromptTokensDetails: boolean;
    usageHasTotalTokenCount: boolean;
    usageServiceTierPresent: boolean;
    modelVersionNonEmptyString: boolean;
    responseIdNonEmptyString: boolean;
  };
  enhancedResponse: {
    candidateIndex: number;
    finishReason: string;
    usageServiceTierPresent: boolean;
    helperTextIsNonEmptyString: boolean;
    helperTextMatchesConcatenatedNonThoughtParts: boolean;
    helperInlineDataPartsIsUndefined: boolean;
    helperFunctionCallsIsUndefined: boolean;
  };
}

interface StructuredSystemThinkingBehavior {
  wireCallCount: number;
  systemInstruction: {
    httpStatus: number;
    outboundRole: string;
    outboundPartsLength: number;
    outboundTextMatchesInput: boolean;
    wireTopLevelKeySet: string[];
    finishReason: string;
  };
  structuredOutput: {
    httpStatus: number;
    outboundResponseMimeType: string;
    outboundResponseSchema: Record<string, unknown>;
    textParsesAsJson: boolean;
    parsedKeySet: string[];
    finishReason: string;
  };
  thinking: {
    httpStatus: number;
    anyThoughtPart: boolean;
    anyThoughtSignature: boolean;
    helperThoughtSummaryIsUndefined: boolean;
    finishReason: string;
  };
}

interface FunctionCallsHelperBehavior {
  httpStatus: number;
  wireCallCount: number;
  outboundToolRequest: {
    declarationName: string;
    parametersJson: Record<string, unknown>;
    callingMode: string;
  };
  wireFunctionCall: {
    present: boolean;
    functionCallKeySet: string[];
    hasThoughtSignature: boolean;
    finishReason: string;
  };
  helperFunctionCalls: {
    isArray: boolean;
    count: number;
    firstName: string;
    argsIsPlainObject: boolean;
    argsHasCityString: boolean;
    inlineDataPartsIsUndefined: boolean;
  };
}

function loadObservation<T>(fileName: string): T {
  const raw = readFileSync(join(OBS_DIR, fileName), 'utf8');
  const parsed = JSON.parse(raw) as { behavior: T };
  return parsed.behavior;
}

describe('oracle replay: live firebase/ai generateContent, Schema, and response helpers', () => {
  it('replays string-prompt request normalization, wire envelope keys, and text() helper', async () => {
    const facts = loadObservation<GenerateEnvelopeBehavior>(
      'ai-sdk-generate-envelope-and-string-request.json',
    );
    expect(facts.httpStatus).toBe(200);
    expect(facts.wireCallCount).toBe(1);

    const prompt = 'Reply with one word: pong';
    let capturedRequest: Record<string, unknown> | null = null;
    const scriptedSandbox = initializeSandbox();
    const scriptedAi = getAI(scriptedSandbox);
    script(scriptedAi, [
      {
        match(req) {
          capturedRequest = req as unknown as Record<string, unknown>;
          return true;
        },
        respond: { text: 'pong' },
      },
    ]);
    const scriptedModel = getGenerativeModel(scriptedAi, { model: PROBE_MODEL });
    await scriptedModel.generateContent(prompt);

    expect(capturedRequest).not.toBeNull();
    const contents = (capturedRequest as { contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }> } | null)?.contents ?? [];
    expect(contents.length).toBe(facts.outboundStringPrompt.contentsLength);
    expect(contents[0]?.role).toBe(facts.outboundStringPrompt.firstRole);
    const firstParts = contents[0]?.parts ?? [];
    expect(firstParts.length).toBe(facts.outboundStringPrompt.firstPartsLength);
    expect(firstParts[0]?.text === prompt).toBe(
      facts.outboundStringPrompt.firstPartTextMatchesPrompt,
    );

    const sandbox = initializeSandbox();
    const model = getGenerativeModel(getAI(sandbox), { model: PROBE_MODEL });
    const firstResult = await model.generateContent(prompt);
    const secondResult = await model.generateContent(prompt);
    const response = firstResult.response;

    expect(dataKeys(response)).toEqual(facts.wireEnvelope.topLevelKeySet);
    const candidates = response.candidates ?? [];
    const candidate = candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) {
      throw new Error('Expected first candidate');
    }
    expect(Object.keys(candidate).sort()).toEqual(facts.wireEnvelope.candidateKeySet);
    expect('index' in candidate).toBe(facts.wireEnvelope.candidateHasIndexOnWire);
    expect(candidate.index).toBe(facts.wireEnvelope.candidateWireIndex);
    expect(candidate.index).toBe(facts.enhancedResponse.candidateIndex);

    const content = candidate.content;
    expect(content?.role).toBe(facts.wireEnvelope.contentRole);
    expect(Object.keys(content ?? {}).sort()).toEqual(facts.wireEnvelope.contentKeySet);
    expect(candidate.finishReason).toBe(facts.wireEnvelope.finishReason);
    expect(candidate.finishReason).toBe(FinishReason.STOP);

    const usage = response.usageMetadata;
    expect(usage).toBeDefined();
    if (!usage) {
      throw new Error('Expected usageMetadata');
    }
    expect(Object.keys(usage).sort()).toEqual(facts.wireEnvelope.usageKeySet);
    expect('serviceTier' in usage).toBe(facts.wireEnvelope.usageServiceTierPresent);
    expect('serviceTier' in usage).toBe(facts.enhancedResponse.usageServiceTierPresent);

    expect(typeof response.modelVersion === 'string' && response.modelVersion.length > 0).toBe(
      facts.wireEnvelope.modelVersionNonEmptyString,
    );
    expect(typeof response.responseId === 'string' && response.responseId.length > 0).toBe(
      facts.wireEnvelope.responseIdNonEmptyString,
    );
    expect(secondResult.response.modelVersion).toBe(response.modelVersion);
    expect(secondResult.response.responseId).not.toBe(response.responseId);

    const helperText = response.text();
    let concatenatedText = '';
    const responseParts = content?.parts ?? [];
    for (const part of responseParts) {
      if (typeof part.text === 'string' && !part.thought) {
        concatenatedText += part.text;
      }
    }
    expect(helperText.length > 0).toBe(facts.enhancedResponse.helperTextIsNonEmptyString);
    expect(helperText === concatenatedText).toBe(
      facts.enhancedResponse.helperTextMatchesConcatenatedNonThoughtParts,
    );
    expect(response.inlineDataParts() === undefined).toBe(
      facts.enhancedResponse.helperInlineDataPartsIsUndefined,
    );
    expect(response.functionCalls() === undefined).toBe(
      facts.enhancedResponse.helperFunctionCallsIsUndefined,
    );
  });

  it('replays systemInstruction, Schema responseSchema JSON output, and thinkingConfig signature', async () => {
    const facts = loadObservation<StructuredSystemThinkingBehavior>(
      'ai-sdk-structured-system-and-thinking.json',
    );
    expect(facts.wireCallCount).toBe(3);

    let capturedSysReq: Record<string, unknown> | null = null;
    let capturedSchemaReq: Record<string, unknown> | null = null;
    const inspectSandbox = initializeSandbox();
    const inspectAi = getAI(inspectSandbox);
    script(inspectAi, [
      {
        match(req) {
          capturedSysReq = req as unknown as Record<string, unknown>;
          return true;
        },
        respond: { text: 'pong' },
      },
      {
        match(req) {
          capturedSchemaReq = req as unknown as Record<string, unknown>;
          return true;
        },
        respond: { json: { word: 'water' } },
      },
    ]);
    const inspectModel = getGenerativeModel(inspectAi, { model: PROBE_MODEL });
    const sysInstructionText = 'Answer in lowercase.';
    await inspectModel.generateContent({
      systemInstruction: sysInstructionText,
      contents: [{ role: 'user', parts: [{ text: 'Say pong.' }] }],
    });

    const sysOutbound = (capturedSysReq as { systemInstruction?: { role?: string; parts?: Array<{ text?: string }> } } | null)?.systemInstruction;
    expect(sysOutbound?.role).toBe(facts.systemInstruction.outboundRole);
    const sysParts = sysOutbound?.parts ?? [];
    expect(sysParts.length).toBe(facts.systemInstruction.outboundPartsLength);
    expect(sysParts[0]?.text === sysInstructionText).toBe(
      facts.systemInstruction.outboundTextMatchesInput,
    );

    const wordSchema = Schema.object({
      properties: {
        word: Schema.string(),
      },
    });
    await inspectModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'Give one English word for water.' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: wordSchema,
      },
    });
    const genConfig = (capturedSchemaReq as { generationConfig?: { responseMimeType?: string; responseSchema?: Record<string, unknown> } } | null)?.generationConfig;
    expect(genConfig?.responseMimeType).toBe(facts.structuredOutput.outboundResponseMimeType);
    expect(genConfig?.responseSchema).toEqual(facts.structuredOutput.outboundResponseSchema);

    const zeroSandbox = initializeSandbox();
    const zeroModel = getGenerativeModel(getAI(zeroSandbox), { model: PROBE_MODEL });

    const sysResult = await zeroModel.generateContent({
      systemInstruction: sysInstructionText,
      contents: [{ role: 'user', parts: [{ text: 'Say pong.' }] }],
    });
    expect(dataKeys(sysResult.response)).toEqual(facts.systemInstruction.wireTopLevelKeySet);
    expect(sysResult.response.candidates?.[0]?.finishReason).toBe(
      facts.systemInstruction.finishReason,
    );

    const schemaResult = await zeroModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'Give one English word for water.' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: wordSchema,
      },
    });
    const parsed = JSON.parse(schemaResult.response.text()) as Record<string, unknown>;
    expect(facts.structuredOutput.textParsesAsJson).toBe(true);
    expect(Object.keys(parsed).sort()).toEqual(facts.structuredOutput.parsedKeySet);
    expect(schemaResult.response.candidates?.[0]?.finishReason).toBe(
      facts.structuredOutput.finishReason,
    );

    const thinkingResult = await zeroModel.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'A basket has 9 apples. You take 2. How many remain?' }],
        },
      ],
      generationConfig: {
        thinkingConfig: { includeThoughts: true },
      },
    });
    const thinkingParts = thinkingResult.response.candidates?.[0]?.content?.parts ?? [];
    expect(thinkingParts.some((part) => part.thought === true)).toBe(
      facts.thinking.anyThoughtPart,
    );
    expect(
      thinkingParts.some(
        (part) => typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0,
      ),
    ).toBe(facts.thinking.anyThoughtSignature);
    expect(thinkingResult.response.thoughtSummary() === undefined).toBe(
      facts.thinking.helperThoughtSummaryIsUndefined,
    );
    expect(thinkingResult.response.candidates?.[0]?.finishReason).toBe(
      facts.thinking.finishReason,
    );
  });

  it('replays forced FunctionCallingMode.ANY serialization and response.functionCalls() helper', async () => {
    const facts = loadObservation<FunctionCallsHelperBehavior>(
      'ai-sdk-response-helpers-functioncalls.json',
    );
    expect(facts.httpStatus).toBe(200);
    expect(facts.wireCallCount).toBe(1);

    let capturedToolReq: Record<string, unknown> | null = null;
    const inspectSandbox = initializeSandbox();
    const inspectAi = getAI(inspectSandbox);
    script(inspectAi, [
      {
        match(req) {
          capturedToolReq = req as unknown as Record<string, unknown>;
          return true;
        },
        respond: { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
      },
    ]);
    const inspectModel = getGenerativeModel(inspectAi, { model: PROBE_MODEL });
    const toolRequest = {
      contents: [{ role: 'user', parts: [{ text: 'What is the weather in Paris?' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Look up weather for a city',
              parameters: Schema.object({
                properties: {
                  city: Schema.string(),
                },
              }),
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingMode.ANY,
        },
      },
    };
    await inspectModel.generateContent(toolRequest);

    const toolsList = (capturedToolReq as { tools?: Array<{ functionDeclarations?: Array<{ name?: string; parameters?: Record<string, unknown> }> }> } | null)?.tools ?? [];
    const firstDecl = toolsList[0]?.functionDeclarations?.[0];
    expect(firstDecl?.name).toBe(facts.outboundToolRequest.declarationName);
    expect(firstDecl?.parameters).toEqual(facts.outboundToolRequest.parametersJson);
    const callingMode = (capturedToolReq as { toolConfig?: { functionCallingConfig?: { mode?: string } } } | null)?.toolConfig?.functionCallingConfig?.mode;
    expect(callingMode).toBe(facts.outboundToolRequest.callingMode);

    const zeroSandbox = initializeSandbox();
    const zeroModel = getGenerativeModel(getAI(zeroSandbox), { model: PROBE_MODEL });
    const result = await zeroModel.generateContent(toolRequest);

    const parts = result.response.candidates?.[0]?.content?.parts ?? [];
    const fnPart = parts.find((part) => part.functionCall !== undefined);
    expect(fnPart !== undefined).toBe(facts.wireFunctionCall.present);
    expect(Object.keys(fnPart?.functionCall ?? {}).sort()).toEqual(
      facts.wireFunctionCall.functionCallKeySet,
    );
    expect(fnPart !== undefined && 'thoughtSignature' in fnPart).toBe(
      facts.wireFunctionCall.hasThoughtSignature,
    );
    expect(result.response.candidates?.[0]?.finishReason).toBe(facts.wireFunctionCall.finishReason);

    const calls = result.response.functionCalls();
    expect(Array.isArray(calls)).toBe(facts.helperFunctionCalls.isArray);
    const callList = calls ?? [];
    expect(callList.length).toBe(facts.helperFunctionCalls.count);
    const firstCall = callList[0];
    expect(firstCall?.name).toBe(facts.helperFunctionCalls.firstName);
    const args = firstCall?.args;
    const isPlainObject =
      args !== undefined && args !== null && typeof args === 'object' && !Array.isArray(args);
    expect(isPlainObject).toBe(facts.helperFunctionCalls.argsIsPlainObject);
    expect(typeof args?.city === 'string').toBe(facts.helperFunctionCalls.argsHasCityString);
    expect(result.response.inlineDataParts() === undefined).toBe(
      facts.helperFunctionCalls.inlineDataPartsIsUndefined,
    );
  });
});
