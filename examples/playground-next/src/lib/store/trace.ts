/**
 * Per-turn LLM-trace store.
 *
 * Holds the captured request/response trace for every turn the agent
 * runs this session. The host's Tracer impl in `lib/session-host`
 * pushes events here; `ActivityTab`'s drill-in reads from here when
 * the user clicks a turn's "🔎 trace" chip.
 *
 * ── Memory architecture (perf: growing stalls + renderer OOM) ──────
 * A turn can run 20+ ReAct iterations, and every iteration's request
 * repeats the same system prompt + tool schemas and re-carries the
 * accumulated messages array — measured ~1.3 MB per turn stored
 * verbatim. Two structural fixes live here:
 *
 *  1. CONTENT INTERNING (lossless dedupe). System prompts, tool-schema
 *     arrays, and individual messages are interned by content: equal
 *     content is stored once and shared by reference across requests
 *     (and across turns). If content ever differs it gets its own
 *     entry — provably lossless. The persisted format (v2) stores the
 *     content table once plus per-request refs, so session autosave
 *     stops re-serializing megabytes of duplicates.
 *
 *  2. SUMMARIES REACTIVE, PAYLOADS ASIDE. The zustand store holds only
 *     light per-turn summaries (counts + hostCtx) — what list chips
 *     and counters render. Full payloads live in a module-level map,
 *     read on demand via `getTurnTrace`/`getAllTurnTraces` (drill-in,
 *     context-window snapshot, telemetry export). React state never
 *     carries megabytes, and store updates never copy request arrays.
 *
 * Durability is unchanged: `snapshot()`/`hydrate()` flow through the
 * existing session-save path (IndexedDB) — now in the deduped v2 form.
 * Legacy v1 snapshots hydrate losslessly (interned on load).
 *
 * Kept SEPARATE from `useChatStore` because traces are a UI affordance
 * — they aren't part of the model's conversation history.
 */
import { create } from 'zustand';
import type { LlmRequestTrace, LlmResponseTrace } from '@inbrowser/agent';

/** How the running strategy was selected (SF-S0a provenance):
 *   - `user-selected` — the user pinned it via `strategyMode`
 *     (the router reports `source:'override'`).
 *   - `routed` — the heuristic router chose it under `strategyMode:'auto'`
 *     (router `source:'heuristic'`).
 *   - `escalated` — draft-validate exhausted its repairs and the router's
 *     bounded one-per-prompt escalation re-ran the turn under ReAct.
 */
export type StrategySource = 'user-selected' | 'routed' | 'escalated';

/** SF-S0a: resolved strategy provenance for one turn — strategy + why. */
export interface StrategyProvenance {
  strategy: string;
  strategySource: StrategySource;
  reason?: string;
}

/** Host-side context captured AT EMIT TIME — provider/model labels
 *  and settings toggles the agent loop doesn't know about. */
export interface HostCtx {
  providerId: string;
  providerLabel: string;
  modelLabel: string;
  diagnosticsEnabled: boolean;
  resumableServerMode: boolean;
  strategy?: string;
  strategySource?: StrategySource;
  routerReason?: string;
}

export interface TurnTrace {
  turnId: string;
  /** Indexed by `LlmRequestTrace.iteration`. */
  requests: LlmRequestTrace[];
  /** Same indexing as `requests`; sparse until Phase 2 wires the
   *  response emit on the strategy side. */
  responses: LlmResponseTrace[];
  /** Captured once when the first request for this turn lands. */
  hostCtx: HostCtx;
}

/** Light per-turn summary — the ONLY trace data held in React state. */
export interface TurnTraceSummary {
  turnId: string;
  hostCtx: HostCtx;
  requestCount: number;
  responseCount: number;
}

export interface TraceSnapshotSummary {
  turnsWithTraces: number;
  requestCount: number;
  responseCount: number;
}

