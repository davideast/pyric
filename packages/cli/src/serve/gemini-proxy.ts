/**
 * `/__pyric/ai-proxy/gemini`: where a browser gemini engine sends (#1584).
 *
 * A page or SharedWorker has no server environment, and the Gemini API key
 * must never reach it. The browser engine sends each request here with no
 * credentials. The dev server sends it on with the gemini engine's own
 * request code (`GeminiUpstream` from `pyric/ai/internal`): the key from the
 * server's environment or ADC, to the server's configured base URL. A
 * successful answer streams back unchanged, except an error event inside a
 * stream, which has any credential it quotes masked (#1660). An error comes
 * back with its status and with any credential it quotes masked, so the
 * browser engine reads Gemini's own error and never the key.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GeminiUpstream,
  maskStreamErrors,
  redactUpstreamError,
  redactUpstreamSuccessBody,
  type GeminiUpstreamOptions,
} from 'pyric/ai/internal';
import type { ServeLogger } from './server.js';
import { fetchAiUpstream, readAiProxyBody, relayAiUpstream, type AiDiagnosticThrottle } from './ai-proxy.js';
import { watchAiProxyClientDisconnect } from './ai-proxy-disconnect.js';
import { GEMINI_PROXY_PATH } from './worker/ai-proxy-paths.js';
import { serializeError, type AiEngineConfigWire } from './worker/protocol.js';

export { GEMINI_PROXY_PATH } from './worker/ai-proxy-paths.js';

/** The server's gemini engine config: the Vite plugin's `ai.engine`, when it is gemini. */
export interface GeminiProxyConfig {
  baseUrl?: string;
  apiKey?: string;
}

/** The gemini proxy's config from a configured engine, when that engine is gemini. */
export function geminiProxyConfig(engine: AiEngineConfigWire | undefined): GeminiProxyConfig | undefined {
  const isGemini = engine?.kind === 'gemini';
  if (!isGemini) return undefined;
  const out: GeminiProxyConfig = {};
  if (engine.baseUrl !== undefined) out.baseUrl = engine.baseUrl;
  if (engine.apiKey !== undefined) out.apiKey = engine.apiKey;
  return out;
}

/** `/v1beta/models/<model>:<call>`, for the three calls the browser engine makes. */
const GEMINI_CALL_PATH = /^\/v1beta\/(models\/[A-Za-z0-9._-]+):(generateContent|streamGenerateContent|countTokens)$/;

/** The query each call may carry: only the stream asks for server-sent events. */
const CALL_QUERY: Record<string, string> = {
  generateContent: '',
  countTokens: '',
  streamGenerateContent: '?alt=sse',
};

/** Is this request for the gemini proxy (and not the OpenAI-compatible one)? */
export function isGeminiProxyPath(pathname: string): boolean {
  return pathname.startsWith(`${GEMINI_PROXY_PATH}/`);
}

/** The resource and the action `GeminiUpstream.send` takes, or null for anything else. */
function geminiCall(url: URL): { resource: string; action: string } | null {
  const match = url.pathname.slice(GEMINI_PROXY_PATH.length).match(GEMINI_CALL_PATH);
  if (match === null) return null;
  const [, resource, call] = match as unknown as [string, string, string];
  const isExpectedQuery = url.search === CALL_QUERY[call];
  if (!isExpectedQuery) return null;
  return { resource, action: `${call}${url.search}` };
}

/** Answer with a Gemini error envelope, as the upstream would. */
function sendEnvelope(res: ServerResponse, code: number, message: string, status: string): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { code, message, status } }));
}

/**
 * Send a non-2xx upstream answer with the credentials the request carried
 * removed, in whatever form the upstream quotes them, and a JSON envelope
 * kept parseable (`redactUpstreamError`, shared with the gemini engine).
 */
