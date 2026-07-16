/**
 * `pyric/ai` const/type enum pairs — value sets copied VERBATIM from the
 * installed `@firebase/ai@2.12.0` runtime bundle (the census universe; see
 * packages/conformance/surfaces/ai.json). Each name is exported both as a
 * const object and a type, matching the upstream `const X = {...} as const;
 * type X = (typeof X)[keyof typeof X]` pattern.
 */

/** Possible roles (upstream `POSSIBLE_ROLES`). */
export const POSSIBLE_ROLES = ['user', 'model', 'function', 'system'] as const;

/** The producer of the content. */
export type Role = (typeof POSSIBLE_ROLES)[number];

/** Harm categories that would cause prompts or candidates to be blocked. */
export const HarmCategory = {
  HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
  HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
  HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
} as const;
export type HarmCategory = (typeof HarmCategory)[keyof typeof HarmCategory];

/** Threshold above which a prompt or candidate will be blocked. */
export const HarmBlockThreshold = {
  BLOCK_LOW_AND_ABOVE: 'BLOCK_LOW_AND_ABOVE',
  BLOCK_MEDIUM_AND_ABOVE: 'BLOCK_MEDIUM_AND_ABOVE',
  BLOCK_ONLY_HIGH: 'BLOCK_ONLY_HIGH',
  BLOCK_NONE: 'BLOCK_NONE',
  OFF: 'OFF',
} as const;
export type HarmBlockThreshold = (typeof HarmBlockThreshold)[keyof typeof HarmBlockThreshold];

/** Probability-vs-severity blocking method (Vertex AI only). */
export const HarmBlockMethod = {
  SEVERITY: 'SEVERITY',
  PROBABILITY: 'PROBABILITY',
} as const;
export type HarmBlockMethod = (typeof HarmBlockMethod)[keyof typeof HarmBlockMethod];

/** Probability that a prompt or candidate matches a harm category. */
export const HarmProbability = {
  NEGLIGIBLE: 'NEGLIGIBLE',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
} as const;
export type HarmProbability = (typeof HarmProbability)[keyof typeof HarmProbability];

/** Harm severity levels (`UNSUPPORTED` is the GoogleAI fallback). */
export const HarmSeverity = {
  HARM_SEVERITY_NEGLIGIBLE: 'HARM_SEVERITY_NEGLIGIBLE',
  HARM_SEVERITY_LOW: 'HARM_SEVERITY_LOW',
  HARM_SEVERITY_MEDIUM: 'HARM_SEVERITY_MEDIUM',
  HARM_SEVERITY_HIGH: 'HARM_SEVERITY_HIGH',
  HARM_SEVERITY_UNSUPPORTED: 'HARM_SEVERITY_UNSUPPORTED',
} as const;
export type HarmSeverity = (typeof HarmSeverity)[keyof typeof HarmSeverity];

/** Reason that a prompt was blocked. */
export const BlockReason = {
  SAFETY: 'SAFETY',
  OTHER: 'OTHER',
  BLOCKLIST: 'BLOCKLIST',
  PROHIBITED_CONTENT: 'PROHIBITED_CONTENT',
} as const;
export type BlockReason = (typeof BlockReason)[keyof typeof BlockReason];

/** Reason that a candidate run stopped generating tokens (19 values in 2.12.0). */
export const FinishReason = {
  STOP: 'STOP',
  MAX_TOKENS: 'MAX_TOKENS',
  SAFETY: 'SAFETY',
  RECITATION: 'RECITATION',
  OTHER: 'OTHER',
  BLOCKLIST: 'BLOCKLIST',
  PROHIBITED_CONTENT: 'PROHIBITED_CONTENT',
  SPII: 'SPII',
  MALFORMED_FUNCTION_CALL: 'MALFORMED_FUNCTION_CALL',
  IMAGE_SAFETY: 'IMAGE_SAFETY',
  IMAGE_PROHIBITED_CONTENT: 'IMAGE_PROHIBITED_CONTENT',
  IMAGE_OTHER: 'IMAGE_OTHER',
  NO_IMAGE: 'NO_IMAGE',
  IMAGE_RECITATION: 'IMAGE_RECITATION',
  LANGUAGE: 'LANGUAGE',
  UNEXPECTED_TOOL_CALL: 'UNEXPECTED_TOOL_CALL',
  TOO_MANY_TOOL_CALLS: 'TOO_MANY_TOOL_CALLS',
  MISSING_THOUGHT_SIGNATURE: 'MISSING_THOUGHT_SIGNATURE',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
} as const;
export type FinishReason = (typeof FinishReason)[keyof typeof FinishReason];

