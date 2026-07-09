/**
 * Public entry point for the inference layer.
 *
 * Dispatches per-call to one of two transports — `server` (resumable
 * relay; the DEFAULT for cloud providers because
 * a page-direct fetch structurally cannot survive a backgrounded
 * mobile tab) or `fallback` (page-direct; local providers, and the
 * automatic degradation when the server route is unavailable). Both share the
 * same `NormalizedRequest` / `InferenceEvent` types from
 * `@inbrowser/relay`; the agent loop's callers (CallbackProvider
 * wrappers in ../{gemini,openrouter}.ts) don't know which transport
 * is live.
 *
 * `server` mode hits the deployed Cloud Function at its raw Cloud Run
 * URL — the deploy writes that URL to `/inference-endpoint.json`. The
 * Hosting rewrite path is intentionally bypassed: Firebase Hosting
 * buffers SSE end-to-end. Locally, `/inference-endpoint.json` is
 * absent and same-origin `/api/...` hits the Astro endpoints.
 *
 * The architecture this replaces — service worker + Background Fetch —
 * is documented in plans/sw-inference-backgrounding-recovery.md.
 */
import type {
  NormalizedRequest as RelayNormalizedRequest,
  ModelEvent as RelayModelEvent,
  ModelMessage,
  ToolSpec,
} from '@inbrowser/relay';
import type { ProviderChatMessage, ProviderToolDecl } from '@inbrowser/agent';
// In-repo page-direct providers — NOT the relay's. Published
// `@inbrowser/relay@0.4.0` moved its cloud providers into
// `@inbrowser/model` as `ModelClient` factories (a different event
// shape, nested usage) which the playground doesn't depend on, so the
// page-direct gemini/ollama/openrouter providers live in-repo and emit
// the playground's flat `InferenceEvent`. server/relay.ts plugs the
// openrouter one into the `server` transport too.
import { geminiProvider } from './gemini-page';
import { openrouterPageProvider, type PageInferenceEvent } from './openrouter-page';
import { ollamaProvider } from './ollama-page';
import { createResumableClient, installBrowserLifecycle } from '@inbrowser/relay';
import { useSettingsStore } from '~/lib/store/settings';
import { useLlmStore } from '~/lib/store/llm';
import { logPage } from './diagnostics';
import { IS_STATIC_PLAYGROUND_BUILD } from '~/lib/build-env';

// Re-export the wire types so existing consumers' imports keep working.
// `InferenceEvent` is the page-provider union — the flat page-direct
// shape plus the extended usage event (cached + reasoning token
// telemetry).
export type NormalizedRequest = RelayNormalizedRequest;
export type InferenceEvent = PageInferenceEvent;
export type InferenceMode = 'fallback' | 'server';

/**
 * Convert the `@inbrowser/agent` `CallbackProvider` message shape
 * (`ProviderChatMessage`, tool-call correlation field `callId`) into the
 * unified-contract `ModelMessage` (`id` / `toolCallId`) that
 * `NormalizedRequest.messages` now requires. The `CallbackProvider`
 * wrappers (`~/lib/llm/{gemini,ollama,llama-server,openrouter}.ts`)
 * call this when building their request.
 */
export function toModelMessages(messages: ProviderChatMessage[]): ModelMessage[] {
  return messages.map((m) => {
    const out: ModelMessage = { role: m.role };
    if (m.text !== undefined) out.text = m.text;
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.toolCalls = m.toolCalls.map((c) => ({
        id: c.callId,
        name: c.name,
        args: c.args,
        ...(c.signature ? { signature: c.signature } : {}),
      }));
    }
    if (m.callId !== undefined) out.toolCallId = m.callId;
    if (m.name !== undefined) out.name = m.name;
    if (m.resultJson !== undefined) out.resultJson = m.resultJson;
    return out;
  });
}

/**
 * Convert the `CallbackProvider` flat tool-declaration shape
 * (`ProviderToolDecl`: `{ name, description, parameters }`) into the
 * unified-contract nested `ToolSpec` (`{ type:'function', function:{…} }`)
 * that `NormalizedRequest.tools` now requires.
 */
