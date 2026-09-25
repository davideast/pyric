/**
 * `/__pyric/ai-proxy`: the same-origin passthrough to an OpenAI-compatible
 * upstream, plus the terminal diagnostics that make an upstream failure
 * visible to a developer with no browser console open.
 *
 * The route is always mounted; it only touches the network when a request
 * arrives. Everything about WHERE it forwards is resolved by
 * {@link resolveAiProxyUpstream}, which the startup banner (`ai-status.ts`)
 * shares so the two can never disagree.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServeLogger } from './server.js';
import { redactUrl } from 'pyric/ai/internal';
import { sanitizeForTerminal } from './ai-terminal-text.js';
import type { AiEngineConfigWire } from './worker/protocol.js';
import { permitGuardHost } from '../register/net-guard.js';

/** The dev server's diagnostics throttle, as this module needs it: the
 *  denials route owns the instance, and the proxy shares it so a failing
 *  upstream cannot out-shout a denied listener. */
export interface AiDiagnosticThrottle {
  shouldPrint(key: string, now: number): boolean;
}

/** Default upstream: local Ollama's OpenAI-compatible endpoint. */
export const AI_PROXY_DEFAULT_UPSTREAM = 'http://localhost:11434/v1';

/** The route the dev server mounts for OpenAI-compatible traffic. */
export const AI_PROXY_ROUTE = '/__pyric/ai-proxy';

/**
 * Request headers that must NOT be forwarded upstream: origin-sensitive
 * browser context (`origin`/`referer`/`cookie`, since the upstream is a
 * different origin and must never see the page's), hop-by-hop headers, and
 * the two the proxy re-derives (`host`, `content-length`). `accept-encoding`
 * is dropped so fetch negotiates its own compression and the streamed body
 * needs no length fixups.
 */
const AI_PROXY_STRIPPED_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'content-length',
  'accept-encoding',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** The upstream-failure shapes the proxy surfaces to the terminal. */
type AiProxyFailure =
  | { kind: 'unreachable'; target: string; latencyMs: number; cause: string }
  | {
      kind: 'status';
      target: string;
      latencyMs: number;
      status: number;
      /** The upstream's raw `Retry-After` header, when it sent one. */
      retryAfter?: string;
    }
  | { kind: 'stream-abort'; target: string; latencyMs: number; cause: string };

/** Longest `Retry-After` value echoed to the terminal (delta-seconds and
 *  HTTP-dates are both far shorter; anything longer is upstream noise). */
const AI_PROXY_RETRY_AFTER_MAX = 64;

/**
 * Render a `Retry-After` value for the terminal, or `null` when there is
 * nothing worth printing.
 *
 * The header is remote-authored, so it is sanitized and length-capped like
 * every other upstream string that reaches the terminal. Delta-seconds (the
 * common form) get an `s` suffix so the wait reads as a duration; the
 * HTTP-date form is echoed verbatim, since `Wed, 21 Oct 2026 07:28:00 GMTs`
 * would be nonsense.
 */
function formatRetryAfter(raw: string): string | null {
  const clean = sanitizeForTerminal(raw).slice(0, AI_PROXY_RETRY_AFTER_MAX).trim();
  if (clean === '') return null;
  if (/^\d+$/.test(clean)) return `${clean}s`;
  return clean;
}

/**
 * Mask credentials, then flatten and cap, in that order. Both the target and
 * a raw fetch error message are remote-influenced: the URL carries whatever
 * the page put in the query string, and an error message can quote it back.
 */
function safeUpstreamText(text: string): string {
  return sanitizeForTerminal(redactUrl(text));
}

/**
 * The throttle key for one upstream failure. A failing upstream fails on
 * every request, so the key is the failure itself (kind, status, and the
 * redacted target) rather than anything per-request: one line per window,
 * exactly like a denied listener that re-fires.
 */
function aiProxyThrottleKey(failure: AiProxyFailure): string {
  const target = redactUrl(failure.target);
  if (failure.kind === 'status') return `ai-proxy status ${failure.status} ${target}`;
  return `ai-proxy ${failure.kind} ${target}`;
}

/** Print one upstream failure, unless the throttle already printed it. */
function noteAiProxyFailure(
  failure: AiProxyFailure,
  throttle: AiDiagnosticThrottle,
  logger?: ServeLogger,
  source = 'ai-proxy',
): void {
  if (logger === undefined) return;
  if (!throttle.shouldPrint(aiProxyThrottleKey(failure), Date.now())) return;
  logger.note(formatAiProxyWarning(failure, source));
}