/** Persisted v2 request: payload parts replaced by content-table refs. */
interface PersistedRequestV2 {
  systemPromptRef: number;
  toolsRef: number;
  messageRefs: number[];
  /** All non-payload LlmRequestTrace fields (requestId, turnId,
   *  iteration, ts, llm, …) carried verbatim. */
  [key: string]: unknown;
}

interface PersistedTurnTraceV2 {
  turnId: string;
  hostCtx: HostCtx;
  requests: PersistedRequestV2[];
  responses: LlmResponseTrace[];
}

/** Deduped persisted form: one content table + per-request refs. */
export interface PersistedTraceTelemetry {
  version: 2;
  /** Content table: ref id → JSON-encoded value (system prompt string,
   *  tools array, or a single message). Shared across all requests. */
  content: Record<string, string>;
  tracesByTurn: Record<string, PersistedTurnTraceV2>;
  capturedAt: number;
  summary: TraceSnapshotSummary;
}

/** Legacy v1 persisted form (full traces inline) — accepted on hydrate
 *  so sessions saved before the dedupe keep their traces. */
export interface PersistedTraceTelemetryV1 {
  version: 1;
  tracesByTurn: Record<string, TurnTrace>;
  capturedAt: number;
  summary: TraceSnapshotSummary;
}

// ─── Content interning (module-level, non-reactive) ─────────────────

let nextContentId = 1;
/** system-prompt string → canonical entry (key equality = content equality). */
let stringCanon = new Map<string, { id: number; value: string }>();
/** JSON-encoded object → canonical entry (tools arrays, messages). */
let objectCanon = new Map<string, { id: number; value: unknown }>();
/** Canonical object instance → its ref id (O(1) re-lookup on append/snapshot). */
let objectIds = new WeakMap<object, number>();
/** ref id → JSON-encoded value, cached at intern time so snapshot() never
 *  re-serializes payload content. */
let contentJsonById = new Map<number, string>();

/** Refs for each stored request, keyed by the stored request instance. */
let requestRefs = new WeakMap<
  LlmRequestTrace,
  { systemPromptRef: number; toolsRef: number; messageRefs: number[] }
>();

/** Full traces, interned instances. NOT in React state — read on demand. */
let payloadByTurn = new Map<string, TurnTrace>();

function internString(s: string): { id: number; value: string } {
  let entry = stringCanon.get(s);
  if (!entry) {
    entry = { id: nextContentId++, value: s };
    stringCanon.set(s, entry);
    contentJsonById.set(entry.id, JSON.stringify(s));
  }
  return entry;
}

function internObject<T>(obj: T): { id: number; value: T } {
  if (obj !== null && typeof obj === 'object') {
    const known = objectIds.get(obj as object);
    if (known !== undefined) return { id: known, value: obj };
  }
  let json: string;
  try {
    json = JSON.stringify(obj) ?? 'null';
  } catch {
    // Unserializable payload — keep the live instance (drill-in still
    // works this session) under a placeholder that hydrates to null.
    json = 'null';
  }
  let entry = objectCanon.get(json);
  if (!entry) {
    entry = { id: nextContentId++, value: obj };
    objectCanon.set(json, entry);
    contentJsonById.set(entry.id, json);
  }
  if (entry.value !== null && typeof entry.value === 'object') {
    objectIds.set(entry.value as object, entry.id);
  }
  return entry as { id: number; value: T };
}

/** Intern a request's payload parts; returns the deduped request (shared
 *  instances for repeated content) and records its refs for snapshot(). */
function internRequest(req: LlmRequestTrace): LlmRequestTrace {
  const sys = internString(req.systemPrompt);
  const tools = internObject(req.tools);
  const msgs = req.messages.map((m) => internObject(m));
  const interned: LlmRequestTrace = {
    ...req,
    systemPrompt: sys.value,
    tools: tools.value,
    messages: msgs.map((m) => m.value),
  };
  requestRefs.set(interned, {
    systemPromptRef: sys.id,
    toolsRef: tools.id,
    messageRefs: msgs.map((m) => m.id),
  });
  return interned;
}

