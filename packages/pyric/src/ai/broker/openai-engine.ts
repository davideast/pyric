import { setAiEvidence } from '../../sandbox/internal/ai-evidence.js';
import {
  AiBrokerError,
  Synthesizer,
  errorEnvelope,
  estimateTokens,
  resolveModelVersion,
} from './synthesizer.js';
import {
  joinUpstreamUrl,
  normalizeUpstreamBaseUrl,
  redactUpstreamText,
  urlCredentials,
} from './upstream-error-redaction.js';
import { promptTextOf } from './scripted-engine.js';
import {
  DONE_SENTINEL,
  geminiToOpenAIRequest,
  mapFinishReason,
  normalizeSchema,
  openAIChunkToParts,
  openAIToGeminiResponse,
  SseParser,
  ToolCallBuffer,
  type OpenAIMessage,
  type OpenAIRequest,
  type OpenAIResponse,
  type OpenAIStreamChunk,
  type OpenAIToolCall,
} from './openai-wire-translation.js';
import type {
  AnswerEngine,
  CountTokensRequest,
  CountTokensResponse,
  GenerateContentRequest,
  ModelResolution,
  WireChunk,
  WirePart,
  WireResponse,
} from './types.js';

export {
  DONE_SENTINEL,
  geminiToOpenAIRequest,
  mapFinishReason,
  normalizeSchema,
  openAIChunkToParts,
  openAIToGeminiResponse,
  SseParser,
  ToolCallBuffer,
  type OpenAIMessage,
  type OpenAIRequest,
  type OpenAIResponse,
  type OpenAIStreamChunk,
  type OpenAIToolCall,
};

export interface OpenAiEngineOptions {
  baseUrl: string;
  model?: string;
  modelMap?: Record<string, string>;
  fetch?: typeof fetch;
  synthesizer?: Synthesizer;
}

export class OpenAiEngine implements AnswerEngine {
  private readonly baseUrl: string;
  private readonly baseUrlCredentials: readonly string[];
  private readonly defaultModel: string | undefined;
  private readonly modelMap: Record<string, string>;
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly synth: Synthesizer;

  private warnedDroppedFields = false;

  constructor(options: OpenAiEngineOptions) {
    this.baseUrl = normalizeUpstreamBaseUrl(options.baseUrl);
    this.baseUrlCredentials = urlCredentials(this.baseUrl);
    this.defaultModel = options.model;
    this.modelMap = options.modelMap ?? {};
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.synth = options.synthesizer ?? new Synthesizer();
  }

  private warnDroppedFieldsOnce(req: GenerateContentRequest): void {
    if (this.warnedDroppedFields) return;
    const g = req.generationConfig;
    const hasThinking = g?.thinkingConfig !== undefined;
    const hasTopK = g?.topK !== undefined;
    if (!hasThinking && !hasTopK) return;
    this.warnedDroppedFields = true;
    const fields = [hasThinking && 'thinkingConfig', hasTopK && 'topK'].filter(Boolean).join(' and ');
    console.warn(
      `[pyric/ai] the openai engine drops ${fields} — no OpenAI-compatible equivalent on the upstream request.\n` +
        `Production still honors ${fields}; switch to a real Gemini-backed engine if this must take effect in development.`,
    );
  }

  resolveEffectiveModel(model: string): ModelResolution {
    let bare = model;
    if (model.startsWith('models/')) {
      bare = model.slice('models/'.length);
    }
    const mapped = this.modelMap[bare] ?? this.modelMap[model];
    if (mapped !== undefined) return { model: mapped, reason: 'engine modelMap' };
    if (this.defaultModel !== undefined) {
      return { model: this.defaultModel, reason: 'engine catch-all model' };
    }
    return { model: bare, reason: 'passthrough' };
  }

  resolveUpstreamModel(model: string): string {
    return this.resolveEffectiveModel(model).model;
  }

  async generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse> {
    this.warnDroppedFieldsOnce(req);
    const body = geminiToOpenAIRequest(this.resolveUpstreamModel(model), req, false);
    const res = await this.post(body);
    const upstream = (await res.json()) as OpenAIResponse;
    const translated = openAIToGeminiResponse(upstream);
    const usageSource = upstream.usage ? 'backend' : 'estimated';
    return setAiEvidence(
      this.synth.decorate(translated, { model, promptText: promptTextOf(req) }),
      { reportedModel: upstream.model, usageSource },
    );
  }