/**
 * Format an upstream failure into the compact terminal block, the same
 * `  [pyric] ...` idiom the denial relay prints, so ai-proxy trouble reads
 * like every other dev-server diagnostic. Two lines: what went wrong, then
 * the (redacted) upstream URL with the elapsed time. Exported for unit tests.
 *
 * A 429 says so in words (`rate limited`): the bare number reads as one more
 * failed request, when it actually means the upstream is shedding load or the
 * key is out of quota. When the upstream sent a `Retry-After`, a third line
 * prints the wait it asked for, and states that NOTHING here waits on the
 * developer's behalf. The proxy has no retry loop (the status rides straight
 * through to the caller), so the backoff is the app's decision, not pyric's.
 */
export function formatAiProxyWarning(failure: AiProxyFailure, source = 'ai-proxy'): string {
  const target = safeUpstreamText(failure.target);
  let headline: string;
  if (failure.kind === 'unreachable') {
    headline = `upstream unreachable: ${safeUpstreamText(failure.cause)}`;
  } else if (failure.kind === 'status') {
    const rateLimited = failure.status === 429;
    headline = `upstream returned ${failure.status}${rateLimited ? ' (rate limited / quota exhausted)' : ''}`;
  } else {
    headline = `upstream stream aborted mid-response: ${safeUpstreamText(failure.cause)}`;
  }
  const lines = [
    `  ⚠ [pyric] ${source}: ${headline}`,
    `      POST ${target} (${failure.latencyMs}ms)`,
  ];
  if (failure.kind === 'unreachable') {
    lines.push(
      `      set PYRIC_AI_PROXY_UPSTREAM to an OpenAI-compatible base URL (default ${AI_PROXY_DEFAULT_UPSTREAM})`,
    );
  }
  if (failure.kind === 'status' && failure.retryAfter !== undefined) {
    const wait = formatRetryAfter(failure.retryAfter);
    if (wait !== null) {
      lines.push(`      Retry-After: ${wait}, no automatic retry; the status went to the caller`);
    }
  }
  return lines.join('\n');
}

/**
 * Resolve the upstream `/__pyric/ai-proxy` forwards to, and say WHERE that
 * value came from. One resolution shared by the proxy handler (which needs
 * the target) and the startup line (which needs the provenance, so a
 * developer can tell a deliberate `PYRIC_AI_PROXY_UPSTREAM` from the Ollama
 * default nobody chose).
 */
export function resolveAiProxyUpstream(
  configured: string | undefined,
): { target: string; source: 'option' | 'env' | 'default' } {
  const envUpstream = process.env.PYRIC_AI_PROXY_UPSTREAM;
  let raw = AI_PROXY_DEFAULT_UPSTREAM;
  let source: 'option' | 'env' | 'default' = 'default';
  if (configured !== undefined) {
    raw = configured;
    source = 'option';
  } else if (envUpstream !== undefined) {
    raw = envUpstream;
    source = 'env';
  }
  return { target: raw.replace(/\/$/, ''), source };
}

/**
 * The AI upstream as a network-guard allowance for the processes `pyric
 * sandbox` launches. A configured upstream is a destination the developer
 * chose, such as a Vertex AI endpoint, so the guard's default `block` mode
 * must not refuse it. The local Ollama default is loopback, which the guard
 * never flags, so it yields no allowance.
 */
export function aiUpstreamGuardAllowance(configured: string | undefined): string[] {
  const upstream = resolveAiProxyUpstream(configured);
  const isDefaultUpstream = upstream.source === 'default';
  if (isDefaultUpstream) return [];
  return [upstream.target];
}

/**
 * Permit the Vite plugin's AI destinations on this process's network guard.
 * The plugin resolves them after the guard installed, from its options or the
 * Vite env: the proxy upstream it forwards to, and an engine base URL on
 * another origin. Same-origin paths such as the AI proxy route are not
 * destinations the guard sees.
 */
export function permitAiUpstreams(ai: { proxyUpstream?: string | undefined; engineWire?: AiEngineConfigWire | undefined }): void {
  const destinations: string[] = [];
  if (ai.proxyUpstream !== undefined) destinations.push(ai.proxyUpstream);
  const engineBaseUrl = (ai.engineWire as { baseUrl?: unknown } | undefined)?.baseUrl;
  const engineOnAnotherOrigin = typeof engineBaseUrl === 'string' && /^https?:\/\//i.test(engineBaseUrl);
  if (engineOnAnotherOrigin) destinations.push(engineBaseUrl);
  for (const destination of destinations) permitGuardHost(destination);
}

/** Shared upstream I/O for the browser proxy and the direct Node engine.
 * Responses remain incremental; cancellation stops reading without a warning.
 */
