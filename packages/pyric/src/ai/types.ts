/**
 * Firebase AI-shaped public types owned by the sandbox mirror.
 *
 * These interfaces deliberately describe values rather than importing the
 * production SDK's declarations. Package resolution decides whether an
 * application loads Firebase or Pyric; loading `pyric/ai` must not make the
 * production package a runtime or declaration dependency.
 */

import type {
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
  Modality,
  ResponseModality,
  Role,
  SchemaType,
} from './enums.js';
import type { SandboxApp } from '../sandbox/internal/app-handle.js';
import type { Sandbox } from '../sandbox/types/service.js';
import type { AiBroker } from './broker/broker.js';
import type { AnswerEngine, EngineConfig } from './broker/types.js';
import type { Backend } from './backend.js';
import type { TypedSchema } from './schema.js';

/** Initialization options; `engine` is the sandbox-only answer-engine seam. */
export interface AIOptions {
  backend?: Backend;
  useLimitedUseAppCheckTokens?: boolean;
  /** Sandbox targets only: engine config (`scripted` default) or a custom engine. */
  engine?: EngineConfig | AnswerEngine;
}

/** Sandbox AI handle. Direct sandbox handles have no `app`. */
export interface AI {
  app?: SandboxApp;
  backend: Backend;
  location: string;
  options?: AIOptions;
}

/** Per-handle sandbox dispatch state. */
export interface SandboxTarget {
  sandbox: Sandbox;
  broker: AiBroker;
}

export interface Date {
  year: number;
  month: number;
  day: number;
}

export interface Citation {
  startIndex?: number;
  endIndex?: number;
  uri?: string;
  license?: string;
  title?: string;
  publicationDate?: Date;
}

export interface CitationMetadata {
  citations: Citation[];
}

export interface CodeExecutionResult {
  outcome?: string;
  output?: string;
}

export interface ExecutableCode {
  language?: string;
  code?: string;
}

export interface GenerativeContentBlob {
  mimeType: string;
  data: string;
}

export interface FileData {
  mimeType: string;
  fileUri: string;
}

export interface FunctionCall {
  id?: string;
  name: string;
  args: object;
}

export interface FunctionResponse {
  id?: string;
  name: string;
  response: object;
  parts?: Part[];
}

export interface VideoMetadata {
  startOffset: string;
  endOffset: string;
}

export interface TextPart {
  text: string;
  inlineData?: never;
  functionCall?: never;
  functionResponse?: never;
  thought?: boolean;
  executableCode?: never;
  codeExecutionResult?: never;
}

export interface InlineDataPart {
  text?: never;
  inlineData: GenerativeContentBlob;
  functionCall?: never;
  functionResponse?: never;
  videoMetadata?: VideoMetadata;
  thought?: boolean;
  executableCode?: never;
  codeExecutionResult?: never;
}

export interface FunctionCallPart {
  text?: never;
  inlineData?: never;
  functionCall: FunctionCall;
  functionResponse?: never;
  thought?: boolean;
  executableCode?: never;
  codeExecutionResult?: never;
}

export interface FunctionResponsePart {
  text?: never;
  inlineData?: never;
  functionCall?: never;
  functionResponse: FunctionResponse;
  thought?: boolean;
  executableCode?: never;
  codeExecutionResult?: never;
}

export interface FileDataPart {
  text?: never;
  inlineData?: never;
  functionCall?: never;
  functionResponse?: never;
  fileData: FileData;
  thought?: boolean;
  executableCode?: never;
  codeExecutionResult?: never;
}

export interface ExecutableCodePart {
  text?: never;
  inlineData?: never;
  functionCall?: never;
  functionResponse?: never;
  fileData: never;
  thought?: never;
  executableCode?: ExecutableCode;
  codeExecutionResult?: never;
}

export interface CodeExecutionResultPart {
  text?: never;
  inlineData?: never;
  functionCall?: never;
  functionResponse?: never;
  fileData: never;
  thought?: never;
  executableCode?: never;
  codeExecutionResult?: CodeExecutionResult;
}

export type Part =
  | TextPart
  | InlineDataPart
  | FunctionCallPart
  | FunctionResponsePart
  | FileDataPart
  | ExecutableCodePart
  | CodeExecutionResultPart;

export interface Content {
  role: Role;
  parts: Part[];
}

export interface ModalityTokenCount {
  modality: Modality;
  tokenCount: number;
}

export interface CountTokensRequest {
  contents: Content[];
  systemInstruction?: string | Part | Content;
  tools?: Tool[];
  generationConfig?: GenerationConfig;
}

export interface CountTokensResponse {
  totalTokens: number;
  totalBillableCharacters?: number;
  promptTokensDetails?: ModalityTokenCount[];
}

