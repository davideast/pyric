/**
 * Public TypeScript contracts for Firebase AI Hybrid, On-Device Prompt API,
 * `ChromeAdapter`, and `AgentPlatformBackend` capabilities owned by `pyric/ai`.
 *
 * `AgentPlatformBackend` is exported only in the TypeScript type namespace so
 * the deferred runtime disposition in `packages/conformance/surfaces/ai.json`
 * remains accurate.
 */
import type { Backend } from './backend.js';
import type { InferenceMode } from './generation-enums.js';
import type { ModelParams } from './models.js';
import type { GenerateContentRequest } from './types.js';

export interface AgentPlatformBackend extends Backend {
  readonly location: string;
}

export interface ChromeAdapter {
  isAvailable(request: GenerateContentRequest): Promise<boolean>;
  generateContent(request: GenerateContentRequest): Promise<Response>;
  generateContentStream(request: GenerateContentRequest): Promise<Response>;
}

export type LanguageModelMessageRole = 'system' | 'user' | 'assistant';

export type LanguageModelMessageType = 'text' | 'image' | 'audio';

export type LanguageModelMessageContentValue =
  | ImageBitmapSource
  | AudioBuffer
  | BufferSource
  | string;

export interface LanguageModelMessageContent {
  type: LanguageModelMessageType;
  value: LanguageModelMessageContentValue;
}

export interface LanguageModelMessage {
  role: LanguageModelMessageRole;
  content: LanguageModelMessageContent[];
}

export interface LanguageModelExpected {
  type: LanguageModelMessageType;
  languages?: string[];
}

export interface LanguageModelDownloadMonitor {
  addEventListener: (
    eventType: 'downloadprogress',
    eventListener: (e: { loaded: number }) => void,
  ) => void;
  removeEventListener: (
    eventType: 'downloadprogress',
    eventListener: (e: { loaded: number }) => void,
  ) => void;
}

export interface LanguageModelCreateCoreOptions {
  topK?: number;
  temperature?: number;
  expectedInputs?: LanguageModelExpected[];
  expectedOutputs?: LanguageModelExpected[];
  monitor?: (monitor: LanguageModelDownloadMonitor) => void;
}

export interface LanguageModelCreateOptions extends LanguageModelCreateCoreOptions {
  signal?: AbortSignal;
  initialPrompts?: LanguageModelMessage[];
}

export interface LanguageModelPromptOptions {
  responseConstraint?: object;
}

export interface OnDeviceParams {
  createOptions?: LanguageModelCreateOptions;
  promptOptions?: LanguageModelPromptOptions;
}

export interface HybridParams {
  mode: InferenceMode;
  onDeviceParams?: OnDeviceParams;
  inCloudParams?: ModelParams;
}
