/**
 * Model classes for `pyric/ai` sandbox targets: {@link AIModel},
 * {@link GenerativeModel}, {@link ChatSessionBase}, {@link ChatSession}.
 * Production never reaches these — unswapped `firebase/ai` imports load the
 * installed SDK before this sandbox-only package can enter the graph.
 *
 * Behavior tracks the installed `@firebase/ai@2.12.0` with two pinned
 * deltas (packages/conformance/docs/ai/cdd-deltas.md):
 *
 *   - `sendMessageStream` implements the 2.13.0 FIXED single-user-turn
 *     semantics, not the installed duplicate-turn bug (ruling #99.3).
 *   - Blocked prompts leave NO trace in history — `getHistory()`'s
 *     documented contract ("Blocked prompts are not added to history"),
 *     which the installed implementation violates by concatenating the user
 *     turn unconditionally.
 *
 * `getHistory()` returns a defensive clone: mutating the returned array
 * never corrupts the session (messaging-precedent hardening; the installed
 * SDK hands out its live array).
 */

import { AIError, AIErrorCode } from './errors.js';
import {
  formatGenerateContentInput,
  formatNewContent,
  formatSystemInstruction,
  validateChatHistory,
  type ContentShape,
  type GenerateContentRequestShape,
  type RequestInput,
} from './request-helpers.js';
import {
  planeCountTokens,
  planeGenerateContent,
  planeGenerateContentStream,
  type GenerateContentResult,
  type GenerateContentStreamResult,
  type SingleRequestOptions,
} from './sandbox-plane.js';
import type { SandboxTarget } from './target.js';
import type { CountTokensResponse } from './broker/index.js';

export interface RequestOptions {
  timeout?: number;
  baseUrl?: string;
  maxSequentialFunctionCalls?: number;
}

export interface BaseParams {
  safetySettings?: unknown[];
  generationConfig?: Record<string, unknown>;
}

export interface ModelParams extends BaseParams {
  model: string;
  tools?: unknown[];
  toolConfig?: unknown;
  systemInstruction?: string | ContentShape | { text?: string };
}

export interface StartChatParams extends BaseParams {
  history?: ContentShape[];
  tools?: unknown[];
  toolConfig?: unknown;
  systemInstruction?: string | ContentShape | { text?: string };
}

/** Base class for AI model APIs; holds the normalized model resource name. */
export abstract class AIModel {
  /** Fully qualified model resource name (`models/<name>` on GoogleAI). */
  readonly model: string;

  protected constructor(modelName: string) {
    this.model = AIModel.normalizeModelName(modelName);
  }

  /**
   * GoogleAI normalization WITHOUT the installed 2.12.0 double-prefix wart:
   * `models/x` stays `models/x`, a short name gains the prefix (registry row
   * ai#model-name-prefixed).
   */
  static normalizeModelName(modelName: string): string {
    const bare = modelName.startsWith('models/')
      ? modelName.slice('models/'.length)
      : modelName;
    return `models/${bare}`;
  }
}

/** Client-side GenerationConfig pitfall check (upstream `validateGenerationConfig`). */
function validateGenerationConfig(generationConfig: Record<string, unknown>): void {
  const thinkingConfig = generationConfig.thinkingConfig as
    | { thinkingBudget?: unknown; thinkingLevel?: unknown }
    | undefined;
  if (thinkingConfig?.thinkingBudget != null && thinkingConfig?.thinkingLevel) {
    throw new AIError(
      AIErrorCode.UNSUPPORTED,
      'Cannot set both thinkingBudget and thinkingLevel in a config.',
    );
  }
}

/** Class for generative model APIs on a sandbox target. */
export class GenerativeModel extends AIModel {
  readonly generationConfig: Record<string, unknown>;
  readonly safetySettings: unknown[];
  readonly tools?: unknown[];
  readonly toolConfig?: unknown;
  readonly systemInstruction?: ContentShape;
  readonly requestOptions: RequestOptions;

  private readonly target: SandboxTarget;

  constructor(target: SandboxTarget, modelParams: ModelParams, requestOptions?: RequestOptions) {
    super(modelParams.model);
    this.target = target;
    this.generationConfig = modelParams.generationConfig ?? {};
    validateGenerationConfig(this.generationConfig);
    this.safetySettings = modelParams.safetySettings ?? [];
    this.tools = modelParams.tools;
    this.toolConfig = modelParams.toolConfig;
    this.systemInstruction = formatSystemInstruction(
      modelParams.systemInstruction as string | ContentShape | undefined,
    );
    this.requestOptions = requestOptions ?? {};
  }

  /** Model-level defaults merged under the per-call request (upstream order). */
  private mergedRequest(request: RequestInput | GenerateContentRequestShape): Record<string, unknown> {
    const formattedParams = formatGenerateContentInput(request);
    return {
      generationConfig: this.generationConfig,
      safetySettings: this.safetySettings,
      tools: this.tools,
      toolConfig: this.toolConfig,
      systemInstruction: this.systemInstruction,
      ...formattedParams,
    };
  }

  private mergedOptions(singleRequestOptions?: SingleRequestOptions): SingleRequestOptions {
    return { ...this.requestOptions, ...singleRequestOptions };
  }