  streamGenerateContent(req: GenerateContentRequest, model: string): AsyncIterable<WireChunk> {
    this.warnDroppedFieldsOnce(req);
    const body = geminiToOpenAIRequest(this.resolveUpstreamModel(model), req, true);
    const opts = { model, promptText: promptTextOf(req) };
    const synth = this.synth;
    const post = () => this.post(body);
    const readStream = (reader: ReadableStreamDefaultReader<Uint8Array>) => this.readStream(reader);

    return (async function* stream(): AsyncGenerator<WireChunk> {
      const res = await post();
      if (!res.body) throw new AiBrokerError(errorEnvelope(502, 'upstream returned no body', 'UNAVAILABLE'));

      const modelVersion = resolveModelVersion(model);
      const responseId = synth.nextResponseId();
      const promptTokenCount = estimateTokens(opts.promptText);
      const toolBuffer = new ToolCallBuffer();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      let emittedText = '';
      let upstreamUsage: OpenAIStreamChunk['usage'];
      let reportedModel: string | undefined;
      let pendingFinish: string | null = null;

      function frame(parts: WirePart[], finishReason?: string): WireChunk {
        const candidatesTokenCount = estimateTokens(emittedText);
        let usage = {
          promptTokenCount,
          candidatesTokenCount,
          totalTokenCount: promptTokenCount + candidatesTokenCount,
        };
        if (upstreamUsage) {
          usage = {
            promptTokenCount: upstreamUsage.prompt_tokens,
            candidatesTokenCount: upstreamUsage.completion_tokens,
            totalTokenCount: upstreamUsage.total_tokens,
          };
        }
        let effectiveParts: WirePart[] = [{ text: '' }];
        if (parts.length > 0) {
          effectiveParts = parts;
        }
        const candidate: NonNullable<WireChunk['candidates']>[number] = {
          content: { parts: effectiveParts, role: 'model' },
          index: 0,
        };
        if (finishReason) {
          candidate.finishReason = finishReason;
        }
        const usageSource = upstreamUsage ? 'backend' : 'estimated';
        return setAiEvidence(
          {
            candidates: [candidate],
            usageMetadata: {
              ...usage,
              promptTokensDetails: [{ modality: 'TEXT', tokenCount: usage.promptTokenCount }],
              serviceTier: 'standard',
            },
            modelVersion,
            responseId,
          },
          { reportedModel, usageSource },
        );
      }

      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await readStream(reader);
          let payloads: string[];
          if (done) {
            payloads = parser.push('\n\n');
          } else {
            payloads = parser.push(decoder.decode(value, { stream: true }));
          }

          for (const payload of payloads) {
            if (payload.trim() === DONE_SENTINEL) continue;
            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(payload) as OpenAIStreamChunk;
            } catch {
              continue;
            }
            if (chunk.usage) upstreamUsage = chunk.usage;
            if (chunk.model) reportedModel = chunk.model;
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            toolBuffer.add(choice.delta?.tool_calls);
            const parts = openAIChunkToParts(chunk);
            for (const part of parts) {
              if (!part.thought && part.text) emittedText += part.text;
            }

            if (choice.finish_reason != null) {
              pendingFinish = choice.finish_reason;
              if (parts.length > 0) yield frame(parts);
              continue;
            }
            if (parts.length > 0) yield frame(parts);
          }

          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }

      const flushed = toolBuffer.flush();
      let rawFinalParts: WirePart[] = [{ text: '' }];
      if (flushed.parts.length > 0) {
        rawFinalParts = flushed.parts;
      }
      const finalParts = synth.signParts(rawFinalParts);
      let finalReason = mapFinishReason(pendingFinish);
      if (flushed.malformed) {
        finalReason = 'MALFORMED_FUNCTION_CALL';
      }
      yield frame(finalParts, finalReason);
    })();
  }

  async countTokens(req: CountTokensRequest, _model: string): Promise<CountTokensResponse> {
    return this.synth.countTokens(promptTextOf(req));
  }

  private async readStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
    try {
      return await reader.read();
    } catch (err) {
      if (err instanceof AiBrokerError) throw err;
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw new AiBrokerError(
        errorEnvelope(
          502,
          `openai engine: upstream stream aborted mid-response: ${redactUpstreamText(rawMessage, this.baseUrlCredentials)}`,
          'UNAVAILABLE',
        ),
      );
    }
  }

  private async post(body: OpenAIRequest): Promise<Response> {
    const endpoint = joinUpstreamUrl(this.baseUrl, '/chat/completions');
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AiBrokerError(
        errorEnvelope(
          502,
          `openai engine: upstream fetch failed: ${redactUpstreamText(String(err), this.baseUrlCredentials)}`,
          'UNAVAILABLE',
        ),
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const masked = redactUpstreamText(text, this.baseUrlCredentials).slice(0, 500);
      const statusName = res.status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT';
      throw new AiBrokerError(
        errorEnvelope(res.status, `openai engine: upstream ${res.status}: ${masked}`, statusName),
      );
    }
    return res;
  }
}
