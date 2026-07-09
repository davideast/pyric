/**
 * Chat store — Zustand-backed. Shape ported from the original
 * playground but slimmed: only the fields the new shell actually
 * renders. Persistence is in-memory for now (Phase 1 will add
 * localStorage + Firebase Storage save/load).
 */
import { create } from 'zustand';
// 0.4.1 moved CompactionMarker off the ./usage subpath; the root export
// carries it (re-exported from usage/context-management).
import type { CompactionMarker } from '@inbrowser/agent';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { APP_ENTRY_PATH, DATABASE_RULES_PATH, RULES_PATH } from '~/lib/store/files';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ToolCall {
  /** Stable id so the model can correlate result back to the call. */
  id: string;
  name: string;
  /** Arguments the model emitted. JSON-stringified for verbatim display. */
  argsJson: string;
  /** Stringified result; absent while the call is in flight. */
  resultJson?: string;
  ok?: boolean;
  /** One-line human-readable summary the model can quote on the next turn. */
  summary?: string;
  /** Provider-specific opaque token (Gemini's thoughtSignature, etc.).
   *  MUST be round-tripped on the same call when replaying history.
   *  When present, the drill-in surfaces a small `signed` chip on
   *  the reasoning fold to signal "this thinking is reproducible." */
  signature?: string;
  /** Wall-clock milliseconds when the model emitted this tool call,
   *  set in the session host's `tool_started` handler. Drill-in
   *  derives `+N.Ns after prompt` by subtracting the owning user
   *  prompt's `createdAt`. */
  emittedAt?: number;
  /** Snapshot of the assistant message's `thinking` buffer at the
   *  moment this call was emitted — i.e. the reasoning that led up
   *  to the decision to fire this tool. Subsequent thinking (chunks
   *  arriving after the call) doesn't belong to this call.
   *
   *  Rendered in the drill-in via the same `<Fold>` the assistant
   *  block uses for whole-turn thinking. Empty for non-reasoning
   *  models. */
  thinkingUpToHere?: string;
  /** Content of the target file BEFORE this `write_file`/`delete_file`
   *  call ran — display-side snapshot captured the moment the in-flight
   *  call lands in the store (the UI-side `tool_started` boundary).
   *  Feeds the drill-in's before/after diff view. Absent when the
   *  prior content is unknown (e.g. a restored session's first write
   *  to a path the store never observed) — the drill-in falls back to
   *  the full-source view. Never sent to the model. */
  priorContent?: string;
  /** Cached "fix pattern" explanation for an `inspect_denial`
   *  drill-in's walkthrough (panel 3). Separate from `analysis` —
   *  that slot belongs to the generic Analyze & Explain section and
   *  the two can coexist on the same call. Persisted so reopening
   *  the drill-in doesn't re-bill the user. */
  denialFix?: {
    text: string;
    thinking?: string;
    providerLabel: string;
    modelLabel: string;
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
    costEstimated: boolean;
    generatedAt: number;
  };
  /** Cached "Analyze & Explain" output for this call. When present,
   *  reopening the drill-in shows the prior explanation instead of
   *  re-running the model. */
  analysis?: {
    text: string;
    /** Reasoning content the model emitted (empty for non-thinking
     *  models). Rendered via the same `Fold` the assistant block
     *  uses for thinking — consistent UI. */
    thinking?: string;
    providerLabel: string;
    modelLabel: string;
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
    costEstimated: boolean;
    generatedAt: number;
    /** Follow-up suggestions the model emits after the analysis.
     *  Two kinds: `action` (Send button submits `prompt` to the
     *  agent) and `no-action` (disabled "No Action" chip). Sent /
     *  dismissed state is persisted on the suggestion itself so
     *  it survives tab switches that remount the rendering panel. */
    suggestions?: Array<{
      kind: 'action' | 'no-action';
      label: string;
      confidence: number;
      rationale: string;
      prompt?: string;
      /** True after the user clicked Send. UI shows "Sent" badge,
       *  Send button locked. Persisted so a tab switch doesn't
       *  reset the row to a fresh sendable state. */
      sent?: boolean;
      /** True after the user clicked Dismiss. UI hides the row
       *  entirely. */
      dismissed?: boolean;
    }>;
  };
}

/**
 * One contiguous run of assistant text during a turn. The agent loop
 * is ReAct-shaped — the model can emit some text, fire a tool call,
 * receive a result, emit more text, fire another call, then finally
 * emit a closing reply. To render those events in the order they
 * happened (and not bucket every tool call between thinking and
 * the final reply), the host snapshots accumulated text into a
 * `TextChunk` each time a tool call lands and once on `turn_completed`.
 *
 * `ts` is wall-clock ms at snapshot time. Combined with each tool
 * call's `emittedAt`, the renderer can sort the timeline and
 * interleave.
 */
export interface TextChunk {
  text: string;
  ts: number;
}

/** One contiguous run of model reasoning snapshotted at each tool-call
 *  boundary (and once on turn_completed for trailing thought). Same
 *  contract as `TextChunk` — lets the renderer interleave thinking
 *  with tool rows chronologically instead of one top-level fold. */
