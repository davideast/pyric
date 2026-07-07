/**
 * Efficiency ledgers (EFF1) — the two append-only NDJSON stores that turn
 * "this session feels inefficient" into falsifiable numbers:
 *
 *   - request-ledger.ndjson — one row per LLM ITERATION (per `llm_request`
 *     trace event). Carries provider usage when available plus a harness-side
 *     composition estimate of the messages array: system / history /
 *     re-sent tool results / current prompt, and the H3 duplicate-prompt
 *     waste (the current user prompt appearing 2× in the message array —
 *     a known @inbrowser/agent session bug: `session.run()` appends the
 *     user msg to history AND passes `prompt`; `buildMessages` then appends
 *     `input.prompt` again).
 *
 *   - tool-ledger.ndjson — one row per tool call. argsBytes vs
 *     resultTokensEst separates "the model re-sent the whole file" (H7)
 *     from "the tool returned a fat payload" (H2). simulate tuples are
 *     hashed (method+path+auth-shape) so identical re-runs are countable (H5).
 *
 * Same store discipline as `metrics-store.ts`: append-only NDJSON, one
 * `appendFileSync` per batch, views compute, never mutate.
 *
 * Tracer-gap notes (the @inbrowser/agent fix-PR requirements list — these
 * are computed HARNESS-SIDE here because the trace events don't carry them):
 *   - `LlmResponseTrace.usage` drops `reasoningTokens` and `costUsd` even
 *     though `RawUsage` has both → `reasoning` is a chars/4 estimate of the
 *     `thinking` text (`reasoningSource: 'estimate'`).
 *   - No per-tool durations in the trace (only the per-iteration aggregate
 *     via `turn_dispatch_complete`) → `durationMs` is measured harness-side
 *     from the `tool_started`/`tool_finished` SessionEvents.
 *   - Tool-result payloads are not first-class trace events → result sizes
 *     come from `tool_finished` SessionEvents (harness) or from the next
 *     iteration's request messages (`role: 'tool'` → `resultJson`).
 *
 * The append/read halves are Node-only (fs). The row builders and the
 * tracer/recorder factories are pure and environment-agnostic.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  LlmRequestTrace,
  LlmResponseTrace,
  ModelMessage,
  TraceEvent,
} from '@inbrowser/agent';

// ── token estimation ────────────────────────────────────────────────────

/** chars/4 — the pre-registered estimator. Deliberately crude and stated
 *  everywhere it appears; ledger consumers must not mistake it for a
 *  tokenizer. */
export function estTokens(s: string | undefined | null): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

// ── row shapes ──────────────────────────────────────────────────────────

/** Where the run-level identity fields come from — lets ledger rows join
 *  back to `records.ndjson` on `runId`. */
export interface LedgerMeta {
  runId: string;
  /** Fixture id when running the eval matrix. */
  fixture?: string;
  /** Strategy arm name (react / draft-validate / routed / …). */
  strategy?: string;
  /** SF-S0a cadence tag — the strategy that actually PRODUCED the calls, so
   *  later analysis can compare draft-cadence vs react-cadence token costs.
   *  For the leaf arms (react / draft-validate) cadence == strategy. For the
   *  `routed` arm it's the dispatched cadence ('draft-validate', or 'react'
   *  when routed/escalated to react) — the harness resolves it from the
   *  router milestones AFTER the run and sets it before `rows()` is read.
   *  Per-row finer cadence isn't separately knowable from the trace stream
   *  (the ledger tracer sees only llm_request/response, not strategy events),
   *  so the run-resolved strategy name is the documented granularity.
   *  Falls back to `strategy` when unset. */
  cadence?: string;
  /** Model id label. */
  model?: string;
}

export interface RequestComposition {
  /** Token-estimate of the system message(s). */
  system: number;
  /** Everything that is not system / tool results / the current prompt:
   *  prior user+assistant text and tool-call args re-serialized into the
   *  request. Includes the H3 duplicate copy (reported separately in
   *  `duplicatePromptTokens`). */
  history: number;
  /** Token-estimate of every `role: 'tool'` message's resultJson — the
   *  dead tool results re-sent on every iteration (H1's prime suspect). */
  resentToolResults: number;
  /** Token-estimate of the LAST user message (the current prompt). */
  currentPrompt: number;
}

