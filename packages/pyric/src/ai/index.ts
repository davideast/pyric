/**
 * `pyric/ai` — modular Web-SDK AI adapter for the Pyric sandbox.
 *
 * Mirrors `firebase/ai`'s v1 surface (docs/conformance/ai/surface-inventory.md:
 * exactly the 38 runtime value exports of the installed 2.12.0 that are
 * admitted to v1; the 17 denied runtime exports — Imagen, Live API, server
 * templates, hybrid/on-device — are intentionally NOT exported) with two
 * backends picked at init:
 *
 *   - **Sandbox target** — `getAI(sandbox)` answers in-process through the
 *     {@link AiBroker} answer-engine seam (`scripted` default: zero-config,
 *     zero-I/O, deterministic; or `openai`: any OpenAI-compatible upstream).
 *     Scripting lives on the `pyric/ai/scripting` subpath.
 *   - **Prod target** — `getAI(app)` passes through to the installed
 *     `firebase/ai`; models minted from a prod handle ARE the installed
 *     SDK's models.
 *
 * Dual-target dispatch follows the house pattern (`pyric/auth`):
 * {@link TARGET_SYMBOL} brands every {@link AI} handle; free functions read
 * it via `targetOf` and switch on `target.kind`.
 */

import type { Sandbox } from 'pyric/sandbox';
import type { FirebaseApp } from 'firebase/app';

import { AiBroker } from './broker/index.js';
import { Backend, BackendType, GoogleAIBackend, VertexAIBackend } from './backend.js';
import { AIError, AIErrorCode } from './errors.js';
import { GenerativeModel, type ModelParams, type RequestOptions } from './models.js';
import { prodGetAI, prodGetGenerativeModel } from './prod-backend.js';
import {
  TARGET_SYMBOL,
  isSandbox,
  targetOf,
  type AI,
  type AIOptions,
  type ProdTarget,
  type SandboxTarget,
} from './target.js';

// ─── Re-exports: entry points and classes ─────────────────────────────

export { AIError, AIErrorCode } from './errors.js';
export type { CustomErrorData } from './errors.js';
export { Backend, BackendType, GoogleAIBackend, VertexAIBackend } from './backend.js';
export { AIModel, ChatSession, ChatSessionBase, GenerativeModel } from './models.js';
export type { BaseParams, ModelParams, RequestOptions, StartChatParams } from './models.js';
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
export type { AI, AIOptions } from './target.js';
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

// ─── Re-exports: v1 type-only surface (upstream signatures verbatim) ──
//
// Pure data types re-exported from the installed `firebase/ai` typings so
// consumer code sees the exact upstream declarations. Denied families
// (Imagen, Live, templates, hybrid/on-device) are NOT re-exported.

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
} from 'firebase/ai';

// ─── getAI: one handle per target (sandbox+backend / upstream app) ────

const sandboxHandles = new WeakMap<Sandbox, Map<string, AI>>();

function backendKey(backend: Backend): string {
  return backend.backendType === BackendType.VERTEX_AI
    ? `vertexai/${(backend as VertexAIBackend).location}`
    : 'googleai';
}

/**
 * Construct an {@link AI} handle. Two overloads:
 *   - `getAI(sandbox, options?)` — sandbox-backed; answers in-process
 *     through the answer engine (`scripted` default, or
 *     `options.engine: { kind: 'openai', baseUrl }`).
 *   - `getAI(app, options?)` — prod-backed; delegates to the installed
 *     `firebase/ai.getAI(app)` and returns ITS instance (`ai.app === app`).
 *
 * Idempotent on both targets: repeat calls for the same target (and, on
 * sandboxes, the same backend) return a stable handle; the first call's
 * options win.
 *
 * @example
 * ```ts
 * // Sandbox.
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getAI, getGenerativeModel } from 'pyric/ai';
 * const sandbox = initializeSandbox();
 * const model = getGenerativeModel(getAI(sandbox), { model: 'gemini-flash-lite-latest' });
 *
 * // Prod.
 * import { initializeApp } from 'firebase/app';
 * import { getAI } from 'pyric/ai';
 * const ai = getAI(initializeApp(userProjectConfig));
 * ```
 */
export function getAI(sandbox: Sandbox, options?: AIOptions): AI;
export function getAI(app: FirebaseApp, options?: AIOptions): AI;
export function getAI(target: Sandbox | FirebaseApp, options?: AIOptions): AI {
  if (isSandbox(target)) {
    const backend = options?.backend ?? new GoogleAIBackend();
    const key = backendKey(backend);
    let handles = sandboxHandles.get(target);
    if (!handles) {
      handles = new Map();
      sandboxHandles.set(target, handles);
    }
    const existing = handles.get(key);
    if (existing) return existing;

    const broker = new AiBroker({ engine: options?.engine, sandbox: target });
    const handle: AI = { backend, ...(options !== undefined ? { options } : {}) };
    const sandboxTarget: SandboxTarget = { kind: 'sandbox', sandbox: target, broker };
    Object.defineProperty(handle, TARGET_SYMBOL, { value: sandboxTarget, enumerable: false });
    handles.set(key, handle);
    return handle;
  }

  // Prod: the installed SDK's instance IS the handle (pass-through), branded
  // so getGenerativeModel can dispatch. Upstream getAI is itself idempotent
  // per app+backend, so the brand lands exactly once.
  const upstream = prodGetAI(target, options);
  if (!(TARGET_SYMBOL in (upstream as object))) {
    const prodTarget: ProdTarget = { kind: 'prod', ai: upstream };
    Object.defineProperty(upstream, TARGET_SYMBOL, { value: prodTarget, enumerable: false });
  }
  return upstream as unknown as AI;
}

/**
 * Returns a {@link GenerativeModel} with methods for inference (upstream
 * signature). Prod handles return the installed SDK's model instance.
 */
export function getGenerativeModel(
  ai: AI,
  modelParams: ModelParams,
  requestOptions?: RequestOptions,
): GenerativeModel {
  const target = targetOf(ai);
  if (target.kind === 'prod') {
    return prodGetGenerativeModel(target.ai, modelParams, requestOptions) as unknown as GenerativeModel;
  }
  if (!modelParams?.model) {
    throw new AIError(
      AIErrorCode.NO_MODEL,
      `Must provide a model name. Example: getGenerativeModel({ model: 'my-model-name' })`,
    );
  }
  return new GenerativeModel(target, modelParams, requestOptions);
}
