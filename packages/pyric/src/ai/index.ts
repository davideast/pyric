/**
 * `pyric/ai` — modular Web-SDK AI adapter for the Pyric sandbox.
 *
 * Mirrors `firebase/ai`'s v1 surface (packages/conformance/docs/ai/surface-inventory.md:
 * exactly the 38 runtime value exports of the installed 2.12.0 that are
 * admitted to v1; the 17 denied runtime exports — Imagen, Live API, server
 * templates, hybrid/on-device — are intentionally NOT exported) as a
 * sandbox-only mirror. Production selection happens before this module loads:
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

import type { Sandbox } from 'pyric/sandbox';
import { APP_TARGET, getApp, type PyricApp } from 'pyric/app';

import { AiBroker } from './broker/index.js';
import { Backend, BackendType, GoogleAIBackend, VertexAIBackend } from './backend.js';
import { AIError, AIErrorCode } from './errors.js';
import { GenerativeModel, type ModelParams, type RequestOptions } from './models.js';
import {
  TARGET_SYMBOL,
  isSandbox,
  targetOf,
  type AI,
  type AIOptions,
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

// ─── Re-exports: mirror-owned v1 type-only surface ────────────────────
//
// These structural declarations preserve the canonical Firebase-shaped
// surface without making `firebase/ai` a declaration dependency. Denied
// families (Imagen, Live, templates, hybrid/on-device) are not exported.

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
} from './public-types.js';

// ─── getAI: one handle per sandbox/app target and backend ─────────────

const sandboxHandles = new WeakMap<Sandbox, Map<string, AI>>();
const appHandles = new WeakMap<PyricApp, Map<string, AI>>();

function backendKey(backend: Backend): string {
  return backend.backendType === BackendType.VERTEX_AI
    ? `vertexai/${(backend as VertexAIBackend).location}`
    : 'googleai';
}

/**
 * Construct a sandbox-backed {@link AI} handle:
 *   - `getAI()` — uses the default sandbox app initialized through the
 *     package-resolution adapter.
 *   - `getAI(sandbox, options?)` — sandbox-backed; answers in-process
 *     through the answer engine (`scripted` default, or
 *     `options.engine: { kind: 'openai', baseUrl }`).
 *   - `getAI(app, options?)` — unwraps the sandbox app selected by package
 *     resolution and preserves `ai.app === app`.
 *
 * Repeat calls for the same target and backend return a stable handle; the
 * first call's options win.
 *
 * @example
 * ```ts
 * // Sandbox.
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getAI, getGenerativeModel } from 'pyric/ai';
 * const sandbox = initializeSandbox();
 * const model = getGenerativeModel(getAI(sandbox), { model: 'gemini-flash-lite-latest' });
 *
 * // Canonical imports are swapped to this mirror by pyric dev/register.
 * import { initializeApp } from 'firebase/app';
 * import { getAI } from 'firebase/ai';
 * const ai = getAI(initializeApp(userProjectConfig));
 * ```
 */
export function getAI(sandbox: Sandbox, options?: AIOptions): AI;
export function getAI(app?: PyricApp, options?: AIOptions): AI;
export function getAI(target?: Sandbox | PyricApp, options?: AIOptions): AI {
  if (target === undefined) {
    return getAI(getApp(), options);
  }
  if (isPyricApp(target)) {
    return sandboxAI(target.sandbox, options, target);
  }
  if (isSandbox(target)) {
    return sandboxAI(target, options);
  }
  throw new TypeError(
    'pyric/ai is a sandbox-only mirror. Package resolution must leave firebase/ai unchanged for production; activate pyric dev or @pyric/cli/register before importing to select the sandbox.',
  );
}

function isPyricApp(target: Sandbox | PyricApp): target is PyricApp {
  return target !== null && typeof target === 'object' && APP_TARGET in target;
}

function sandboxAI(sandbox: Sandbox, options?: AIOptions, app?: PyricApp): AI {
  const backend = options?.backend ?? new GoogleAIBackend();
  const key = backendKey(backend);
  let handles: Map<string, AI> | undefined;
  if (app === undefined) {
    handles = sandboxHandles.get(sandbox);
    if (!handles) {
      handles = new Map();
      sandboxHandles.set(sandbox, handles);
    }
  } else {
    handles = appHandles.get(app);
    if (!handles) {
      handles = new Map();
      appHandles.set(app, handles);
    }
  }
  const existing = handles.get(key);
  if (existing) return existing;

  const broker = new AiBroker({ engine: options?.engine, sandbox });
  const handle: AI = {
    ...(app !== undefined ? { app } : {}),
    backend,
    ...(options !== undefined ? { options } : {}),
  };
  const sandboxTarget: SandboxTarget = { kind: 'sandbox', sandbox, broker };
  Object.defineProperty(handle, TARGET_SYMBOL, { value: sandboxTarget, enumerable: false });
  handles.set(key, handle);
  return handle;
}

/**
 * Returns a sandbox-backed {@link GenerativeModel} with the upstream method
 * signatures.
 */
export function getGenerativeModel(
  ai: AI,
  modelParams: ModelParams,
  requestOptions?: RequestOptions,
): GenerativeModel {
  const target = targetOf(ai);
  if (!modelParams?.model) {
    throw new AIError(
      AIErrorCode.NO_MODEL,
      `Must provide a model name. Example: getGenerativeModel({ model: 'my-model-name' })`,
    );
  }
  return new GenerativeModel(target, modelParams, requestOptions);
}