export function toToolSpecs(tools: ProviderToolDecl[]): ToolSpec[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface InferenceClient {
  stream(req: NormalizedRequest): AsyncIterable<InferenceEvent>;
}

const JOB_PATH_SUFFIX = '/api/inference/job';

/** Shared-secret token for the deployed inference function's auth gate
 *  (#766). Injected at build time from `PUBLIC_INFERENCE_ACCESS_TOKEN`;
 *  empty when unconfigured (dev / same-origin Astro routes need no token,
 *  and the function's gate only enforces it when the server-side
 *  `INFERENCE_ACCESS_TOKEN` is set). A browser-shipped token is not a
 *  true secret — it raises the bar; the durable fix is App Check (#761). */
const INFERENCE_ACCESS_TOKEN: string =
  (import.meta.env.PUBLIC_INFERENCE_ACCESS_TOKEN as string | undefined)?.trim() ?? '';

/** Auth headers for a request to the inference function. Empty when no
 *  token is configured. Exported for ./reattach.ts (its raw stream fetch
 *  must carry the same auth). */
export function inferenceAuthHeaders(): Record<string, string> {
  return INFERENCE_ACCESS_TOKEN
    ? { Authorization: `Bearer ${INFERENCE_ACCESS_TOKEN}` }
    : {};
}

/** `fetch` wrapper that adds the inference auth header. Passed to the
 *  resumable client as its `fetchImpl` so both the start POST and every
 *  stream reconnect carry the token. Cast to `typeof fetch` through
 *  `unknown` because Bun's `typeof fetch` also carries a static
 *  `preconnect` a plain arrow doesn't (the wrapper never uses it). */
const fetchWithInferenceAuth = ((input: RequestInfo | URL, init?: RequestInit) => {
  const extra = inferenceAuthHeaders();
  if (Object.keys(extra).length === 0) return fetch(input, init);
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return fetch(input, { ...init, headers });
}) as unknown as typeof fetch;

let apiBasePromise: Promise<string> | null = null;
function resolveApiBase(): Promise<string> {
  if (apiBasePromise) return apiBasePromise;
  // The composed static site has no server route: `/inference-endpoint.json`
  // would resolve through the SPA rewrite to the HTML shell. Skip the probe
  // entirely — inference is page-direct BYOK there (see selectMode).
  if (IS_STATIC_PLAYGROUND_BUILD) {
    apiBasePromise = Promise.resolve('');
    return apiBasePromise;
  }
  apiBasePromise = (async () => {
    try {
      const res = await fetch('/inference-endpoint.json', { cache: 'no-store' });
      if (!res.ok) return '';
      const data = (await res.json()) as { url?: unknown };
      return typeof data.url === 'string' ? data.url.replace(/\/+$/, '') : '';
    } catch {
      return '';
    }
  })();
  return apiBasePromise;
}

let publicClient: InferenceClient | null = null;
let fallbackInner: InferenceClient | null = null;
/** One server client per base URL — '' (same-origin: Astro routes)
 *  and the published Cloud Run URL coexist. */
const serverClients = new Map<string, InferenceClient>();

export function createInference(): InferenceClient {
  if (publicClient) return publicClient;
  publicClient = {
    stream(req: NormalizedRequest): AsyncIterable<InferenceEvent> {
      return dispatch(req);
    },
  };
  return publicClient;
}

/** Providers the resumable server relay can run OFF the page. The relay
 *  registers gemini/openrouter/ollama, but ollama (and llamaServer)
 *  talk to the user's OWN machine — the deployed Cloud Function can't
 *  reach them — so only the cloud-API providers route to `server`.
 *  server transport. */
export const SERVER_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set([
  'gemini',
  'openrouter',
]);

/** Cooldown set ONLY when the server route provably doesn't exist
 *  (job start rejected 404/405 — a static host or relay-less server).
 *  Requests inside the window go page-direct without re-probing; after
 *  it expires the server path is tried again (a deploy or dev-server
 *  restart recovers on its own). Network-shaped failures NEVER set
 *  this: on flaky mobile links they're transient by nature, and a
 *  page-lifetime latch turned one blip into a permanently
 *  non-resumable session (the diagnosed 'Failed to fetch' turn death). */
let serverRouteMissingUntil = 0;
const SERVER_ROUTE_MISSING_COOLDOWN_MS = 60_000;

/** Start-POST retry budget per request. The resumable client already
 *  reconnects the STREAM (up to 300×) but never retries the START — on
 *  a 70-iteration turn that's 70 chances for a transient drop to land
 *  on a request boundary and kill the turn. */
const SERVER_START_ATTEMPTS = 3;
const SERVER_START_RETRY_DELAY_MS = 1500;

/** Transport-shaped error BEFORE any event: the relay labels its own
 *  transport failures `relay …`; a dead start fetch surfaces the
 *  browser's network wording. A provider error (e.g. bad API key)
 *  arriving as the first JOB event is neither and passes through. */
function isTransportError(msg: string): boolean {
  return /^relay |failed to fetch|networkerror|load failed|err_/i.test(msg);
}

/** Proof the server route doesn't exist (vs. a transient failure):
 *  the start endpoint itself answered 404/405. */
function isRouteMissing(msg: string): boolean {
  return /^relay start (404|405)\b/.test(msg);
}

function selectMode(provider: string): InferenceMode {
  // Static site: no server relay exists. Always page-direct (BYOK), regardless
  // of any persisted `resumableServerMode` — the toggle is hidden there too.
  if (IS_STATIC_PLAYGROUND_BUILD) return 'fallback';
  if (
    typeof window !== 'undefined' &&
    Date.now() >= serverRouteMissingUntil &&
    SERVER_CAPABLE_PROVIDERS.has(provider) &&
    useSettingsStore.getState().resumableServerMode
  ) {
    return 'server';
  }
  return 'fallback';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* dispatch(req: NormalizedRequest): AsyncGenerator<InferenceEvent> {
  const mode = selectMode(req.provider);
  // Logged via logPage only; the on-page Diagnostics panel is the
  // inspection surface. No console mirror — see diagnostics.ts.
  logPage('dispatch_route', undefined, {
    mode,
    provider: req.provider,
    model: req.model,
  });

  if (mode === 'server') {
    const base = await resolveApiBase();
    let server = serverClients.get(base);
    if (!server) {
      server = createServerClient(base);
      serverClients.set(base, server);
    }
    const signal = (req as { signal?: AbortSignal }).signal;
    // Graceful degradation, in order: retry a transiently-failed job
    // START a few times (network-shaped errors before any event), then
    // fall through to page-direct for THIS request only. Server mode is
    // a default, not a requirement — but a transient failure must never
    // downgrade the whole page.
    for (let attempt = 1; attempt <= SERVER_START_ATTEMPTS; attempt++) {
      let sawEvent = false;
      let transportMsg: string | null = null;
      for await (const ev of server.stream(req)) {
        if (!sawEvent && ev.kind === 'error' && isTransportError(ev.message)) {
          transportMsg = ev.message;
          break;
        }
        sawEvent = true;
        yield ev;
      }
      // Stream delivered events (mid-stream drops are the resumable
      // client's job) or ended cleanly — done either way.
      if (transportMsg === null) return;
      if (isRouteMissing(transportMsg)) {
        serverRouteMissingUntil = Date.now() + SERVER_ROUTE_MISSING_COOLDOWN_MS;
        logPage('server_route_missing', undefined, {
          provider: req.provider,
          message: transportMsg,
          cooldownMs: SERVER_ROUTE_MISSING_COOLDOWN_MS,
        });
        break; // no server route — page-direct now
      }
      if (attempt < SERVER_START_ATTEMPTS) {
        logPage('server_start_retry', undefined, {
          provider: req.provider,
          attempt,
          message: transportMsg,
        });
        await delay(SERVER_START_RETRY_DELAY_MS);
        if (signal?.aborted) return;
      } else {
        logPage('server_start_fallback', undefined, {
          provider: req.provider,
          message: transportMsg,
        });
      }
    }
  }

  const inner = (fallbackInner ??= createFallbackClient());
  yield* inner.stream(req);
}

/** Page-direct transport — calls the provider straight from the
 *  browser. The default; simple, needs no server. Its one limitation
 *  is the one the `server` transport exists to address — a
 *  page-direct fetch dies when the tab is backgrounded on mobile. */
function createFallbackClient(): InferenceClient {
  return {
    async *stream(req: NormalizedRequest): AsyncIterable<InferenceEvent> {
      switch (req.provider) {
        case 'gemini': {
          for await (const evt of geminiProvider(req)) yield evt;
          return;
        }
        case 'openrouter': {
          for await (const evt of openrouterPageProvider(req)) yield evt;
          return;
        }
        case 'ollama': {
          for await (const evt of ollamaProvider(req)) yield evt;
          return;
        }
        case 'llamaServer': {
          // llama.cpp's llama-server is OpenAI-compatible (/v1/chat/completions
          // with the base URL passed via apiKey), the same wire the relay's
          // ollama transport speaks, so reuse it. The provider distinction
          // (URL, models, label) lives at the registry/store level.
          for await (const evt of ollamaProvider(req)) yield evt;
          return;
        }
        default: {
          yield {
            kind: 'error',
            message: `unknown provider: ${req.provider}`,
          };
        }
      }
    },
  };
}

// ── Server-job progress (reattach support) ──────────────────────────
// While a server-mode request streams, the host can observe its durable
// job coordinates ({ jobId, seq }) and persist them (the session-host
// stamps them on the streaming assistant message). After a page reload /
// tab discard mid-turn, `recoverInterruptedJob` (./reattach.ts) uses the
// persisted coordinates to tail the job's remaining events from the
// durable log. `null` = the request finished (or none is in flight).

export interface ServerJobProgress {
  jobId: string;
  /** Events received so far — the durable log's resume offset. */
  seq: number;
  /** Provider that ran the job. */
  provider: string;
}

let jobProgressListener: ((progress: ServerJobProgress | null) => void) | null = null;

/** Register the single job-progress observer (the session host). */
export function setServerJobProgressListener(
  cb: ((progress: ServerJobProgress | null) => void) | null,
): void {
  jobProgressListener = cb;
}

/** Stream URL for a job — shared with ./reattach.ts. */
export function jobStreamUrl(base: string, jobId: string, from: number): string {
  return `${base}${JOB_PATH_SUFFIX}/${encodeURIComponent(jobId)}/stream?from=${from}`;
}

export { resolveApiBase };

/** Resumable server-stream transport — POSTs to the relay, then tails
 *  with reconnect-and-replay. Survives tab backgrounding because the
 *  producer runs server-side and writes to a durable log; the page
 *  reconnects from its last-seen seq. */
function createServerClient(base: string): InferenceClient {
  // jobId for the CURRENT streaming request — captured via the streamUrl
  // callback (the client calls it on every connect/reconnect). One
  // request streams at a time per page, matching the agent loop.
  let currentJobId: string | null = null;
  const resumable = createResumableClient({
    startUrl: `${base}${JOB_PATH_SUFFIX}`,
    // Carry the inference auth token on the start POST + every stream
    // reconnect (#766). No-op when unconfigured / same-origin.
    fetchImpl: fetchWithInferenceAuth,
    streamUrl: (jobId, from) => {
      currentJobId = jobId;
      return jobStreamUrl(base, jobId, from);
    },
    installLifecycle: installBrowserLifecycle(),
    onReconnect: (info) =>
      logPage('server_reconnect', undefined, {
        attempt: info.attempt,
        received: info.received,
        reason: info.reason,
      }),
  });
  // The resumable client speaks `@inbrowser/relay`'s `ModelEvent` (the
  // 0.4.0 unified contract: `text:`/`thinking:` carry `text`, usage is a
  // nested object). Adapt it to the playground's flat `InferenceEvent` so
  // both transports present the identical event surface to callers.
  return {
    async *stream(req: NormalizedRequest): AsyncIterable<InferenceEvent> {
      currentJobId = null;
      let seq = 0;
      try {
        for await (const ev of resumable.stream(req)) {
          seq++;
          if (currentJobId) {
            jobProgressListener?.({ jobId: currentJobId, seq, provider: req.provider });
          }
          yield modelEventToInferenceEvent(ev);
        }
      } finally {
        // Request over (done, errored, or aborted) — nothing to reattach.
        jobProgressListener?.(null);
      }
    },
  };
}

/** Map a relay `ModelEvent` (0.4.0 unified contract) onto the
 *  playground's flat `InferenceEvent`. Exported for ./reattach.ts,
 *  which tails a job's raw SSE frames after a reload. */
export function modelEventToInferenceEvent(ev: RelayModelEvent): InferenceEvent {
  switch (ev.kind) {
    case 'text':
      return { kind: 'text', chunk: ev.text };
    case 'thinking':
      return { kind: 'thinking', chunk: ev.text };
    case 'tool_call':
      return {
        kind: 'tool_call',
        callId: ev.id,
        name: ev.name,
        args: ev.args,
        ...(ev.signature ? { signature: ev.signature } : {}),
      };
    case 'usage':
      return {
        kind: 'usage',
        promptTokens: ev.usage.promptTokens,
        outputTokens: ev.usage.outputTokens,
        ...(typeof ev.usage.cachedTokens === 'number' ? { cachedTokens: ev.usage.cachedTokens } : {}),
        ...(typeof ev.usage.costUsd === 'number' ? { costUsd: ev.usage.costUsd } : {}),
      };
    case 'error':
      return { kind: 'error', message: ev.message };
  }
}

function installObservability(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __pyric?: Record<string, unknown> };
  if (!w.__pyric) w.__pyric = {};
  Object.defineProperty(w.__pyric, 'inferenceMode', {
    // Mode for the ACTIVE provider — reflects the per-provider routing.
    get: () => selectMode(useLlmStore.getState().providerId),
    configurable: true,
  });
}

// Install at module load (window-guarded) so `__pyric.inferenceMode` is
// inspectable before the first turn runs — not only after
// `createInference()` is first called.
installObservability();
