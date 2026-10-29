/**
 * `/__pyric/ai-proxy/gemini`: where a browser gemini engine sends (#1584).
 *
 * A page or SharedWorker has no server environment, and the Gemini API key
 * must never reach it. The browser engine sends each request here with no
 * credentials. The dev server sends it on with the gemini engine's own
 * request code (`GeminiUpstream` from `pyric/ai/internal`): the key from the
 * server's environment or ADC, to the server's configured base URL. The
 * upstream's answer streams back unchanged, so the browser engine reads
 * Gemini's own errors as it would directly.
 *
 * The browser chooses only the model and the call. The target and the
 * credentials are the server's, so no page can send the key anywhere else.
 * The App Check gate runs before any of this, in the broker that owns the
 * browser engine.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GeminiUpstream, type GeminiUpstreamOptions } from 'pyric/ai/internal';
import type { ServeLogger } from './server.js';
import { fetchAiUpstream, relayAiUpstream, type AiDiagnosticThrottle } from './ai-proxy.js';
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
  return {
    ...(engine.baseUrl !== undefined ? { baseUrl: engine.baseUrl } : {}),
    ...(engine.apiKey !== undefined ? { apiKey: engine.apiKey } : {}),
  };
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

function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = new Uint8Array(raw.byteLength);
      body.set(raw);
      resolve(body);
    });
    req.on('error', reject);
  });
}

/** Answer with a Gemini error envelope, as the upstream would. */
function sendEnvelope(res: ServerResponse, code: number, message: string, status: string): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { code, message, status } }));
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
  const upstream = new GeminiUpstream({
    ...seams,
    ...(config?.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config?.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    fetch: Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetchAiUpstream(input, init, throttle, logger),
      { preconnect: fetch.preconnect },
    ),
  });
  return async (req, res, url) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end('method not allowed');
      return;
    }
    const call = geminiCall(url);
    if (call === null) {
      sendEnvelope(res, 404, `pyric dev ai-proxy: ${url.pathname} is not a Gemini call the proxy sends.`, 'NOT_FOUND');
      return;
    }
    const body = await readBody(req);
    let response: Response;
    try {
      response = await upstream.send(call.resource, call.action, body);
    } catch (error) {
      // Missing credentials (401) and an unreachable upstream (502) come as
      // the engine's own envelopes, already redacted.
      const envelope = serializeError(error).aiEnvelope;
      if (envelope === undefined) throw error;
      sendEnvelope(res, envelope.error.code, envelope.error.message, envelope.error.status);
      return;
    }
    await relayAiUpstream(response, res);
  };
}
