// Browser and Node-host replay checks for live firebase/ai generateContent,
// Schema responseSchema, thinkingConfig, and EnhancedGenerateContentResponse helpers.
import { FunctionCallingMode, Schema } from "firebase/ai";

function nonFunctionKeysSorted(value) {
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.keys(value)
    .filter((key) => typeof value[key] !== "function")
    .sort();
}

export async function checkGenerateAndHelpers(model) {
  const first = await model.generateContent("Reply with one word: pong");
  const second = await model.generateContent("Reply with one word: pong");
  const response = first.response;
  const candidate = response.candidates[0];
  const usage = response.usageMetadata;

  const sys = await model.generateContent({
    systemInstruction: "Answer in lowercase.",
    contents: [{ role: "user", parts: [{ text: "Say pong." }] }],
  });

  const wordSchema = Schema.object({
    properties: {
      word: Schema.string(),
    },
  });
  const structured = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: "Give one English word for water." }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: wordSchema,
    },
  });
  const parsedWord = JSON.parse(structured.response.text());

  const thinking = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: "A basket has 9 apples. You take 2. How many remain?" }],
      },
    ],
    generationConfig: {
      thinkingConfig: { includeThoughts: true },
    },
  });
  const thinkingParts = thinking.response.candidates[0].content.parts;

  const fnTurn = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: "What is the weather in Paris?" }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Look up weather for a city",
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
  });
  const fnParts = fnTurn.response.candidates[0].content.parts;
  const wireFnPart = fnParts.find((part) => part.functionCall !== undefined);
  const calls = fnTurn.response.functionCalls();
  const firstCall = calls[0];

  return {
    topLevelKeySet: nonFunctionKeysSorted(response),
    candidateKeySet: Object.keys(candidate).sort(),
    candidateIndex: candidate.index,
    contentRole: candidate.content.role,
    contentKeySet: Object.keys(candidate.content).sort(),
    finishReason: candidate.finishReason,
    usageKeySet: Object.keys(usage).sort(),
    usageServiceTierPresent: "serviceTier" in usage,
    modelVersionNonEmpty:
      typeof response.modelVersion === "string" && response.modelVersion.length > 0,
    responseIdNonEmpty:
      typeof response.responseId === "string" && response.responseId.length > 0,
    modelVersionStableAcrossCalls: second.response.modelVersion === response.modelVersion,
    responseIdDistinctAcrossCalls: second.response.responseId !== response.responseId,
    helperTextNonEmpty: typeof response.text() === "string" && response.text().length > 0,
    helperInlineDataUndefined: response.inlineDataParts() === undefined,
    helperFunctionCallsUndefined: response.functionCalls() === undefined,
    sysTopLevelKeySet: nonFunctionKeysSorted(sys.response),
    sysFinishReason: sys.response.candidates[0].finishReason,
    structuredParsedKeys: Object.keys(parsedWord).sort(),
    structuredFinishReason: structured.response.candidates[0].finishReason,
    thinkingAnyThoughtPart: thinkingParts.some((part) => part.thought === true),
    thinkingAnyThoughtSignature: thinkingParts.some(
      (part) => typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0,
    ),
    thinkingSummaryUndefined: thinking.response.thoughtSummary() === undefined,
    wireFunctionCallKeys: Object.keys(wireFnPart.functionCall).sort(),
    wireFunctionCallSigned: "thoughtSignature" in wireFnPart,
    helperCallCount: calls.length,
    helperFirstCallName: firstCall.name,
    helperFirstCallArgsHasCity:
      firstCall.args !== null &&
      typeof firstCall.args === "object" &&
      !Array.isArray(firstCall.args) &&
      typeof firstCall.args.city === "string",
  };
}