export async function fetchAiUpstream(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  throttle: AiDiagnosticThrottle,
  logger?: ServeLogger,
  source = 'ai-proxy',
): Promise<Response> {
  const isRequest = input instanceof Request;
  const target = isRequest ? input.url : String(input);
  const startedAt = Date.now();
  const note = (failure: AiProxyFailure): void => noteAiProxyFailure(failure, throttle, logger, source);
  let upstream: Response;
  try {
    upstream = await fetch(input, init);
  } catch (error) {
    note({ kind: 'unreachable', target, latencyMs: Date.now() - startedAt,
      cause: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const failed = !upstream.ok;
  if (failed) {
    const retryAfter = upstream.headers.get('retry-after');
    note({ kind: 'status', target, latencyMs: Date.now() - startedAt, status: upstream.status,
      ...(retryAfter !== null ? { retryAfter } : {}) });
  }
  const body = upstream.body;
  const hasNoBody = body === null;
  if (hasNoBody) return upstream;
  const reader = body.getReader();
  let cancelled = false;
  const observedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (cancelled) return;
        note({ kind: 'stream-abort', target, latencyMs: Date.now() - startedAt,
          cause: error instanceof Error ? error.message : String(error) });
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(observedBody, {
    status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
  });
}

/**
 * Handle `POST /__pyric/ai-proxy/<suffix>`: a same-origin passthrough to the
 * configured OpenAI-compatible upstream, so the browser openai engine
 * (running in the served page or the SharedWorker host) reaches a localhost
 * upstream like Ollama with ZERO CORS setup (no `OLLAMA_ORIGINS`, ever).
 *
 * Behavior:
 *   - POST only (the OpenAI chat-completions surface is POST); 405 otherwise.
 *   - the path suffix + query ride through verbatim
 *     (`/__pyric/ai-proxy/chat/completions` becomes `<upstream>/chat/completions`).
 *   - the request body is forwarded verbatim; headers minus the
 *     origin-sensitive/hop-by-hop set above (`authorization` DOES forward,
 *     since upstreams may require a key).
 *   - the response body is STREAMED through chunk-by-chunk. SSE passthrough
 *     must never buffer, or `stream: true` completions would arrive all at
 *     once at the end.
 *   - an unreachable upstream answers 502 with a plain-text explanation.
 *   - every upstream failure (unreachable/timeout, non-2xx status, mid-stream
 *     abort) ALSO prints a structured warning on the dev server's terminal
 *     logger; a stopped Ollama used to fail in total silence. Diagnostics
 *     only: nothing here changes what the caller receives. No logger wired
 *     means dropped silently (same opt-out contract as the denial relay).
 */
export async function handleAiProxy(
  configuredUpstream: string | undefined,
  throttle: AiDiagnosticThrottle,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  logger?: ServeLogger,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed');
    return;
  }
  const upstreamBase = resolveAiProxyUpstream(configuredUpstream).target;
  const suffix = url.pathname.slice(AI_PROXY_ROUTE.length);
  const target = `${upstreamBase}${suffix}${url.search}`;

  // Buffer the REQUEST body (small JSON payloads); the RESPONSE streams.
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  // Copy into a plain-ArrayBuffer view; fetch's BodyInit typing rejects
  // Buffer's ArrayBufferLike backing.
  const body = new Uint8Array(raw.byteLength);
  body.set(raw);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (AI_PROXY_STRIPPED_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  let upstream: Response;
  try {
    upstream = await fetchAiUpstream(target, { method: 'POST', headers, body }, throttle, logger);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    // The 502 body quotes the same two strings the terminal block does, so it
    // gets the same masking: the target carries the page's own query string,
    // and a fetch error routinely echoes the URL back.
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(
      `pyric dev ai-proxy: upstream ${redactUrl(target)} unreachable: ${redactUrl(cause)}\n` +
        'Set PYRIC_AI_PROXY_UPSTREAM to an OpenAI-compatible base URL ' +
        `(default ${AI_PROXY_DEFAULT_UPSTREAM}).`,
    );
    return;
  }

  const responseHeaders: Record<string, string> = { 'cache-control': 'no-store' };
  const contentType = upstream.headers.get('content-type');
  if (contentType) responseHeaders['content-type'] = contentType;
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders?.();

  // Chunk-by-chunk passthrough. A dropped client cancels the upstream read
  // so an abandoned SSE stream doesn't keep the upstream generating.
  const reader = upstream.body.getReader();
  res.on('close', () => {
    void reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // fetchAiUpstream reports interrupted responses; the committed body is truncated.
  }
  res.end();
}
