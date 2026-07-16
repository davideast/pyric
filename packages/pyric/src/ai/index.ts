/**
 * `pyric/ai` — modular Web-SDK AI adapter for the Pyric sandbox.
 *
 * Mirrors the admitted `firebase/ai` surface as a sandbox-only adapter.
 * Availability and reviewed dispositions are owned only by
 * `packages/conformance/surfaces/ai.json`; this barrel deliberately carries
 * no copied counts or deny-list. Production selection happens before it loads:
 * unmodified `firebase/ai` imports either remain Firebase or are swapped to
 * this package by the Vite/import-map or Node register boundary.
 *
 *   - **Sandbox target** — `getAI(sandbox)` answers in-process through the
 *     {@link AiBroker} answer-engine seam (`scripted` default: zero-config,
 *     zero-I/O, deterministic; or `openai`: any OpenAI-compatible upstream).
 *     Scripting lives on the `pyric/ai/scripting` subpath.
 * A {@link TARGET_SYMBOL} brand binds every {@link AI} handle to its sandbox
 * broker. There is no production target or runtime Firebase dispatch here.
 */

// ─── Re-exports: entry points and classes ─────────────────────────────

export { AIError, AIErrorCode } from './errors.js';
export type { CustomErrorData } from './errors.js';
export { Backend, BackendType, GoogleAIBackend, VertexAIBackend } from './backend.js';
export { AIModel, ChatSession, ChatSessionBase, GenerativeModel, getGenerativeModel } from './models.js';
export type { BaseParams, ModelParams, RequestOptions, StartChatParams } from './models.js';
export { getAI } from './instances.js';
export {
  AnyOfSchema,
  ArraySchema,
  BooleanSchema,
  IntegerSchema,
  NumberSchema,
  ObjectSchema,
  Schema,
  StringSchema,
} from './schema.js';
export type { SchemaParams, TypedSchema } from './schema.js';
export { TARGET_SYMBOL } from './target.js';
export type {
  GenerateContentResult,
  GenerateContentStreamResult,
  SingleRequestOptions,
} from './sandbox-plane.js';

// ─── Re-exports: enums (const/type pairs, values verbatim from 2.12.0) ─

export {
  BlockReason,
  FinishReason,
  FunctionCallingMode,
  HarmBlockMethod,
  HarmBlockThreshold,
  HarmCategory,
  HarmProbability,
  HarmSeverity,
  ImageConfigAspectRatio,
  ImageConfigImageSize,
  Language,
  Modality,
  Outcome,
  POSSIBLE_ROLES,
  ResponseModality,
  SchemaType,
  ThinkingLevel,
  URLRetrievalStatus,
} from './enums.js';
export type { Role } from './enums.js';

// ─── Re-exports: mirror-owned v1 type-only surface ────────────────────
//
// These structural declarations preserve the canonical Firebase-shaped
// surface without making `firebase/ai` a declaration dependency. The surface
// contract, not this barrel, owns availability and disposition policy.

export type {
  Citation,
  CitationMetadata,
  CodeExecutionResult,
  CodeExecutionResultPart,
  CodeExecutionTool,
  Content,
  CountTokensRequest,
  CountTokensResponse,
  Date,
  EnhancedGenerateContentResponse,
  ErrorDetails,
  ExecutableCode,
  ExecutableCodePart,
  FileData,
  FileDataPart,
  FunctionCall,
  FunctionCallingConfig,
  FunctionCallPart,
  FunctionDeclaration,
  FunctionDeclarationsTool,
  FunctionResponse,
  FunctionResponsePart,
  GenerateContentCandidate,
  GenerateContentRequest,
  GenerateContentResponse,
  GenerationConfig,
  GenerativeContentBlob,
  GoogleMaps,
  GoogleMapsGroundingChunk,
  GoogleMapsTool,
  GoogleSearch,
  GoogleSearchTool,
  GroundingChunk,
  GroundingMetadata,
  GroundingSupport,
  ImageConfig,
  InlineDataPart,
  LatLng,
  ModalityTokenCount,
  ObjectSchemaRequest,
  Part,
  PromptFeedback,
  RetrievalConfig,
  SafetyRating,
  SafetySetting,
  SchemaInterface,
  SchemaRequest,
  SchemaShared,
  SearchEntrypoint,
  Segment,
  TextPart,
  ThinkingConfig,
  Tool,
  ToolConfig,
  URLContext,
  URLContextMetadata,
  URLContextTool,
  URLMetadata,
  UsageMetadata,
  VideoMetadata,
  WebGroundingChunk,
  AI,
  AIOptions,
} from './types.js';