/** One row per LLM iteration. */
export interface RequestLedgerRow {
  runId: string;
  turnId: string;
  iteration: number;
  requestId: string;
  /** Wall-clock ms of the `llm_request` emit. */
  ts: number;
  fixture?: string;
  strategy?: string;
  /** SF-S0a: the strategy/cadence that produced this call (see
   *  `LedgerMeta.cadence`). Defaults to `strategy` when not separately set. */
  cadence?: string;
  model?: string;
  /** Provider-reported when the paired `llm_response` carried usage;
   *  chars/4 estimates otherwise. */
  tokensIn: number;
  tokensOut: number;
  cached: number;
  /** ALWAYS a chars/4 estimate of the `thinking` text — the trace's usage
   *  shape has no reasoningTokens field (tracer gap). */
  reasoning: number;
  usageSource: 'provider' | 'estimate';
  composition: RequestComposition;
  /** Σ composition — the harness-side estimate of this request's size.
   *  Compare with provider `tokensIn` to calibrate the estimator. */
  totalEstTokens: number;
  messageCount: number;
  toolResultMessageCount: number;
  /** H3: tokens of the current prompt duplicated in the message array
   *  ((occurrences − 1) × est(prompt)). Non-zero = the bug fired. */
  duplicatePromptTokens: number;
}

/** One row per tool call. */
export interface ToolLedgerRow {
  runId: string;
  turnId: string;
  /** 1-based position of this call within its turn. */
  sequenceIndex: number;
  callId: string;
  tool: string;
  fixture?: string;
  strategy?: string;
  argsBytes: number;
  argsTokensEst: number;
  resultBytes: number;
  /** chars/4 over the serialized ToolResult. */
  resultTokensEst: number;
  ok?: boolean;
  /** For file tools (args.path). */
  path?: string;
  /** For simulate_firestore_write: hash of method+path+auth-shape (H5). */
  tupleHash?: string;
  /** Harness-measured wall-clock between tool_started and tool_finished. */
  durationMs?: number;
}

// ── guards ──────────────────────────────────────────────────────────────

export function isRequestLedgerRow(x: unknown): x is RequestLedgerRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.runId === 'string' &&
    typeof r.turnId === 'string' &&
    typeof r.iteration === 'number' &&
    typeof r.tokensIn === 'number' &&
    typeof r.tokensOut === 'number' &&
    typeof r.duplicatePromptTokens === 'number' &&
    !!r.composition &&
    typeof r.composition === 'object'
  );
}

export function isToolLedgerRow(x: unknown): x is ToolLedgerRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.runId === 'string' &&
    typeof r.turnId === 'string' &&
    typeof r.sequenceIndex === 'number' &&
    typeof r.tool === 'string' &&
    typeof r.argsBytes === 'number' &&
    typeof r.resultTokensEst === 'number'
  );
}

// ── request-row builder (pure) ──────────────────────────────────────────

