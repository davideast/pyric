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
import { redactProxyUrl, sanitizeForTerminal } from './ai-terminal-text.js';

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
export function formatAiProxyWarning(failure: AiProxyFailure): string {
  const target = redactProxyUrl(failure.target);
  let headline: string;
  if (failure.kind === 'unreachable') {
    headline = `upstream unreachable: ${redactProxyUrl(failure.cause)}`;
  } else if (failure.kind === 'status') {
    const rateLimited = failure.status === 429;
    headline = `upstream returned ${failure.status}${rateLimited ? ' (rate limited / quota exhausted)' : ''}`;
  } else {
    headline = `upstream stream aborted mid-response: ${redactProxyUrl(failure.cause)}`;
  }
  const lines = [
    `  ⚠ [pyric] ai-proxy: ${headline}`,
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

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'POST', headers, body });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    logger?.note(
      formatAiProxyWarning({
        kind: 'unreachable',
        target,
        latencyMs: Date.now() - startedAt,
        cause,
      }),
    );
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(
      `pyric dev ai-proxy: upstream ${target} unreachable: ${cause}\n` +
        'Set PYRIC_AI_PROXY_UPSTREAM to an OpenAI-compatible base URL ' +
        `(default ${AI_PROXY_DEFAULT_UPSTREAM}).`,
    );
    return;
  }

  // A refusal from a reachable upstream (bad model, missing key, rate limit)
  // is just as invisible to a headless developer as a dead socket: the
  // status rides through to the caller untouched, and is ALSO announced here.
  // `Retry-After` rides along when the upstream sent one (429s and 503s carry
  // it): it is the only place the requested backoff appears, since nothing in
  // this path retries or sleeps.
  if (!upstream.ok) {
    const retryAfter = upstream.headers.get('retry-after');
    const failure: AiProxyFailure = {
      kind: 'status',
      target,
      latencyMs: Date.now() - startedAt,
      status: upstream.status,
    };
    if (retryAfter !== null) failure.retryAfter = retryAfter;
    logger?.note(formatAiProxyWarning(failure));
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
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
    void reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (e) {
    // Nothing to salvage for the caller: the response is already committed
    // with the upstream's status, so a truncated body is all it gets. But a
    // half-delivered completion is exactly the failure that used to vanish,
    // so announce it, unless the CLIENT is the one who walked away (a closed
    // tab cancelling an SSE stream is normal, not a fault worth a warning).
    if (!clientGone) {
      logger?.note(
        formatAiProxyWarning({
          kind: 'stream-abort',
          target,
          latencyMs: Date.now() - startedAt,
          cause: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
  res.end();
}