  async generateContent(
    request: RequestInput | GenerateContentRequestShape,
    singleRequestOptions?: SingleRequestOptions,
  ): Promise<GenerateContentResult> {
    return planeGenerateContent(
      this.target,
      this.model,
      this.mergedRequest(request),
      this.mergedOptions(singleRequestOptions),
    );
  }

  async generateContentStream(
    request: RequestInput | GenerateContentRequestShape,
    singleRequestOptions?: SingleRequestOptions,
  ): Promise<GenerateContentStreamResult> {
    return planeGenerateContentStream(
      this.target,
      this.model,
      this.mergedRequest(request),
      this.mergedOptions(singleRequestOptions),
    );
  }

  startChat(startChatParams?: StartChatParams): ChatSession {
    return new ChatSession(
      this.target,
      this.model,
      {
        tools: this.tools,
        toolConfig: this.toolConfig,
        systemInstruction: this.systemInstruction,
        generationConfig: this.generationConfig,
        safetySettings: this.safetySettings,
        // Explicit StartChatParams override the model-level inheritance.
        ...startChatParams,
      },
      this.requestOptions,
    );
  }

  async countTokens(
    request: RequestInput | GenerateContentRequestShape,
    singleRequestOptions?: SingleRequestOptions,
  ): Promise<CountTokensResponse> {
    const formattedParams = formatGenerateContentInput(request);
    return planeCountTokens(
      this.target,
      this.model,
      formattedParams as unknown as Record<string, unknown>,
      this.mergedOptions(singleRequestOptions),
    );
  }
}

/**
 * Base class for chat sessions: history storage and the sequential-send
 * guarantee (`_sendPromise` chain, upstream pattern — later sends and
 * `getHistory()` observe earlier turns in order).
 */
export abstract class ChatSessionBase {
  protected _history: ContentShape[] = [];
  protected _sendPromise: Promise<void> = Promise.resolve();

  /**
   * Chat history so far. Blocked prompts leave no trace: neither blocked
   * candidates nor the prompts that generated them are recorded. Returns a
   * defensive clone — mutations never corrupt the session.
   */
  async getHistory(): Promise<ContentShape[]> {
    await this._sendPromise;
    return structuredClone(this._history);
  }
}

/** Chat session for multi-turn conversations on a sandbox target. */
export class ChatSession extends ChatSessionBase {
  readonly model: string;
  readonly params: StartChatParams | undefined;
  readonly requestOptions: RequestOptions | undefined;

  private readonly target: SandboxTarget;

  constructor(
    target: SandboxTarget,
    model: string,
    params?: StartChatParams,
    requestOptions?: RequestOptions,
  ) {
    super();
    this.target = target;
    this.model = model;
    this.params = params;
    this.requestOptions = requestOptions;
    if (params?.history) {
      validateChatHistory(params.history);
      this._history = structuredClone(params.history);
    }
  }

  /** Format one turn into a full request over the current history. */
  private formatRequest(incomingContent: ContentShape): Record<string, unknown> {
    return {
      safetySettings: this.params?.safetySettings,
      generationConfig: this.params?.generationConfig,
      tools: this.params?.tools,
      toolConfig: this.params?.toolConfig,
      systemInstruction: this.params?.systemInstruction,
      contents: [...this._history, incomingContent],
    };
  }

  /** Chain `work` onto the send queue without poisoning it on rejection. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this._sendPromise.then(work);
    this._sendPromise = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async sendMessage(
    request: RequestInput,
    singleRequestOptions?: SingleRequestOptions,
  ): Promise<GenerateContentResult> {
    return this.enqueue(async () => {
      const content = formatNewContent(request);
      const formattedRequest = this.formatRequest(content);
      const result = await planeGenerateContent(
        this.target,
        this.model,
        formattedRequest,
        { ...this.requestOptions, ...singleRequestOptions },
      );
      const candidate = result.response.candidates?.[0];
      if (candidate) {
        this._history.push(content);
        this._history.push({
          parts: candidate.content?.parts ?? [],
          // Responses can come back without a role set.
          role: candidate.content?.role ?? 'model',
        });
      }
      return result;
    });
  }

  /**
   * Streaming chat turn — 2.13.0 FIXED semantics: the incoming content is
   * threaded into the request exactly once, and exactly one user turn lands
   * in history per call (registry row ai#chat-stream-single-user-turn).
   */
  async sendMessageStream(
    request: RequestInput,
    singleRequestOptions?: SingleRequestOptions,
  ): Promise<GenerateContentStreamResult> {
    return this.enqueue(async () => {
      const content = formatNewContent(request);
      const formattedRequest = this.formatRequest(content);
      const result = await planeGenerateContentStream(
        this.target,
        this.model,
        formattedRequest,
        { ...this.requestOptions, ...singleRequestOptions },
      );
      // History updates after aggregation; getHistory() waits via the chain.
      const historySettled = result.response
        .then((response) => {
          const candidate = response.candidates?.[0];
          if (candidate?.content) {
            this._history.push(content);
            const responseContent: ContentShape = { ...candidate.content };
            if (!responseContent.role) responseContent.role = 'model';
            this._history.push(responseContent);
          }
        })
        .catch(() => undefined);
      this._sendPromise = this._sendPromise.then(() => historySettled);
      return result;
    });
  }
}