/** How the model may call functions: default, forced call, or no calls. */
export const FunctionCallingMode = {
  AUTO: 'AUTO',
  ANY: 'ANY',
  NONE: 'NONE',
} as const;
export type FunctionCallingMode = (typeof FunctionCallingMode)[keyof typeof FunctionCallingMode];

/** Content part modality. */
export const Modality = {
  MODALITY_UNSPECIFIED: 'MODALITY_UNSPECIFIED',
  TEXT: 'TEXT',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  DOCUMENT: 'DOCUMENT',
} as const;
export type Modality = (typeof Modality)[keyof typeof Modality];

/** Generation modalities in responses. */
export const ResponseModality = {
  TEXT: 'TEXT',
  IMAGE: 'IMAGE',
  AUDIO: 'AUDIO',
} as const;
export type ResponseModality = (typeof ResponseModality)[keyof typeof ResponseModality];

/** OpenAPI data types for `Schema`. */
export const SchemaType = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
} as const;
export type SchemaType = (typeof SchemaType)[keyof typeof SchemaType];

/** Preset controlling the thinking process of compatible models. */
export const ThinkingLevel = {
  MINIMAL: 'MINIMAL',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
} as const;
export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];

/** Programming language of code the model executed. */
export const Language = {
  UNSPECIFIED: 'LANGUAGE_UNSPECIFIED',
  PYTHON: 'PYTHON',
} as const;
export type Language = (typeof Language)[keyof typeof Language];

/** Result of code the model ran. */
export const Outcome = {
  UNSPECIFIED: 'OUTCOME_UNSPECIFIED',
  OK: 'OUTCOME_OK',
  FAILED: 'OUTCOME_FAILED',
  DEADLINE_EXCEEDED: 'OUTCOME_DEADLINE_EXCEEDED',
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

/** Status of a URL retrieval. */
export const URLRetrievalStatus = {
  URL_RETRIEVAL_STATUS_UNSPECIFIED: 'URL_RETRIEVAL_STATUS_UNSPECIFIED',
  URL_RETRIEVAL_STATUS_SUCCESS: 'URL_RETRIEVAL_STATUS_SUCCESS',
  URL_RETRIEVAL_STATUS_ERROR: 'URL_RETRIEVAL_STATUS_ERROR',
  URL_RETRIEVAL_STATUS_PAYWALL: 'URL_RETRIEVAL_STATUS_PAYWALL',
  URL_RETRIEVAL_STATUS_UNSAFE: 'URL_RETRIEVAL_STATUS_UNSAFE',
} as const;
export type URLRetrievalStatus = (typeof URLRetrievalStatus)[keyof typeof URLRetrievalStatus];

/** Aspect ratios for Gemini image generation (`ImageConfig.aspectRatio`). */
export const ImageConfigAspectRatio = {
  SQUARE_1x1: '1:1',
  PORTRAIT_9x16: '9:16',
  LANDSCAPE_16x9: '16:9',
  PORTRAIT_3x4: '3:4',
  LANDSCAPE_4x3: '4:3',
  PORTRAIT_2x3: '2:3',
  LANDSCAPE_3x2: '3:2',
  PORTRAIT_4x5: '4:5',
  LANDSCAPE_5x4: '5:4',
  PORTRAIT_1x4: '1:4',
  LANDSCAPE_4x1: '4:1',
  PORTRAIT_1x8: '1:8',
  LANDSCAPE_8x1: '8:1',
  ULTRAWIDE_21x9: '21:9',
} as const;
export type ImageConfigAspectRatio =
  (typeof ImageConfigAspectRatio)[keyof typeof ImageConfigAspectRatio];

/** Sizes for Gemini generated images (`ImageConfig.imageSize`). */
export const ImageConfigImageSize = {
  SIZE_512: '512',
  SIZE_1K: '1K',
  SIZE_2K: '2K',
  SIZE_4K: '4K',
} as const;
export type ImageConfigImageSize = (typeof ImageConfigImageSize)[keyof typeof ImageConfigImageSize];