function resetPayloadStore(): void {
  nextContentId = 1;
  stringCanon = new Map();
  objectCanon = new Map();
  objectIds = new WeakMap();
  contentJsonById = new Map();
  requestRefs = new WeakMap();
  payloadByTurn = new Map();
}

/** Full trace for one turn (drill-in). Undefined when none captured. */
export function getTurnTrace(turnId: string): TurnTrace | undefined {
  return payloadByTurn.get(turnId);
}

/** Full traces for every turn (context-window snapshot, telemetry export).
 *  Builds a fresh Record per call; the underlying TurnTrace objects are the
 *  live interned instances. Re-run when `summaries` changes. */
export function getAllTurnTraces(): Record<string, TurnTrace> {
  const out: Record<string, TurnTrace> = {};
  for (const [turnId, trace] of payloadByTurn) out[turnId] = trace;
  return out;
}

// ─── Reactive store (summaries only) ─────────────────────────────────

interface TraceState {
  /** Light per-turn summaries — safe to subscribe to from lists/chips.
   *  Object identity changes on every trace append; use it as the
   *  re-read signal for `getTurnTrace`/`getAllTurnTraces`. */
  summaries: Record<string, TurnTraceSummary>;
  /** SF-S0a: provenance that arrived before the turn's first `llm_request`,
   *  held until `appendRequest` creates the turn entry. */
  pendingProvenance: Record<string, StrategyProvenance>;
  appendRequest(req: LlmRequestTrace, ctx: HostCtx): void;
  appendResponse(res: LlmResponseTrace): void;
  /** SF-S0a: record which strategy ran this turn and why. Idempotent —
   *  later milestones (escalation) overwrite an earlier routing decision.
   *  Works in either order vs. `appendRequest`. */
  setProvenance(turnId: string, prov: StrategyProvenance): void;
  /** JSON-safe deduped snapshot for local session persistence. */
  snapshot(): PersistedTraceTelemetry;
  /** Restore a saved snapshot (v2 or legacy v1). Invalid blobs are ignored. */
  hydrate(snapshot: PersistedTraceTelemetry | PersistedTraceTelemetryV1 | null | undefined): void;
  /** Reset the store — called on session clear / save-load. */
  clear(): void;
}

/** Fold provenance into a HostCtx without clobbering provider/model fields. */
function withProvenance(ctx: HostCtx, prov: StrategyProvenance): HostCtx {
  return {
    ...ctx,
    strategy: prov.strategy,
    strategySource: prov.strategySource,
    ...(prov.reason !== undefined ? { routerReason: prov.reason } : {}),
  };
}

function summaryOf(trace: TurnTrace): TurnTraceSummary {
  return {
    turnId: trace.turnId,
    hostCtx: trace.hostCtx,
    requestCount: trace.requests.length,
    responseCount: trace.responses.length,
  };
}

function summariesFromPayloads(): Record<string, TurnTraceSummary> {
  const out: Record<string, TurnTraceSummary> = {};
  for (const [turnId, trace] of payloadByTurn) out[turnId] = summaryOf(trace);
  return out;
}

