/**
 * OpenRouter wire inspector — ground truth for "what is actually sent
 * to OpenRouter, and where does the latency go."
 *
 * Why this exists: the reasoning-effort path is correct on every static
 * hop (UI → store → openrouter.ts → NormalizedRequest.reasoningEffort →
 * @inbrowser/relay provider → `reasoning` wire param). When users report
 * "no matter what effort I set, it's slow," the question is no longer
 * "is the code wired right" — it's "what is empirically on the wire, and
 * what is the model actually spending time on." Reading source can't
 * answer that; only the live request can.
 *
 * Mechanism: a defensive `window.fetch` wrapper that recognises the
 * OpenRouter chat-completions endpoint, records the *literal* request
 * body (the `reasoning` param exactly as serialised), and tees the SSE
 * response stream to time first-byte, first-reasoning-delta,
 * first-content-delta, and total — plus reasoning vs content token
 * counts from the final `usage` chunk.
 *
 * Scope: this sees the page-direct (`fallback`) transport — the default.
 * In `server` mode the OpenRouter fetch runs inside the Cloud Function,
 * so the wire body lives in the function logs; the page-side provider
 * timing (logged from openrouter.ts as `openrouter_turn`) still applies.
 *
 * Output flows into the existing diagnostics ring buffer (logPage) and
 * is surfaced via `window.__pyric.printOpenRouter()`. Instrumentation
 * must never break inference — every capture path is wrapped so a parse
 * or tee failure degrades to "no data," never an exception into the
 * consumer's stream.
 */
import { logPage } from './diagnostics';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

let installed = false;

/**
 * The provider sets this immediately before it calls into the inference
 * stream so the wire event can be correlated with the same turn's
 * requested effort (logged as `openrouter_turn`). Sessions run their
 * turns sequentially, so last-writer-wins is correct for the common
 * case; concurrent fleet sessions may interleave (acceptable for a
 * debug surface — the model/effort in the wire body is still literal).
 */
let activeTurnId: string | null = null;
export function setActiveOpenRouterTurn(id: string | null): void {
  activeTurnId = id;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url ?? '';
}

function round(n: number | null): number | null {
  return n === null ? null : Math.round(n);
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  try {
    if (typeof init?.body === 'string') return init.body;
    if (input instanceof Request) return await input.clone().text();
  } catch {
    /* unreadable body — degrade to no-data */
  }
  return null;
}

/**
 * Tee target: decode the SSE stream and time the first reasoning delta
 * vs the first content delta. This is the crux — it separates "the
 * model spent N ms thinking" from "the model spent N ms producing the
 * answer" from "the connection took N ms to first byte."
 */
async function measureStream(
  stream: ReadableStream<Uint8Array>,
  turnId: string,
  t0: number,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstChunkMs: number | null = null;
  let firstReasoningMs: number | null = null;
  let firstContentMs: number | null = null;
  let reasoningChars = 0;
  let contentChars = 0;
  let finish: string | null = null;
  let usage: Record<string, unknown> | null = null;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstChunkMs === null) firstChunkMs = performance.now() - t0;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = json?.choices?.[0]?.delta;
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (reasoning) {
          if (firstReasoningMs === null) firstReasoningMs = performance.now() - t0;
          reasoningChars += String(reasoning).length;
        }
        const content = delta?.content;
        if (content) {
          if (firstContentMs === null) firstContentMs = performance.now() - t0;
          contentChars += String(content).length;
        }
        const fr = json?.choices?.[0]?.finish_reason;
        if (fr) finish = fr;
        if (json?.usage) usage = json.usage;
      }
    }
  } catch {
    /* stream aborted/torn — log whatever we have */
  }

  const totalMs = performance.now() - t0;
  const details = (usage?.completion_tokens_details ?? {}) as Record<string, unknown>;
  logPage('openrouter_wire_stream', turnId, {
    firstChunkMs: round(firstChunkMs),
    firstReasoningMs: round(firstReasoningMs),
    firstContentMs: round(firstContentMs),
    reasoningChars,
    contentChars,
    totalMs: Math.round(totalMs),
    finish,
    reasoningTokens:
      (details.reasoning_tokens as number | undefined) ??
      (usage?.reasoning_tokens as number | undefined) ??
      null,
    completionTokens: (usage?.completion_tokens as number | undefined) ?? null,
    promptTokens: (usage?.prompt_tokens as number | undefined) ?? null,
    costUsd: (usage?.cost as number | undefined) ?? null,
  });
}

