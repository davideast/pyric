/**
 * AI broker barrel — the in-process Gemini-wire model for the sandbox's ai
 * surface (CDD map #92; rulings in packages/conformance/docs/ai/cdd-deltas.md).
 * NOT wired into package exports yet: the `pyric/ai` mirror layer (next
 * stage) owns the public surface.
 */

export { AiBroker, loadObservationEnvelope, type AiBrokerOptions } from './broker.js';
export { ScriptedEngine, lastUserText, promptTextOf } from './scripted-engine.js';
export { GeminiEngine, type GeminiEngineOptions } from './gemini-engine.js';
export {
  OpenAiEngine,
  ToolCallBuffer,
  SseParser,
  DONE_SENTINEL,
  geminiToOpenAIRequest,
  normalizeSchema,
  mapFinishReason,
  openAIToGeminiResponse,
  openAIChunkToParts,
  type OpenAiEngineOptions,
  type OpenAIRequest,
  type OpenAIResponse,
  type OpenAIStreamChunk,
  type OpenAIMessage,
  type OpenAIToolCall,
} from './openai-engine.js';
export {
  AiBrokerError,
  Synthesizer,
  errorEnvelope,
  unknownModel,
  badRole,
  emptyContents,
  missingThoughtSignature,
  resolveModelVersion,
  estimateTokens,
  mintThoughtSignature,
  mintFunctionCallId,
  redactUrl,
  type SynthesizeOptions,
} from './synthesizer.js';
export type {
  AnswerEngine,
  CountTokensRequest,
  CountTokensResponse,
  EngineConfig,
  GenerateContentRequest,
  RawEnvelope,
  ScriptEntry,
  ScriptMatcher,
  ScriptRespond,
  ScriptShorthand,
  WireCandidate,
  WireChunk,
  WireContent,
  WireErrorEnvelope,
  WirePart,
  WireResponse,
  WireUsageMetadata,
} from './types.js';