export interface ThinkingChunk {
  text: string;
  ts: number;
}

/** One Reflexion critique decision (0.2.0 reflexion strategy). The
 *  `verdict` discriminates the outcome the strategy took:
 *   - `ok`        — the critique passed; the answer was committed as-is.
 *   - `retry`     — the critique found problems; the loop retried with
 *                   `feedback` injected as a synthetic user message.
 *   - `exhausted` — problems found but retries were spent; the answer
 *                   was returned anyway (reflexion never blocks). */
export interface ReflexionCritique {
  verdict: 'ok' | 'retry' | 'exhausted';
  /** Raw critique text the critique LLM produced. */
  text?: string;
  /** The actionable feedback (present on retry/exhausted). */
  feedback?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Snapshotted chunks of assistant text in emission order — used by
   *  the renderer to interleave with `toolCalls` chronologically.
   *  Absent for historical / non-assistant messages; renderer falls
   *  back to the legacy "all tools, then reply" layout when missing. */
  textChunks?: TextChunk[];
  /** Reasoning segments in emission order — snapshotted at each
   *  `tool_started` boundary and on `turn_completed`. */
  thinkingChunks?: ThinkingChunk[];
  toolCalls?: ToolCall[];
  thinking?: string;
  createdAt: number;
  /** Marks an assistant message that's still streaming. */
  streaming?: boolean;
  /** Durable-job coordinates for the server-mode LLM request currently
   *  streaming into this message ({ jobId, seq } — seq is the resume
   *  offset into the job's event log). Stamped by the session host while
   *  streaming, cleared when the request finishes. If the page dies
   *  mid-request (reload / tab discard), the persisted value lets
   *  `recoverInterruptedJob` (inference/reattach.ts) tail the rest of
   *  the response from the durable log on next load. */
  activeJob?: { jobId: string; seq: number; provider?: string };
  /** Set by reattach recovery when this reply's turn was cut short by a
   *  page reload / tab discard and could not fully complete (tool calls
   *  in the recovered tail never ran, or the stream ended/expired
   *  early). Drives the "Resume turn" affordance next to the composer;
   *  cleared when the user resumes. */
  interrupted?: { toolCallsPending: boolean };
  /** Agent-session turn id (matches `SessionEvent.turnId` /
   *  `LlmRequestTrace.turnId`). Stamped by the session-host on
   *  `turn_started` for both the user prompt and the assistant
   *  response so the Trace drill-in can look up `byTurn[turnId]`.
   *  Absent for historical / restored messages. */
  turnId?: string;
  /** Captured at message creation so the per-message header shows the
   *  provider/model that actually produced it — switching the picker
   *  later doesn't rewrite history. */
  providerLabel?: string;
  modelLabel?: string;
  /** Per-turn telemetry stamped after the model finishes. */
  metrics?: {
    durationMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    tokensTotal?: number;
    costUsd?: number;
    costEstimated?: boolean;
    cachedTokens?: number;
    reasoningTokens?: number;
    isByok?: boolean;
  };
  /** Reflexion critiques emitted for this turn, in order. Each entry is
   *  one critique decision; a `retry` means the answer below was redone
   *  with the feedback injected. Absent when reflexion is off. */
  reflexionCritiques?: ReflexionCritique[];
}

interface ChatState {
  messages: ChatMessage[];
  /** Durable compaction events (append-only history redesign — see
   *  plans/context-compaction-redesign.md). Each marker says: model-
   *  bound history = marker summary + messages after `atMessageId`.
   *  Rendered as collapsible rows in the feed; persisted with the
   *  session (additive payload field). */
  compactionMarkers: CompactionMarker[];
  appendCompactionMarker(m: CompactionMarker): void;
  setCompactionMarkers(markers: CompactionMarker[]): void;
  appendMessage(m: ChatMessage): void;
  patchMessage(id: string, patch: Partial<ChatMessage>): void;
  patchToolCall(messageId: string, callId: string, patch: Partial<ToolCall>): void;
  clear(): void;
}

/* ── Display-side prior-content capture (teaching UI) ─────────────────
 *
 * The drill-in's diff view needs the file content from BEFORE a
 * `write_file`/`delete_file` ran. The tools don't return it (it would
 * double the tokens shipped back to the model), and the session host
 * is outside this track's surface — so the chat store captures it at
 * the UI-side `tool_started` boundary: the moment an in-flight write
 * call is appended via `patchMessage`.
 *
 * Source of truth is a session-local shadow of file contents, fed by
 * the calls themselves: each *completed* write records its `content`
 * as the path's latest content; a completed delete records ''. For the
 * first-ever write to the two workspace-mirrored paths the shadow
 * falls back to the workspace store (rules / App.tsx), which holds the
 * pre-agent content. Anything else starts unknown — `priorContent`
 * stays absent and the drill-in falls back to full source.
 *
 * Reading the VFS here instead would race the tool's own write (the
 * session event loop may dequeue `tool_started` after the tool already
 * executed); the shadow is deterministic.
 */

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