export function installOpenRouterInspector(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const original = window.fetch.bind(window);

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (!url.startsWith(OPENROUTER_ENDPOINT)) {
      return original(input as any, init);
    }

    const turnId =
      activeTurnId ??
      `or_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const t0 = performance.now();

    // ── Capture the literal request body (the ground truth) ──────────
    let body: any = null;
    const raw = await readBody(input, init);
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        /* non-JSON body — leave null */
      }
    }
    logPage('openrouter_wire_request', turnId, {
      model: body?.model ?? null,
      // `reasoning` exactly as serialised onto the wire. This is the
      // single most important field: it shows whether effort=off really
      // sent { enabled: false }, or whether a non-off effort sent
      // { effort, summary }. If this disagrees with what you picked in
      // the UI, the bug is upstream of the network.
      reasoning: body?.reasoning ?? null,
      include_reasoning: body?.include_reasoning ?? null,
      stream: body?.stream ?? null,
      temperature: body?.temperature ?? null,
      toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    });

    // ── Issue the real request ───────────────────────────────────────
    let response: Response;
    try {
      response = await original(input as any, init);
    } catch (e) {
      logPage('openrouter_wire_error', turnId, {
        phase: 'fetch',
        message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    const ttfbMs = performance.now() - t0;
    logPage('openrouter_wire_response', turnId, {
      status: response.status,
      ok: response.ok,
      ttfbMs: Math.round(ttfbMs),
      requestId: response.headers.get('x-request-id'),
    });

    // ── Tee the stream so we measure without consuming the consumer's
    //    copy. Return a fresh Response over the consumer branch. ───────
    if (response.body) {
      try {
        const [forConsumer, forInspector] = response.body.tee();
        void measureStream(forInspector, turnId, t0);
        return new Response(forConsumer, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        // tee unsupported / failed — never block inference; hand back
        // the original untouched response.
        return response;
      }
    }
    return response;
  };

  window.fetch = wrapped as typeof window.fetch;

  const w = window as unknown as { __pyric?: Record<string, unknown> };
  if (!w.__pyric) w.__pyric = {};
  w.__pyric.printOpenRouter = printOpenRouter;
  w.__pyric.clearOpenRouter = clearOpenRouter;
}

// ─────────────────────────────────────────────────────────────────────
// Reporter
// ─────────────────────────────────────────────────────────────────────

const OR_EVENTS = new Set([
  'openrouter_turn',
  'openrouter_wire_request',
  'openrouter_wire_response',
  'openrouter_wire_stream',
  'openrouter_wire_error',
]);

interface OrRow {
  reqId: string;
  startTs: number;
  model: string | null;
  /** Effort the provider *requested* for this turn (from openrouter.ts). */
  requestedEffort: string | null;
  transport: string | null;
  /** The `reasoning` object literally sent on the wire. */
  wireReasoning: unknown;
  ttfbMs: number | null;
  firstReasoningMs: number | null;
  firstContentMs: number | null;
  totalMs: number | null;
  reasoningTokens: number | null;
  completionTokens: number | null;
  reasoningChars: number | null;
  contentChars: number | null;
  status: number | null;
  finish: string | null;
  error: string | null;
}

function loadOrRows(): OrRow[] {
  let entries: Array<{ ts: number; event: string; reqId?: string; meta?: Record<string, unknown> }> = [];
  try {
    const raw = window.localStorage.getItem('pyric.diagnostics.log');
    entries = raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
  const byReq = new Map<string, OrRow>();
  for (const e of entries) {
    if (!OR_EVENTS.has(e.event) || !e.reqId) continue;
    const m = e.meta ?? {};
    const row =
      byReq.get(e.reqId) ??
      ({
        reqId: e.reqId,
        startTs: e.ts,
        model: null,
        requestedEffort: null,
        transport: null,
        wireReasoning: undefined,
        ttfbMs: null,
        firstReasoningMs: null,
        firstContentMs: null,
        totalMs: null,
        reasoningTokens: null,
        completionTokens: null,
        reasoningChars: null,
        contentChars: null,
        status: null,
        finish: null,
        error: null,
      } as OrRow);
    row.startTs = Math.min(row.startTs, e.ts);
    switch (e.event) {
      case 'openrouter_turn':
        row.requestedEffort = (m.requestedEffort as string) ?? row.requestedEffort;
        row.model = (m.model as string) ?? row.model;
        row.transport = (m.transport as string) ?? row.transport;
        break;
      case 'openrouter_wire_request':
        row.model = (m.model as string) ?? row.model;
        row.wireReasoning = 'reasoning' in m ? m.reasoning : row.wireReasoning;
        break;
      case 'openrouter_wire_response':
        row.ttfbMs = (m.ttfbMs as number) ?? row.ttfbMs;
        row.status = (m.status as number) ?? row.status;
        break;
      case 'openrouter_wire_stream':
        row.firstReasoningMs = (m.firstReasoningMs as number) ?? row.firstReasoningMs;
        row.firstContentMs = (m.firstContentMs as number) ?? row.firstContentMs;
        row.totalMs = (m.totalMs as number) ?? row.totalMs;
        row.reasoningTokens = (m.reasoningTokens as number) ?? row.reasoningTokens;
        row.completionTokens = (m.completionTokens as number) ?? row.completionTokens;
        row.reasoningChars = (m.reasoningChars as number) ?? row.reasoningChars;
        row.contentChars = (m.contentChars as number) ?? row.contentChars;
        row.finish = (m.finish as string) ?? row.finish;
        break;
      case 'openrouter_wire_error':
        row.error = (m.message as string) ?? 'error';
        break;
    }
    byReq.set(e.reqId, row);
  }
  return [...byReq.values()].sort((a, b) => a.startTs - b.startTs);
}

/**
 * Heuristic anomaly detection — flag, don't diagnose. These are the
 * three questions a "slow no matter what" report comes down to.
 */
function detectAnomalies(rows: OrRow[]): string[] {
  const out: string[] = [];

  // 1) Effort requested doesn't match what's on the wire → upstream bug.
  for (const r of rows) {
    if (!r.requestedEffort || r.wireReasoning === undefined) continue;
    const wire = JSON.stringify(r.wireReasoning);
    if (r.requestedEffort === 'off' && wire !== JSON.stringify({ enabled: false })) {
      out.push(
        `req ${r.reqId}: requested effort 'off' but wire reasoning=${wire} — effort dropped between provider and wire.`,
      );
    }
    if (r.requestedEffort !== 'off' && r.wireReasoning && (r.wireReasoning as any).enabled === false) {
      out.push(
        `req ${r.reqId}: requested effort '${r.requestedEffort}' but wire disabled reasoning — effort dropped.`,
      );
    }
  }

  // 2) Reasoning was disabled but the model still emitted reasoning →
  //    OpenRouter/model ignored { enabled: false } (a real upstream bug,
  //    not ours, but the truth the user is chasing).
  for (const r of rows) {
    const disabled =
      r.wireReasoning && (r.wireReasoning as any).enabled === false;
    if (disabled && ((r.reasoningTokens ?? 0) > 0 || (r.reasoningChars ?? 0) > 0)) {
      out.push(
        `req ${r.reqId}: reasoning was disabled on the wire yet the model returned ${
          r.reasoningTokens ?? r.reasoningChars
        } reasoning ${r.reasoningTokens ? 'tokens' : 'chars'} — disable was ignored upstream.`,
      );
    }
  }

  // 3) Where did the time go? Attribute the dominant cost.
  for (const r of rows) {
    if (r.totalMs === null) continue;
    const ttfb = r.ttfbMs ?? 0;
    const reasoningSpan =
      r.firstReasoningMs !== null && r.firstContentMs !== null
        ? r.firstContentMs - r.firstReasoningMs
        : null;
    if (r.totalMs > 8000) {
      if (reasoningSpan !== null && reasoningSpan > r.totalMs * 0.5) {
        out.push(
          `req ${r.reqId}: ${r.totalMs}ms total — dominated by reasoning (~${reasoningSpan}ms before first content). Lower effort or set 'off'.`,
        );
      } else if (ttfb > r.totalMs * 0.5) {
        out.push(
          `req ${r.reqId}: ${r.totalMs}ms total — dominated by time-to-first-byte (${ttfb}ms). Network / cold start / queueing, NOT reasoning.`,
        );
      } else {
        out.push(
          `req ${r.reqId}: ${r.totalMs}ms total — spread across generation; not reasoning-bound.`,
        );
      }
    }
  }

  return out;
}

/**
 * Print a focused, per-request table of OpenRouter activity plus
 * auto-flagged anomalies. This is the surface that answers "is the
 * effort I picked actually being sent, and what is the model spending
 * time on." Call `window.__pyric.printOpenRouter()` from DevTools.
 */
export function printOpenRouter(): void {
  if (typeof console === 'undefined') return;
  const rows = loadOrRows();
  if (rows.length === 0) {
    console.info(
      '[or] no OpenRouter requests captured yet. Send a turn with the OpenRouter provider selected, then re-run __pyric.printOpenRouter().',
    );
    return;
  }
  const table = rows.map((r) => ({
    req: r.reqId.slice(0, 12),
    model: r.model,
    'effort→': r.requestedEffort,
    'wire.reasoning': JSON.stringify(r.wireReasoning ?? null),
    ttfbMs: r.ttfbMs,
    firstThinkMs: r.firstReasoningMs,
    firstTextMs: r.firstContentMs,
    totalMs: r.totalMs,
    reasonTok: r.reasoningTokens,
    outTok: r.completionTokens,
    status: r.status,
    finish: r.finish,
    error: r.error,
  }));
  console.info(`[or] ${rows.length} OpenRouter request(s) this session:`);
  // console.table renders nicely in DevTools; JSON dump is the
  // copy-paste-back fallback.
  console.table(table);
  const anomalies = detectAnomalies(rows);
  if (anomalies.length) {
    console.warn('[or] anomalies:');
    for (const a of anomalies) console.warn('  • ' + a);
  } else {
    console.info('[or] no anomalies flagged.');
  }
  console.log(JSON.stringify({ rows, anomalies }, null, 2));
}

export function clearOpenRouter(): void {
  // The OR events share the diagnostics ring buffer; clearing the whole
  // page log is the documented reset (see __pyric.clearLogs). This is a
  // no-op placeholder kept for symmetry / discoverability on __pyric.
  console.info('[or] OpenRouter events live in the diagnostics log. Use __pyric.clearLogs() to reset.');
}
