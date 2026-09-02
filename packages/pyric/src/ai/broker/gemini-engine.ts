/**
 * The Gemini AnswerEngine: Gemini wire in, Google AI Studio / Vertex AI REST API
 * out, Gemini wire back.
 *
 * Unlike the browser-side `@firebase/ai` SDK (which calls Vertex AI directly
 * from the browser and fails with HTTP 401 for sandboxed mock auth users),
 * `GeminiEngine` runs on Pyric's backend server, authenticating via a local
 * API key (`GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` / `VITE_GEMINI_API_KEY`)
 * or Google Cloud Application Default Credentials (`gcloud auth application-default login`)
 * without exposing secrets to the browser.
 */

import { AiBrokerError, errorEnvelope, redactUrl } from './synthesizer.js';
import type {
  AnswerEngine,
  CountTokensRequest,
  CountTokensResponse,
  GenerateContentRequest,
  ModelResolution,
  WireChunk,
  WireResponse,
} from './types.js';

/** Where the gemini engine talks when no `baseUrl` overrides it. Published
 *  through `pyric/ai/internal` so the CLI's startup banner can name the same
 *  endpoint instead of keeping its own copy. */
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * BROWSER-CLEAN: acquires `node:child_process` lazily via `process.getBuiltinModule`
 * so no static node import exists for browser bundlers to resolve.
 */
function getExecSync(): ((command: string, options: Record<string, unknown>) => string) | null {
  const get = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    ?.getBuiltinModule;
  const hasGetBuiltinModule = typeof get === 'function';
  if (!hasGetBuiltinModule) {
    return null;
  }
  const cp = get.call(process, 'node:child_process') as
    | { execSync?: (cmd: string, opts: unknown) => string }
    | undefined;
  const hasExecSync = cp !== undefined && typeof cp.execSync === 'function';
  if (!hasExecSync) {
    return null;
  }
  return cp.execSync as (command: string, options: Record<string, unknown>) => string;
}

export interface GeminiEngineOptions {
  /** Explicit API key. Absent ⇒ resolved from environment variables or ADC. */
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
    this.baseUrl = (options?.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options?.fetch ?? ((input, init) => fetch(input, init));
    this.explicitKey = options?.apiKey;
  }