export interface FunctionCallingConfig {
  mode?: FunctionCallingMode;
  allowedFunctionNames?: string[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: ObjectSchemaInstance | ObjectSchemaRequest;
  functionReference?: Function;
}

export interface FunctionDeclarationsTool {
  functionDeclarations?: FunctionDeclaration[];
}

export interface CodeExecutionTool {
  codeExecution: Record<string, never>;
}

export interface GoogleMaps {
  enableWidget?: boolean;
}

export interface GoogleMapsTool {
  googleMaps: GoogleMaps;
}

export interface GoogleSearch {}

export interface GoogleSearchTool {
  googleSearch: GoogleSearch;
}

export interface URLContext {}

export interface URLContextTool {
  urlContext: URLContext;
}

export type Tool =
  | FunctionDeclarationsTool
  | GoogleMapsTool
  | GoogleSearchTool
  | CodeExecutionTool
  | URLContextTool;

export interface LatLng {
  latitude?: number;
  longitude?: number;
}

export interface RetrievalConfig {
  latLng?: LatLng;
  languageCode?: string;
}

export interface ToolConfig {
  functionCallingConfig?: FunctionCallingConfig;
  retrievalConfig?: RetrievalConfig;
}

export interface ThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
}

export interface ImageConfig {
  aspectRatio?: ImageConfigAspectRatio;
  imageSize?: ImageConfigImageSize;
}

export interface SchemaShared<T> {
  anyOf?: T[];
  format?: string;
  description?: string;
  title?: string;
  items?: T;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, T>;
  propertyOrdering?: string[];
  enum?: string[];
  example?: unknown;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}

export interface SchemaInterface extends SchemaShared<SchemaInterface> {
  type?: SchemaType;
}

export interface SchemaRequest extends SchemaShared<SchemaRequest> {
  type?: SchemaType;
  required?: string[];
}

export interface ObjectSchemaRequest extends SchemaRequest {
  type: 'object';
  optionalProperties?: never;
}

interface SchemaInstance extends SchemaInterface {
  nullable: boolean;
}

interface ObjectSchemaInstance extends SchemaInstance {
  properties: Record<string, SchemaInstance>;
  optionalProperties: string[];
}

export interface GenerationConfig {
  candidateCount?: number;
  stopSequences?: string[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseMimeType?: string;
  responseSchema?: TypedSchema | SchemaRequest;
  responseJsonSchema?: Record<string, unknown>;
  responseModalities?: ResponseModality[];
  thinkingConfig?: ThinkingConfig;
  imageConfig?: ImageConfig;
}

export interface SafetyRating {
  category: HarmCategory;
  probability: HarmProbability;
  severity: HarmSeverity;
  probabilityScore: number;
  severityScore: number;
  blocked: boolean;
}

export interface SafetySetting {
  category: HarmCategory;
  threshold: HarmBlockThreshold;
  method?: HarmBlockMethod;
}

export interface PromptFeedback {
  blockReason?: BlockReason;
  safetyRatings: SafetyRating[];
  blockReasonMessage?: string;
}

export interface SearchEntrypoint {
  renderedContent?: string;
}

export interface Segment {
  partIndex: number;
  startIndex: number;
  endIndex: number;
  text: string;
}

export interface WebGroundingChunk {
  uri?: string;
  title?: string;
  domain?: string;
}

export interface GoogleMapsGroundingChunk {
  uri?: string;
  title?: string;
  text?: string;
  placeId?: string;
}

export interface GroundingChunk {
  web?: WebGroundingChunk;
  maps?: GoogleMapsGroundingChunk;
}

export interface GroundingSupport {
  segment?: Segment;
  groundingChunkIndices?: number[];
}

export interface GroundingMetadata {
  searchEntryPoint?: SearchEntrypoint;
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
  webSearchQueries?: string[];
  retrievalQueries?: string[];
  googleMapsWidgetContextToken?: string;
}

export interface URLMetadata {
  retrievedUrl?: string;
  urlRetrievalStatus?: string;
}

export interface URLContextMetadata {
  urlMetadata: URLMetadata[];
}

export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount?: number;
  totalTokenCount: number;
  toolUsePromptTokenCount?: number;
  promptTokensDetails?: ModalityTokenCount[];
  candidatesTokensDetails?: ModalityTokenCount[];
  toolUsePromptTokensDetails?: ModalityTokenCount[];
  cachedContentTokenCount?: number;
  cacheTokensDetails?: ModalityTokenCount[];
}

export interface GenerateContentCandidate {
  index: number;
  content: Content;
  finishReason?: FinishReason;
  finishMessage?: string;
  safetyRatings?: SafetyRating[];
  citationMetadata?: CitationMetadata;
  groundingMetadata?: GroundingMetadata;
  urlContextMetadata?: URLContextMetadata;
}

export interface GenerateContentRequest {
  contents: Content[];
  safetySettings?: SafetySetting[];
  generationConfig?: GenerationConfig;
  tools?: Tool[];
  toolConfig?: ToolConfig;
  systemInstruction?: string | Part | Content;
}

export interface GenerateContentResponse {
  candidates?: GenerateContentCandidate[];
  promptFeedback?: PromptFeedback;
  usageMetadata?: UsageMetadata;
}

export interface EnhancedGenerateContentResponse extends GenerateContentResponse {
  text(): string;
  inlineDataParts(): InlineDataPart[] | undefined;
  functionCalls(): FunctionCall[] | undefined;
  thoughtSummary(): string | undefined;
}

export interface ErrorDetails {
  '@type'?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