function messageEstTokens(m: ModelMessage): number {
  let t = estTokens(m.text);
  if (m.toolCalls && m.toolCalls.length > 0) {
    t += estTokens(safeStringify(m.toolCalls));
  }
  if (m.resultJson !== undefined) t += estTokens(m.resultJson);
  return t;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Build one ledger row from a request trace and its (optional) paired
 * response. Pure — no I/O, no clock.
 */
export function buildRequestRow(
  meta: LedgerMeta,
  req: LlmRequestTrace,
  res?: LlmResponseTrace,
): RequestLedgerRow {
  let system = 0;
  let resentToolResults = 0;
  let toolResultMessageCount = 0;
  let total = 0;
  const userMessages: ModelMessage[] = [];
  for (const m of req.messages) {
    const t = messageEstTokens(m);
    total += t;
    if (m.role === 'system') system += t;
    else if (m.role === 'tool') {
      resentToolResults += t;
      toolResultMessageCount += 1;
    } else if (m.role === 'user') userMessages.push(m);
  }
  const lastUser = userMessages[userMessages.length - 1];
  const currentPrompt = lastUser ? estTokens(lastUser.text) : 0;
  // H3: the current prompt appearing more than once among user messages.
  let duplicatePromptTokens = 0;
  if (lastUser) {
    const occurrences = userMessages.filter((m) => m.text === lastUser.text).length;
    if (occurrences > 1) duplicatePromptTokens = (occurrences - 1) * currentPrompt;
  }
  const history = Math.max(0, total - system - resentToolResults - currentPrompt);

  const usage = res?.usage;
  const tokensIn = usage ? usage.promptTokens : total;
  const tokensOut = usage
    ? usage.outputTokens
    : estTokens(res?.text) + estTokens(res?.thinking);
  return {
    runId: meta.runId,
    turnId: req.turnId,
    iteration: req.iteration,
    requestId: req.requestId,
    ts: req.ts,
    ...(meta.fixture ? { fixture: meta.fixture } : {}),
    ...(meta.strategy ? { strategy: meta.strategy } : {}),
    // SF-S0a cadence tag — resolved cadence if the harness set one, else the
    // strategy name (cadence == strategy for the leaf arms).
    ...(meta.cadence ?? meta.strategy ? { cadence: meta.cadence ?? meta.strategy } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    tokensIn,
    tokensOut,
    cached: usage?.cachedTokens ?? 0,
    reasoning: estTokens(res?.thinking),
    usageSource: usage ? 'provider' : 'estimate',
    composition: { system, history, resentToolResults, currentPrompt },
    totalEstTokens: total,
    messageCount: req.messages.length,
    toolResultMessageCount,
    duplicatePromptTokens,
  };
}

// ── ledger tracer (request side) ────────────────────────────────────────

export interface LedgerTracer {
  /** Pass as `tracer` to `createAgentSession`. Synchronous, non-throwing. */
  emit(event: TraceEvent): void;
  /** Finalized rows — pairs each request with its response when one
   *  arrived; unpaired requests (mid-stream error) become estimate rows. */
  rows(): RequestLedgerRow[];
}

/**
 * A `Tracer` that accumulates request-ledger rows in memory. The caller
 * flushes `rows()` to disk with `appendRequestRows` at end of run — ONE
 * append per run, same discipline as `appendRecords`.
 */
export function createLedgerTracer(meta: LedgerMeta): LedgerTracer {
  const requests: LlmRequestTrace[] = [];
  const responses = new Map<string, LlmResponseTrace>();
  return {
    emit(event: TraceEvent): void {
      try {
        if (event.kind === 'llm_request') requests.push(event.data);
        else if (event.kind === 'llm_response') responses.set(event.data.requestId, event.data);
        // turn_dispatch_complete carries only the aggregate dispatch
        // timestamp; per-tool timing comes from the SessionEvent recorder.
      } catch {
        /* a tracer must never fail the dispatch */
      }
    },
    rows(): RequestLedgerRow[] {
      return requests.map((req) => buildRequestRow(meta, req, responses.get(req.requestId)));
    },
  };
}

// ── tool-call recorder (SessionEvent side) ──────────────────────────────

/** Structural subset of the `tool_started` SessionEvent. */
export interface ToolStartedLike {
  turnId: string;
  callId: string;
  name: string;
  args: unknown;
}
/** Structural subset of the `tool_finished` SessionEvent. */
export interface ToolFinishedLike {
  turnId: string;
  callId: string;
  result: unknown;
}

export interface ToolLedgerRecorder {
  onToolStarted(ev: ToolStartedLike, nowMs?: number): void;
  onToolFinished(ev: ToolFinishedLike, nowMs?: number): void;
  rows(): ToolLedgerRow[];
}

/** Stable stringify (sorted keys) so auth shapes hash identically
 *  regardless of key order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit, hex — tiny, dependency-free, plenty for tuple identity. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** H5 tuple identity for a simulate call: method + path + auth shape.
 *  `rules`/`data`/`resource` are deliberately EXCLUDED — re-running the
 *  same (method, path, auth) against the same deployed ruleset is the
 *  redundancy under test. Returns undefined for non-simulate tools. */
export function simulateTupleHash(tool: string, args: unknown): string | undefined {
  if (tool !== 'simulate_firestore_write') return undefined;
  const a = (args ?? {}) as { method?: unknown; path?: unknown; auth?: unknown };
  return fnv1a(
    stableStringify({ method: a.method ?? null, path: a.path ?? null, auth: a.auth ?? null }),
  );
}

export function createToolLedgerRecorder(meta: LedgerMeta): ToolLedgerRecorder {
  const rows: ToolLedgerRow[] = [];
  const started = new Map<string, { row: ToolLedgerRow; t0: number }>();
  const perTurnSeq = new Map<string, number>();
  return {
    onToolStarted(ev, nowMs = Date.now()): void {
      const seq = (perTurnSeq.get(ev.turnId) ?? 0) + 1;
      perTurnSeq.set(ev.turnId, seq);
      const argsJson = safeStringify(ev.args);
      const path = (ev.args as { path?: unknown } | null)?.path;
      const tupleHash = simulateTupleHash(ev.name, ev.args);
      const row: ToolLedgerRow = {
        runId: meta.runId,
        turnId: ev.turnId,
        sequenceIndex: seq,
        callId: ev.callId,
        tool: ev.name,
        ...(meta.fixture ? { fixture: meta.fixture } : {}),
        ...(meta.strategy ? { strategy: meta.strategy } : {}),
        argsBytes: argsJson.length,
        argsTokensEst: estTokens(argsJson),
        resultBytes: 0,
        resultTokensEst: 0,
        ...(typeof path === 'string' ? { path } : {}),
        ...(tupleHash ? { tupleHash } : {}),
      };
      rows.push(row);
      started.set(ev.callId, { row, t0: nowMs });
    },
    onToolFinished(ev, nowMs = Date.now()): void {
      const entry = started.get(ev.callId);
      if (!entry) return;
      const resultJson = safeStringify(ev.result);
      entry.row.resultBytes = resultJson.length;
      entry.row.resultTokensEst = estTokens(resultJson);
      const ok = (ev.result as { ok?: unknown } | null)?.ok;
      if (typeof ok === 'boolean') entry.row.ok = ok;
      entry.row.durationMs = Math.max(0, Math.round(nowMs - entry.t0));
      started.delete(ev.callId);
    },
    rows(): ToolLedgerRow[] {
      return rows.slice();
    },
  };
}

// ── NDJSON stores (Node-only) ───────────────────────────────────────────

const HERE = dirname(new URL(import.meta.url).pathname);
const METRICS_DIR = resolve(HERE, '..', '..', '..', 'scripts', 'evals', 'metrics');
export const DEFAULT_REQUEST_LEDGER = resolve(METRICS_DIR, 'request-ledger.ndjson');
export const DEFAULT_TOOL_LEDGER = resolve(METRICS_DIR, 'tool-ledger.ndjson');

function appendNdjson(rows: unknown[], file: string): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

export function appendRequestRows(rows: RequestLedgerRow[], file: string = DEFAULT_REQUEST_LEDGER): void {
  for (const r of rows) {
    if (!isRequestLedgerRow(r)) throw new Error(`appendRequestRows: malformed row (runId=${(r as { runId?: string })?.runId})`);
  }
  appendNdjson(rows, file);
}

export function appendToolRows(rows: ToolLedgerRow[], file: string = DEFAULT_TOOL_LEDGER): void {
  for (const r of rows) {
    if (!isToolLedgerRow(r)) throw new Error(`appendToolRows: malformed row (runId=${(r as { runId?: string })?.runId})`);
  }
  appendNdjson(rows, file);
}

function readNdjson<T>(file: string, guard: (x: unknown) => x is T): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (guard(obj)) out.push(obj);
    } catch {
      /* skip malformed line — the store must survive a partial write */
    }
  }
  return out;
}

export function readRequestRows(file: string = DEFAULT_REQUEST_LEDGER): RequestLedgerRow[] {
  return readNdjson(file, isRequestLedgerRow);
}

export function readToolRows(file: string = DEFAULT_TOOL_LEDGER): ToolLedgerRow[] {
  return readNdjson(file, isToolLedgerRow);
}
