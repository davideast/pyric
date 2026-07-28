/**
 * The Gemini AnswerEngine: Gemini wire in, Google AI Studio / Gemini REST API
 * out, Gemini wire back.
 *
 * Unlike the browser-side `@firebase/ai` SDK (which calls Vertex AI directly
 * from the browser and fails with HTTP 401 for sandboxed mock auth users),
 * `GeminiEngine` runs on Pyric's backend server, authenticating via a local
 * API key (`GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` / `VITE_GEMINI_API_KEY`)
 * or Application Default Credentials without exposing secrets to the browser.
 */

import { AiBrokerError, errorEnvelope } from './synthesizer.js';
import type {
  AnswerEngine,
  CountTokensRequest,
  CountTokensResponse,
  GenerateContentRequest,
  WireChunk,
  WireResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

export interface GeminiEngineOptions {
  /** Explicit API key. Absent ⇒ resolved from environment variables. */
  apiKey?: string;
  /** Explicit base URL override (default: https://generativelanguage.googleapis.com). */
  baseUrl?: string;
  /** Explicit fetch seam for testing or custom transport. */
  fetch?: typeof fetch;
}

export class GeminiEngine implements AnswerEngine {
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly explicitKey?: string;

  constructor(options?: GeminiEngineOptions) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options?.fetch ?? ((input, init) => fetch(input, init));
    this.explicitKey = options?.apiKey;
  }

  private resolveApiKey(): string {
    const key =
      this.explicitKey ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_GENAI_API_KEY ??
      process.env.VITE_GEMINI_API_KEY;
    if (!key) {
      throw new AiBrokerError(
        errorEnvelope(
          401,
          'Pyric AI production passthrough mode requires GEMINI_API_KEY, GOOGLE_GENAI_API_KEY, or VITE_GEMINI_API_KEY in your server environment.',
          'UNAUTHENTICATED',
        ),
      );
    }
    return key;
  }

  private normalizeModel(model: string): string {
    const stripped = model.replace(/^models\//, '');
    return `models/${stripped}`;
  }

  async generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse> {
    const apiKey = this.resolveApiKey();
    const resource = this.normalizeModel(model);
    const url = `${this.baseUrl}/v1beta/${resource}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      });
    } catch (err) {
      throw new AiBrokerError(
        errorEnvelope(
          502,
          `Failed to connect to Gemini API at ${url}: ${err instanceof Error ? err.message : String(err)}`,
          'UNAVAILABLE',
        ),
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new AiBrokerError(
        errorEnvelope(
          response.status,
          `Gemini API returned status ${response.status}: ${errorText}`,
          'INTERNAL',
        ),
      );
    }

    return (await response.json()) as WireResponse;
  }

  async *streamGenerateContent(
    req: GenerateContentRequest,
    model: string,
  ): AsyncIterable<WireChunk> {
    const apiKey = this.resolveApiKey();
    const resource = this.normalizeModel(model);
    const url = `${this.baseUrl}/v1beta/${resource}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      });
    } catch (err) {
      throw new AiBrokerError(
        errorEnvelope(
          502,
          `Failed to connect to Gemini API at ${url}: ${err instanceof Error ? err.message : String(err)}`,
          'UNAVAILABLE',
        ),
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new AiBrokerError(
        errorEnvelope(
          response.status,
          `Gemini API returned status ${response.status}: ${errorText}`,
          'INTERNAL',
        ),
      );
    }

    if (!response.body) {
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
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const chunk = JSON.parse(dataStr) as WireChunk;
            yield chunk;
          } catch {
            // Ignore malformed SSE chunk in stream
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async countTokens(req: CountTokensRequest, model: string): Promise<CountTokensResponse> {
    const apiKey = this.resolveApiKey();
    const resource = this.normalizeModel(model);
    const url = `${this.baseUrl}/v1beta/${resource}:countTokens?key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      });
    } catch (err) {
      throw new AiBrokerError(
        errorEnvelope(
          502,
          `Failed to connect to Gemini API at ${url}: ${err instanceof Error ? err.message : String(err)}`,
          'UNAVAILABLE',
        ),
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new AiBrokerError(
        errorEnvelope(
          response.status,
          `Gemini API returned status ${response.status}: ${errorText}`,
          'INTERNAL',
        ),
      );
    }

    return (await response.json()) as CountTokensResponse;
  }
}