/** path → last-known content. Module-level on purpose: survives
 *  component remounts, dies with the page/session (cleared on
 *  `clear()`). */
const fileShadow = new Map<string, string>();

function safeParseArgs(argsJson: string): { path?: string; content?: string; edits?: Array<{ oldText?: string; newText?: string; replaceAll?: boolean }> } {
  try {
    const v = JSON.parse(argsJson) as unknown;
    return v && typeof v === 'object' ? (v as { path?: string; content?: string }) : {};
  } catch {
    return {};
  }
}

function shadowPriorFor(path: string): string | undefined {
  if (fileShadow.has(path)) return fileShadow.get(path);
  // The workspace store mirrors these two files from boot, so it holds
  // the pre-agent content for the session's first write to them.
  const ws = useWorkspaceStore.getState();
  if (path === RULES_PATH) return ws.rules;
  if (path === DATABASE_RULES_PATH) return ws.databaseRules;
  if (path === APP_ENTRY_PATH) return ws.appSource;
  return undefined;
}

/** Stamp `priorContent` onto newly-appended in-flight write/delete
 *  calls. Pure on inputs other than the shadow read; existing calls
 *  and non-write tools pass through untouched. */
function stampPriorContent(
  existing: readonly ToolCall[] | undefined,
  incoming: ToolCall[],
): ToolCall[] {
  const known = new Set((existing ?? []).map((c) => c.id));
  return incoming.map((c) => {
    if (
      known.has(c.id) ||
      c.resultJson !== undefined ||
      c.priorContent !== undefined ||
      !WRITE_TOOLS.has(c.name)
    ) {
      return c;
    }
    const { path } = safeParseArgs(c.argsJson);
    if (!path) return c;
    const prior = shadowPriorFor(path);
    return prior !== undefined ? { ...c, priorContent: prior } : c;
  });
}

/** Record a completed call's after-state into the shadow so the NEXT
 *  write to the same path knows its prior content. */
function recordShadowAfter(call: ToolCall): void {
  if (!WRITE_TOOLS.has(call.name) || call.resultJson === undefined) return;
  const { path, content, edits } = safeParseArgs(call.argsJson);
  if (!path) return;
  if (call.name === 'write_file') {
    // Even an ok:false write may have landed on the VFS (e.g. module
    // resolution failed but the file keeps the broken source) — the
    // tool result's `path` confirms the write happened.
    if (typeof content === 'string') fileShadow.set(path, content);
    return;
  }
  if (call.name === 'edit_file') {
    let landed = false;
    try {
      const result = JSON.parse(call.resultJson) as { data?: { diff?: unknown }; diff?: unknown };
      landed = Boolean(result?.data?.diff ?? result?.diff);
    } catch {
      landed = false;
    }
    if (!landed) return;
    const prior = call.priorContent ?? fileShadow.get(path);
    if (typeof prior !== 'string' || !Array.isArray(edits)) return;
    let next = prior;
    for (const edit of edits) {
      if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') return;
      next = edit.replaceAll === true
        ? next.split(edit.oldText).join(edit.newText)
        : next.replace(edit.oldText, edit.newText);
    }
    fileShadow.set(path, next);
    return;
  }
  // delete_file: only an actual deletion changes the file.
  try {
    const data = JSON.parse(call.resultJson) as { deleted?: boolean };
    if (data && data.deleted === true) fileShadow.set(path, '');
  } catch {
    /* unparseable result — leave the shadow as-is */
  }
}

export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  compactionMarkers: [],
  appendCompactionMarker: (marker) =>
    set((s) => ({ compactionMarkers: [...s.compactionMarkers, marker] })),
  setCompactionMarkers: (compactionMarkers) => set({ compactionMarkers }),
  appendMessage: (m) => {
    // Restored / replayed messages arrive complete — replay their
    // write calls into the shadow so diffs work for the writes that
    // FOLLOW a session restore.
    for (const c of m.toolCalls ?? []) recordShadowAfter(c);
    set((s) => ({ messages: [...s.messages, m] }));
  },
  patchMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== id) return m;
        if (!patch.toolCalls) return { ...m, ...patch };
        return {
          ...m,
          ...patch,
          toolCalls: stampPriorContent(m.toolCalls, patch.toolCalls),
        };
      }),
    })),
  patchToolCall: (messageId, callId, patch) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId || !m.toolCalls) return m;
        return {
          ...m,
          toolCalls: m.toolCalls.map((c) => (c.id === callId ? { ...c, ...patch } : c)),
        };
      }),
    }));
    // After the patch lands, feed completed write/delete calls into
    // the shadow (outside `set` — shadow writes aren't React state).
    if (patch.resultJson !== undefined) {
      const msg = get().messages.find((m) => m.id === messageId);
      const call = msg?.toolCalls?.find((c) => c.id === callId);
      if (call) recordShadowAfter(call);
    }
  },
  clear: () => {
    fileShadow.clear();
    set({ messages: [], compactionMarkers: [] });
  },
}));
