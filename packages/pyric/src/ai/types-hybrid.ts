/**
 * Public TypeScript contracts for Firebase AI Hybrid, On-Device Prompt API,
 * and `ChromeAdapter` capabilities owned by `pyric/ai`.
 */
import type { InferenceMode } from './generation-enums.js';
import type { ModelParams } from './models.js';
import type { GenerateContentRequest } from './types.js';

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