  /**
   * Resolves authentication credentials sequentially, checking static options,
   * environment variables, and finally Google Cloud Application Default
   * Credentials (`gcloud auth application-default print-access-token`).
   */
  private async resolveAuthToken(): Promise<{ token: string; isBearer: boolean }> {
    let key = this.explicitKey;
    if (key === undefined) {
      key = process.env.GEMINI_API_KEY;
    }
    if (key === undefined) {
      key = process.env.GOOGLE_GENAI_API_KEY;
    }
    if (key === undefined) {
      key = process.env.VITE_GEMINI_API_KEY;
    }

    if (key !== undefined) {
      const trimmedKey = key.trim();
      const hasStaticKey = trimmedKey !== '';
      if (hasStaticKey) {
        return { token: trimmedKey, isBearer: false };
      }
    }

    try {
      const execSyncFn = getExecSync();
      const hasExecSyncFn = execSyncFn !== null;
      if (hasExecSyncFn) {
        const adcToken = execSyncFn('gcloud auth application-default print-access-token', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const hasAdcToken = adcToken !== '';
        if (hasAdcToken) {
          return { token: adcToken, isBearer: true };
        }
      }
    } catch {
      // Best-effort attempt to recover ADC credentials when env keys are absent
    }

    throw new AiBrokerError(
      errorEnvelope(
        401,
        'Pyric AI production passthrough mode requires GEMINI_API_KEY, GOOGLE_GENAI_API_KEY, or VITE_GEMINI_API_KEY in your server environment (or Application Default Credentials via `gcloud auth application-default login`).',
        'UNAUTHENTICATED',
      ),
    );
  }

  /**
   * Which model this engine ACTUALLY calls upstream, and why it differs.
   * Experimental and superseded flash aliases are redirected onto the served
   * `gemini-flash-lite-latest`; everything else passes through. Reported so
   * the broker can announce the redirect rather than let a developer believe
   * `gemini-2.5-flash` answered when `gemini-flash-lite-latest` did
   * ({@link AnswerEngine.resolveEffectiveModel}).
   */
  resolveEffectiveModel(model: string): ModelResolution {
    const stripped = model.replace(/^models\//, '');
    const isExperimentalFlashLite =
      stripped === 'gemini-3.5-flash-lite' ||
      stripped === 'gemini-2.5-flash' ||
      stripped === 'gemini-2.5-flash-lite' ||
      stripped === 'gemini-1.5-flash';
    if (isExperimentalFlashLite) {
      return { model: 'gemini-flash-lite-latest', reason: 'experimental alias' };
    }
    return { model: stripped, reason: 'passthrough' };
  }

  private normalizeModel(model: string): string {
    return `models/${this.resolveEffectiveModel(model).model}`;
  }

  /**
   * Formats upstream REST endpoint URLs and request headers for either Google
   * AI Studio (`generativelanguage.googleapis.com`) or Vertex AI regional APIs.
   */
  private formatUpstreamRequest(
    resource: string,
    action: string,
    auth: { token: string; isBearer: boolean },
  ): { url: string; headers: Record<string, string> } {
    const isVertexUrl =
      this.baseUrl.includes('firebasevertexai.googleapis.com') ||
      this.baseUrl.includes('aiplatform.googleapis.com');
    const shouldUseBearerAuth = auth.isBearer || isVertexUrl;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (shouldUseBearerAuth) {
      headers['Authorization'] = `Bearer ${auth.token}`;
      return {
        url: `${this.baseUrl}/v1beta/${resource}:${action}`,
        headers,
      };
    }

    return {
      url: `${this.baseUrl}/v1beta/${resource}:${action}?key=${encodeURIComponent(auth.token)}`,
      headers,
    };
  }

  private async fetchUpstream(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Redact both: `url` always carries the key when auth is a static key
      // (not bearer/ADC); `message` is defensively redacted too in case the
      // fetch implementation's own error text echoes the request URL.
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeUrl = redactUrl(url);
      const safeMessage = redactUrl(rawMessage);
      throw new AiBrokerError(
        errorEnvelope(
          502,
          `Failed to connect to Gemini API at ${safeUrl}: ${safeMessage}`,
          'UNAVAILABLE',
        ),
      );
    }

    const isSuccess = response.ok;
    if (!isSuccess) {
      const errorText = await response.text().catch(() => '');
      throw new AiBrokerError(
        errorEnvelope(
          response.status,
          `Gemini API returned status ${response.status}: ${redactUrl(errorText)}`,
          'INTERNAL',
        ),
      );
    }

    return response;
  }

  async generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse> {
    const auth = await this.resolveAuthToken();
    const resource = this.normalizeModel(model);
    const { url, headers } = this.formatUpstreamRequest(resource, 'generateContent', auth);
    const response = await this.fetchUpstream(url, headers, req);
    return (await response.json()) as WireResponse;
  }

  async *streamGenerateContent(
    req: GenerateContentRequest,
    model: string,
  ): AsyncIterable<WireChunk> {
    const auth = await this.resolveAuthToken();
    const resource = this.normalizeModel(model);
    const { url, headers } = this.formatUpstreamRequest(
      resource,
      'streamGenerateContent?alt=sse',
      auth,
    );
    const response = await this.fetchUpstream(url, headers, req);

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
    const auth = await this.resolveAuthToken();
    const resource = this.normalizeModel(model);
    const { url, headers } = this.formatUpstreamRequest(resource, 'countTokens', auth);
    const response = await this.fetchUpstream(url, headers, req);
    return (await response.json()) as CountTokensResponse;
  }
}