function summarize(): TraceSnapshotSummary {
  let requestCount = 0;
  let responseCount = 0;
  for (const trace of payloadByTurn.values()) {
    requestCount += trace.requests.length;
    responseCount += trace.responses.length;
  }
  return {
    turnsWithTraces: payloadByTurn.size,
    requestCount,
    responseCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function coerceBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function coerceHostCtx(raw: unknown): HostCtx | null {
  if (!isRecord(raw)) return null;
  const providerId = coerceString(raw.providerId);
  const providerLabel = coerceString(raw.providerLabel);
  const modelLabel = coerceString(raw.modelLabel);
  const diagnosticsEnabled = coerceBoolean(raw.diagnosticsEnabled);
  const resumableServerMode = coerceBoolean(raw.resumableServerMode);
  if (
    !providerId ||
    !providerLabel ||
    !modelLabel ||
    diagnosticsEnabled === undefined ||
    resumableServerMode === undefined
  ) {
    return null;
  }
  const strategySource =
    raw.strategySource === 'user-selected' ||
    raw.strategySource === 'routed' ||
    raw.strategySource === 'escalated'
      ? raw.strategySource
      : undefined;
  return {
    providerId,
    providerLabel,
    modelLabel,
    diagnosticsEnabled,
    resumableServerMode,
    ...(coerceString(raw.strategy) ? { strategy: coerceString(raw.strategy) } : {}),
    ...(strategySource ? { strategySource } : {}),
    ...(coerceString(raw.routerReason) ? { routerReason: coerceString(raw.routerReason) } : {}),
  };
}

/** Hydrate a legacy v1 snapshot: coerce each full trace, then intern its
 *  requests so the in-memory form is deduped like live-captured traces. */
function hydrateV1(tracesByTurn: unknown): void {
  if (!isRecord(tracesByTurn)) return;
  for (const rawTrace of Object.values(tracesByTurn)) {
    if (!isRecord(rawTrace)) continue;
    const turnId = coerceString(rawTrace.turnId);
    const hostCtx = coerceHostCtx(rawTrace.hostCtx);
    if (!turnId || !hostCtx) continue;
    const rawRequests = Array.isArray(rawTrace.requests)
      ? (rawTrace.requests as LlmRequestTrace[])
      : [];
    payloadByTurn.set(turnId, {
      turnId,
      requests: rawRequests
        .filter((r) => isRecord(r) && typeof r.systemPrompt === 'string' && Array.isArray(r.messages))
        .map((r) => internRequest(r)),
      responses: Array.isArray(rawTrace.responses)
        ? (rawTrace.responses as LlmResponseTrace[])
        : [],
      hostCtx,
    });
  }
}

/** Hydrate a v2 snapshot: parse each content-table entry ONCE (shared
 *  instances by construction), re-register it in the intern tables, then
 *  rebuild requests from refs. Malformed turns/requests are skipped. */
function hydrateV2(snapshot: PersistedTraceTelemetry): void {
  if (!isRecord(snapshot.content) || !isRecord(snapshot.tracesByTurn)) return;
  const valueByRef = new Map<number, unknown>();
  for (const [key, json] of Object.entries(snapshot.content)) {
    const id = Number(key);
    if (!Number.isFinite(id) || typeof json !== 'string') continue;
    try {
      const value = JSON.parse(json) as unknown;
      valueByRef.set(id, value);
      // Re-register so post-hydrate appends dedupe against restored content
      // and snapshot() can resolve refs for restored requests.
      if (typeof value === 'string') {
        stringCanon.set(value, { id, value });
      } else {
        objectCanon.set(json, { id, value });
        if (value !== null && typeof value === 'object') objectIds.set(value, id);
      }
      contentJsonById.set(id, json);
      if (id >= nextContentId) nextContentId = id + 1;
    } catch {
      /* skip unparseable content entry */
    }
  }
  for (const rawTrace of Object.values(snapshot.tracesByTurn)) {
    if (!isRecord(rawTrace)) continue;
    const turnId = coerceString(rawTrace.turnId);
    const hostCtx = coerceHostCtx(rawTrace.hostCtx);
    if (!turnId || !hostCtx) continue;
    const requests: LlmRequestTrace[] = [];
    for (const rawReq of Array.isArray(rawTrace.requests) ? rawTrace.requests : []) {
      if (!isRecord(rawReq)) continue;
      const { systemPromptRef, toolsRef, messageRefs, ...rest } = rawReq as PersistedRequestV2;
      const systemPrompt = valueByRef.get(systemPromptRef);
      if (typeof systemPrompt !== 'string' || !Array.isArray(messageRefs)) {
        continue;
      }
      const req = {
        ...rest,
        systemPrompt,
        // `tools` restores to whatever was captured (normally an array;
        // null for legacy/unserializable captures — same as JSON round-trip).
        tools: valueByRef.get(toolsRef),
        messages: messageRefs.map((ref) => valueByRef.get(ref)).filter((m) => m !== undefined),
      } as unknown as LlmRequestTrace;
      requestRefs.set(req, { systemPromptRef, toolsRef, messageRefs });
      requests.push(req);
    }
    payloadByTurn.set(turnId, {
      turnId,
      requests,
      responses: Array.isArray(rawTrace.responses)
        ? (rawTrace.responses as LlmResponseTrace[])
        : [],
      hostCtx,
    });
  }
}

export const useTraceStore = create<TraceState>()((set) => ({
  summaries: {},
  pendingProvenance: {},
  appendRequest: (req, ctx) =>
    set((s) => {
      const interned = internRequest(req);
      const existing = payloadByTurn.get(req.turnId);
      if (existing) {
        existing.requests.push(interned);
      } else {
        // First request for the turn: seed hostCtx, folding in any provenance
        // the router already reported (the usual order — routing fires first).
        const pending = s.pendingProvenance[req.turnId];
        payloadByTurn.set(req.turnId, {
          turnId: req.turnId,
          requests: [interned],
          responses: [],
          hostCtx: pending ? withProvenance(ctx, pending) : ctx,
        });
      }
      const trace = payloadByTurn.get(req.turnId)!;
      return {
        summaries: { ...s.summaries, [req.turnId]: summaryOf(trace) },
      };
    }),
  setProvenance: (turnId, prov) =>
    set((s) => {
      const existing = payloadByTurn.get(turnId);
      if (existing) {
        existing.hostCtx = withProvenance(existing.hostCtx, prov);
        return {
          summaries: { ...s.summaries, [turnId]: summaryOf(existing) },
        };
      }
      // Provenance arrived before the first request — stash it.
      return { pendingProvenance: { ...s.pendingProvenance, [turnId]: prov } };
    }),
  appendResponse: (res) =>
    set((s) => {
      // requestId format: `${turnId}#${iteration}`
      const hashIdx = res.requestId.lastIndexOf('#');
      if (hashIdx === -1) return s;
      const turnId = res.requestId.slice(0, hashIdx);
      const existing = payloadByTurn.get(turnId);
      if (!existing) return s;
      existing.responses.push(res);
      return {
        summaries: { ...s.summaries, [turnId]: summaryOf(existing) },
      };
    }),
  snapshot: (): PersistedTraceTelemetry => {
    const tracesByTurn: Record<string, PersistedTurnTraceV2> = {};
    const usedRefs = new Set<number>();
    for (const [turnId, trace] of payloadByTurn) {
      const requests: PersistedRequestV2[] = [];
      for (const req of trace.requests) {
        // Every stored request was interned on append/hydrate; re-intern
        // defensively if a ref is somehow missing.
        const refs = requestRefs.get(req) ?? requestRefs.get(internRequest(req))!;
        usedRefs.add(refs.systemPromptRef);
        usedRefs.add(refs.toolsRef);
        for (const id of refs.messageRefs) usedRefs.add(id);
        const { systemPrompt: _sys, tools: _tools, messages: _msgs, ...rest } = req;
        requests.push({ ...rest, ...refs });
      }
      tracesByTurn[turnId] = {
        turnId,
        hostCtx: trace.hostCtx,
        requests,
        responses: trace.responses,
      };
    }
    const content: Record<string, string> = {};
    for (const id of usedRefs) {
      const json = contentJsonById.get(id);
      if (json !== undefined) content[String(id)] = json;
    }
    return {
      version: 2,
      content,
      tracesByTurn,
      capturedAt: Date.now(),
      summary: summarize(),
    };
  },
  hydrate: (snapshot) => {
    resetPayloadStore();
    if (isRecord(snapshot)) {
      if (snapshot.version === 2) hydrateV2(snapshot as PersistedTraceTelemetry);
      else if (snapshot.version === 1) hydrateV1(snapshot.tracesByTurn);
    }
    set({ summaries: summariesFromPayloads(), pendingProvenance: {} });
  },
  clear: () => {
    resetPayloadStore();
    set({ summaries: {}, pendingProvenance: {} });
  },
}));
