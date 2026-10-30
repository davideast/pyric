/**
 * The Gemini AnswerEngine: Gemini wire in, Google AI Studio / Vertex AI REST API
 * out, Gemini wire back.
 *
 * A sandbox engine an app selects with `engine: { kind: 'gemini' }`. It runs
 * on Pyric's backend server, authenticating via a local API key
 * (`GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY`) or Google
 * Cloud Application Default Credentials (`gcloud auth application-default login`)
 * without exposing secrets to the browser. In a browser page or SharedWorker
 * its base URL is the dev server's `/__pyric/ai-proxy/gemini` route, and the
 * server attaches the credentials (`gemini-upstream.ts`). AI production mode
 * does not use it: there `firebase/ai` is the Firebase SDK.
 *
 * The requested model id goes upstream unchanged, and an upstream error
 * reaches the caller with the upstream's own code, status and message.
 */

import { AiBrokerError, errorEnvelope } from './synthesizer.js';
import { GeminiUpstream, type GeminiUpstreamOptions } from './gemini-upstream.js';
import { redactUpstreamText } from './upstream-error-redaction.js';
import type {
  AnswerEngine,
  CountTokensRequest,
  CountTokensResponse,
  GenerateContentRequest,
  ModelResolution,
  WireChunk,
  WireResponse,
} from './types.js';

export { GEMINI_DEFAULT_BASE_URL, hasGeminiStaticKey } from './gemini-upstream.js';

/** The `message` and `status` of a Gemini `{ error: { ... } }` body, or null. */
function parseUpstreamError(text: string): { message: string; status: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const error = (parsed as { error?: { message?: unknown; status?: unknown } } | null)?.error;
  const isEnvelope = typeof error?.message === 'string' && typeof error.status === 'string';
  if (!isEnvelope) return null;
  return { message: error.message as string, status: error.status as string };
}

export type GeminiEngineOptions = GeminiUpstreamOptions;

export class GeminiEngine implements AnswerEngine {
  private readonly upstream: GeminiUpstream;

  constructor(options?: GeminiEngineOptions) {
    this.upstream = new GeminiUpstream(options);
  }

  /**
   * Whether a static key is configured, checking the explicit option and the
   * same environment variables the upstream request does, without resolving
   * Application Default Credentials: a status read must never shell out, and
   * ADC's own presence answers only at call time.
   */
  hasKeyConfigured(): boolean {
    return this.upstream.hasKeyConfigured();
  }

  /** Sends one upstream request; a non-2xx answer throws the upstream's own error. */
  private async send(model: string, action: string, body: unknown): Promise<Response> {
    const { response, credentials } = await this.upstream.sendWithCredentials(
      this.normalizeModel(model),
      action,
      JSON.stringify(body),
    );
    return this.checkStatus(response, credentials);
  }

  /**
   * The model this engine calls upstream: always the requested one. The
   * upstream decides whether a model id is served, so a retired id fails
   * with the upstream's own 404 and a `-latest` alias resolves upstream
   * ({@link AnswerEngine.resolveEffectiveModel}).
   */
  resolveEffectiveModel(model: string): ModelResolution {
    return { model: model.replace(/^models\//, ''), reason: 'passthrough' };
  }

  private normalizeModel(model: string): string {
    return `models/${this.resolveEffectiveModel(model).model}`;
  }

  /**
   * A non-2xx upstream answer becomes an {@link AiBrokerError} carrying the
   * upstream's own error envelope: its HTTP code, `status` and message. A
   * body that is not a Gemini error envelope keeps the HTTP code and reports
   * the body text. Either way the credentials the request carried are masked
   * in every form the upstream can quote them, as the gemini proxy masks
   * them (`upstream-error-redaction.ts`).
   */
  private async checkStatus(response: Response, credentials: readonly string[]): Promise<Response> {
    const isSuccess = response.ok;
    if (isSuccess) return response;
    const errorText = await response.text().catch(() => '');
    const upstream = parseUpstreamError(errorText);
    if (upstream !== null) {
      const message = redactUpstreamText(upstream.message, credentials);
      throw new AiBrokerError(errorEnvelope(response.status, message, upstream.status));
    }
    throw new AiBrokerError(
      errorEnvelope(
        response.status,
        `Gemini API returned status ${response.status}: ${redactUpstreamText(errorText, credentials)}`,
        'INTERNAL',
      ),
    );
  }

  async generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse> {
    const response = await this.send(model, 'generateContent', req);
    return (await response.json()) as WireResponse;
  }

  async *streamGenerateContent(
    req: GenerateContentRequest,
    model: string,
  ): AsyncIterable<WireChunk> {
    const response = await this.send(model, 'streamGenerateContent?alt=sse', req);

    const hasBody = response.body !== null && response.body !== undefined;
    if (!hasBody) {
      throw new AiBrokerError(
        errorEnvelope(500, 'Gemini API returned an empty stream response.', 'INTERNAL'),
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        const isDone = done === true;
        if (isDone) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const isDataLine = line.startsWith('data: ');
          if (!isDataLine) {
            continue;
          }
          const dataStr = line.slice(6).trim();
          const isEmptyOrDone = dataStr === '' || dataStr === '[DONE]';
          if (isEmptyOrDone) {
            continue;
          }
          try {
            const chunk = JSON.parse(dataStr) as WireChunk;
            yield chunk;
          } catch {
            // Ignore malformed SSE chunk in stream
          }
        }
      }

      const hasTrailingBuffer = buffer.trim().length > 0;
      if (hasTrailingBuffer) {
        const line = buffer.trim();
        const isDataLine = line.startsWith('data: ');
        if (isDataLine) {
          const dataStr = line.slice(6).trim();
          const isNotEmptyOrDone = dataStr !== '' && dataStr !== '[DONE]';
          if (isNotEmptyOrDone) {
            try {
              const chunk = JSON.parse(dataStr) as WireChunk;
              yield chunk;
            } catch {
              // Ignore malformed SSE chunk in stream
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async countTokens(req: CountTokensRequest, model: string): Promise<CountTokensResponse> {
    const response = await this.send(model, 'countTokens', req);
    return (await response.json()) as CountTokensResponse;
  }
}
