/**
 * One request to the Gemini REST API, with its credentials: what the gemini
 * engine sends, and what Pyric's dev server sends on a browser engine's
 * behalf.
 *
 * Credentials come from the explicit key, else `GEMINI_API_KEY` or
 * `GOOGLE_GENAI_API_KEY`, else Google Cloud Application Default Credentials.
 * `VITE_GEMINI_API_KEY` is not read: Vite serves every `VITE_`-prefixed
 * variable to the browser, so the Vite plugin refuses to start with it set
 * (#1632). A browser engine is built with
 * `serverAttachesAuth`: its base URL is the dev server's
 * `/__pyric/ai-proxy/gemini`, which attaches the credentials itself, so none
 * are sent and the browser never holds the key.
 */

import { AiBrokerError, errorEnvelope, redactUrl } from './synthesizer.js';

/** Where the gemini engine talks when no `baseUrl` overrides it. Published
 *  through `pyric/ai/internal` so the CLI's startup banner can name the same
 *  endpoint instead of keeping its own copy. */
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

const KEY_VARIABLES = ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'] as const;

/** A variable from the runtime's environment, or undefined where there is
 *  none: a browser page or SharedWorker has no `process`. */
function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

/** The explicit key, else the first key variable that is defined. */
function configuredKey(explicitKey: string | undefined): string | undefined {
  if (explicitKey !== undefined) return explicitKey;
  for (const name of KEY_VARIABLES) {
    const value = readEnv(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Whether a static API key is configured: the explicit option, else the first
 * of `GEMINI_API_KEY`, `GOOGLE_GENAI_API_KEY` that is defined, which must
 * then be non-blank. This is the engine's own precedence
 * (a blank earlier variable shadows a later real one), published through
 * `pyric/ai/internal` so the CLI's startup banner cannot disagree with it.
 * Application Default Credentials are not consulted: a status read must never
 * shell out.
 */
export function hasGeminiStaticKey(explicitKey: string | undefined): boolean {
  const chosen = configuredKey(explicitKey);
  return chosen !== undefined && chosen.trim() !== '';
}

const ADC_COMMAND = 'gcloud auth application-default print-access-token';

/**
 * How long a looked-up ADC access token is reused. The command prints only
 * the token, not its expiry. It refreshes the credential on every run, so the
 * printed token is newly minted with the default lifetime of one hour; 30
 * minutes stays well inside that. An upstream 401 also refreshes the token
 * early.
 */
const ADC_TOKEN_TTL_MS = 30 * 60 * 1000;

type ExecCallback = (error: Error | null, stdout: string) => void;
type ExecFn = (command: string, options: Record<string, unknown>, callback: ExecCallback) => unknown;

/**
 * BROWSER-CLEAN: acquires `node:child_process` lazily via `process.getBuiltinModule`
 * so no static node import exists for browser bundlers to resolve.
 */
function getExec(): ExecFn | null {
  const runtime = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const get = runtime?.getBuiltinModule;
  const hasGetBuiltinModule = typeof get === 'function';
  if (!hasGetBuiltinModule) {
    return null;
  }
  const cp = get.call(runtime, 'node:child_process') as { exec?: unknown } | undefined;
  const hasExec = cp !== undefined && typeof cp.exec === 'function';
  if (!hasExec) {
    return null;
  }
  return cp.exec as ExecFn;
}

/**
 * Runs the gcloud ADC command without blocking the event loop. The command
 * runs through the shell, as `gcloud` is a script on every platform. Stderr
 * is captured and discarded. Resolves to the empty string when no runtime
 * child process is available.
 */
function printAdcTokenWithGcloud(): Promise<string> {
  const exec = getExec();
  if (exec === null) {
    return Promise.resolve('');
  }
  return new Promise((resolve, reject) => {
    exec(ADC_COMMAND, { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

export interface GeminiUpstreamOptions {
  /** Explicit API key. Absent ⇒ resolved from environment variables or ADC. */
  apiKey?: string;
  /** Explicit base URL override (default: https://generativelanguage.googleapis.com). */
  baseUrl?: string;
  /** Explicit fetch seam for testing or custom transport. */
  fetch?: typeof fetch;
  /** Prints an ADC access token. Defaults to running
   *  `gcloud auth application-default print-access-token`. */
  printAdcToken?: () => Promise<string>;
  /** Clock for the ADC token lifetime, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** The base URL is Pyric's dev server, which attaches the credentials, so
   *  none are resolved or sent. Set only for a browser engine. */
  serverAttachesAuth?: boolean;
}

interface UpstreamAuth {
  token: string;
  isBearer: boolean;
  /** The token came from Application Default Credentials, so a 401 can be
   *  answered by looking up a fresh one. */
  isAdc: boolean;
}

/** The secret a request carries, or none when the server attaches it. */
function credentialsOf(auth: UpstreamAuth): string[] {
  const hasToken = auth.token !== '';
  return hasToken ? [auth.token] : [];
}

/** No credentials: the base URL is Pyric's server, which attaches them. */
const SERVER_ATTACHES_AUTH: UpstreamAuth = { token: '', isBearer: false, isAdc: false };

export class GeminiUpstream {
  readonly baseUrl: string;
  /** The base URL is Pyric's server, which attaches the credentials. */
  readonly serverAttachesAuth: boolean;
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly explicitKey?: string;
  private readonly printAdcToken: () => Promise<string>;
  private readonly now: () => number;
  private adcToken: { token: string; expiresAt: number } | undefined;
  private adcLookup: Promise<string> | undefined;

  constructor(options?: GeminiUpstreamOptions) {
    this.baseUrl = (options?.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options?.fetch ?? ((input, init) => fetch(input, init));
    this.explicitKey = options?.apiKey;
    this.printAdcToken = options?.printAdcToken ?? printAdcTokenWithGcloud;
    this.now = options?.now ?? Date.now;
    this.serverAttachesAuth = options?.serverAttachesAuth === true;
  }

  /**
   * Whether a static key is configured, checking the explicit option and the
   * same environment variables {@link resolveAuthToken} does, without
   * resolving Application Default Credentials: a status read must never
   * shell out, and ADC's own presence answers only at call time.
   */
  hasKeyConfigured(): boolean {
    return hasGeminiStaticKey(this.explicitKey);
  }

  /**
   * Sends one upstream request and returns the upstream's own response,
   * whatever its status. When the token came from ADC and the upstream
   * answers 401, the cached token is dropped and the request is sent once
   * more with a fresh one. Missing credentials and an unreachable upstream
   * throw an {@link AiBrokerError}.
   */
  async send(resource: string, action: string, body: string | Uint8Array<ArrayBuffer>): Promise<Response> {
    return (await this.sendWithCredentials(resource, action, body)).response;
  }

  /**
   * {@link send}, also returning the credentials the request carried: the
   * static key or the ADC tokens, as sent. A caller that relays the
   * upstream's answer removes them from any text it passes on, whatever
   * form the upstream quotes them in.
   */
  async sendWithCredentials(
    resource: string,
    action: string,
    body: string | Uint8Array<ArrayBuffer>,
  ): Promise<{ response: Response; credentials: string[] }> {
    const auth = await this.resolveAuthToken();
    const credentials = credentialsOf(auth);
    const first = this.formatUpstreamRequest(resource, action, auth);
    const response = await this.post(first.url, first.headers, body);
    if (response.status === 401 && auth.isAdc) {
      await response.body?.cancel().catch(() => {});
      this.adcToken = undefined;
      const retryAuth = await this.resolveAuthToken();
      credentials.push(...credentialsOf(retryAuth));
      const retry = this.formatUpstreamRequest(resource, action, retryAuth);
      return { response: await this.post(retry.url, retry.headers, body), credentials };
    }
    return { response, credentials };
  }

  /**
   * Resolves authentication credentials sequentially, checking static options,
   * environment variables, and finally Google Cloud Application Default
   * Credentials (`gcloud auth application-default print-access-token`).
   */
  private async resolveAuthToken(): Promise<UpstreamAuth> {
    if (this.serverAttachesAuth) return SERVER_ATTACHES_AUTH;
    const key = configuredKey(this.explicitKey);
    if (key !== undefined) {
      const trimmedKey = key.trim();
      const hasStaticKey = trimmedKey !== '';
      if (hasStaticKey) {
        return { token: trimmedKey, isBearer: false, isAdc: false };
      }
    }

    const adcToken = await this.cachedAdcToken();
    if (adcToken !== '') {
      return { token: adcToken, isBearer: true, isAdc: true };
    }

    throw new AiBrokerError(
      errorEnvelope(
        401,
        'The Pyric gemini AI engine requires GEMINI_API_KEY or GOOGLE_GENAI_API_KEY in your server environment (or Application Default Credentials via `gcloud auth application-default login`).',
        'UNAUTHENTICATED',
      ),
    );
  }

  /**
   * The ADC access token, reused for {@link ADC_TOKEN_TTL_MS}. Concurrent
   * callers share one lookup. A failed or empty lookup is not cached, so the
   * next request tries again. Resolves to the empty string when ADC is
   * unavailable.
   */
  private cachedAdcToken(): Promise<string> {
    const cached = this.adcToken;
    if (cached !== undefined && this.now() < cached.expiresAt) {
      return Promise.resolve(cached.token);
    }
    if (this.adcLookup !== undefined) {
      return this.adcLookup;
    }
    const lookup = this.lookUpAdcToken();
    this.adcLookup = lookup;
    void lookup.then(() => {
      if (this.adcLookup === lookup) {
        this.adcLookup = undefined;
      }
    });
    return lookup;
  }

  private async lookUpAdcToken(): Promise<string> {
    let token = '';
    try {
      token = (await this.printAdcToken()).trim();
    } catch {
      return '';
    }
    if (token !== '') {
      this.adcToken = { token, expiresAt: this.now() + ADC_TOKEN_TTL_MS };
    }
    return token;
  }

  /**
   * Formats upstream REST endpoint URLs and request headers for either Google
   * AI Studio (`generativelanguage.googleapis.com`) or Vertex AI regional APIs.
   */
  private formatUpstreamRequest(
    resource: string,
    action: string,
    auth: UpstreamAuth,
  ): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const url = `${this.baseUrl}/v1beta/${resource}:${action}`;
    if (this.serverAttachesAuth) return { url, headers };
    const isVertexUrl =
      this.baseUrl.includes('firebasevertexai.googleapis.com') ||
      this.baseUrl.includes('aiplatform.googleapis.com');
    const shouldUseBearerAuth = auth.isBearer || isVertexUrl;
    if (shouldUseBearerAuth) {
      headers['Authorization'] = `Bearer ${auth.token}`;
      return { url, headers };
    }
    // The stream's action already carries `?alt=sse`.
    const separator = url.includes('?') ? '&' : '?';
    return { url: `${url}${separator}key=${encodeURIComponent(auth.token)}`, headers };
  }

  private async post(
    url: string,
    headers: Record<string, string>,
    body: string | Uint8Array<ArrayBuffer>,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, { method: 'POST', headers, body });
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
  }
}