async function relayRedactedError(
  upstream: Response,
  credentials: readonly string[],
  res: ServerResponse,
): Promise<void> {
  const text = redactUpstreamError(await upstream.text().catch(() => ''), credentials);
  if (Boolean(res.destroyed) || res.writableEnded) return;
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  res.writeHead(upstream.status, headers);
  res.end(text);
}

/**
 * The upstream's 2xx answer, masked before it reaches the browser:
 * - SSE streams pipe through `maskStreamErrors` without buffering normal events.
 * - Non-streaming JSON/text responses pass through `redactUpstreamSuccessBody`
 *   with `maskExactCredentials: true` so server-held credentials (`GEMINI_API_KEY`,
 *   ADC tokens, baseUrl credentials) never leak to the browser in 200 JSON error
 *   envelopes or echoed responses, while normal model text and unrelated `?key=`
 *   URLs remain untouched (ADR 0024).
 */
async function maskedSuccess(
  response: Response,
  action: string,
  credentials: readonly string[],
): Promise<Response> {
  if (response.body === null) return response;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const isEventStream = contentType.includes('text/event-stream');
  const isJson = contentType.includes('json');
  const isStream = isEventStream || (action.startsWith('streamGenerateContent') && !isJson);
  if (isStream) {
    return new Response(maskStreamErrors(response.body, credentials), {
      status: response.status,
      headers: response.headers,
    });
  }
  const isTextLike = contentType === '' || isJson || contentType.startsWith('text/');
  if (!isTextLike) return response;
  const rawBody = await response.text().catch(() => '');
  const maskedBody = redactUpstreamSuccessBody(rawBody, credentials, { maskExactCredentials: true });
  return new Response(maskedBody, {
    status: response.status,
    headers: response.headers,
  });
}

/**
 * The gemini proxy handler. One `GeminiUpstream` serves every request, so an
 * ADC token is looked up once and reused, as the engine itself does.
 * `seams` replaces the ADC lookup in tests.
 */
export function createGeminiProxy(
  config: GeminiProxyConfig | undefined,
  throttle: AiDiagnosticThrottle,
  logger?: ServeLogger,
  seams: Pick<GeminiUpstreamOptions, 'printAdcToken'> = {},
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> {
  const upstreamOptions: GeminiUpstreamOptions = {
    ...seams,
    fetch: Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetchAiUpstream(input, init, throttle, logger),
      { preconnect: fetch.preconnect },
    ),
  };
  if (config?.baseUrl !== undefined) upstreamOptions.baseUrl = config.baseUrl;
  if (config?.apiKey !== undefined) upstreamOptions.apiKey = config.apiKey;
  const upstream = new GeminiUpstream(upstreamOptions);
  return async (req, res, url) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end('method not allowed');
      return;
    }
    const call = geminiCall(url);
    if (call === null) {
      sendEnvelope(
        res,
        404,
        `pyric dev ai-proxy: ${url.pathname} is not a Gemini call the proxy sends.`,
        'NOT_FOUND',
      );
      return;
    }
    const disconnect = watchAiProxyClientDisconnect(req, res);
    try {
      const body = await readAiProxyBody(req, res);
      if (body === null || disconnect.isDisconnected()) return;
      let response: Response;
      let credentials: string[];
      try {
        ({ response, credentials } = await upstream.sendWithCredentials(
          call.resource,
          call.action,
          body,
          disconnect.signal,
        ));
      } catch (error) {
        if (disconnect.isDisconnected() || disconnect.signal.aborted) {
          return;
        }
        const envelope = serializeError(error).aiEnvelope;
        if (envelope === undefined) throw error;
        sendEnvelope(res, envelope.error.code, envelope.error.message, envelope.error.status);
        return;
      }
      if (disconnect.isDisconnected()) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (response.ok) {
        const masked = await maskedSuccess(response, call.action, credentials);
        if (disconnect.isDisconnected()) {
          await masked.body?.cancel().catch(() => {});
          return;
        }
        await relayAiUpstream(masked, res);
        return;
      }
      await relayRedactedError(response, credentials, res);
    } finally {
      disconnect.dispose();
    }
  };
}
