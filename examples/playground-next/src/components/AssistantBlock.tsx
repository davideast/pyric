/**
 * One assistant message rendered inside a Turn container. Minimal
 * chrome — let the type hierarchy do the work:
 *
 *   ASSISTANT · GEMINI 3.1 FLASH LITE · 240MS · 2,374 TOK  21:35
 *
 *   [▸ Thinking · 240 chars]            ← inline fold (default closed)
 *
 *   • tool · writeRules · 830 chars     ← click-to-drill rows
 *   • tool · runOnce · 8ms · 1 doc
 *
 *   ── divider ──
 *
 *   I have built the "Foodie Express" app with…
 *
 * Identity lives in the header row only — no separate REPLY pill, no
 * tinted reply container, no left-border accent. The text response
 * sits below a hairline divider so the divide between "what the
 * agent did" and "what it says back to you" is clear without
 * shouting.
 */
import { useEffect, useState } from 'react';
import { CopyButton } from './CopyButton';
import { Fold } from './Fold';
import { Markdown } from './Markdown';
import type { ChatMessage, DelegatedActivity, ToolCall } from '~/lib/store/chat';
import {
  buildAssistantTimeline,
  hasInterleavedTimeline,
  isThinkingOnlyTurn,
  lastTextTimelineIndex,
  type TimelineItem,
} from '~/lib/store/chat-timeline';
import { deriveTurnStatus, isReplyHiddenWhileStreaming } from '~/lib/store/derive-turn-status';
import { StrategyStepper } from './teach/StrategyStepper';
import { SpecCard } from './teach/SpecCard';
import { toolDisplay } from '~/lib/tools/display';
import { rowStatForCall } from '~/lib/tools/behavior';
import { formatDuration } from '~/lib/utils/format';
import { formatCostUsd } from '~/lib/llm/pricing';
import { buildMetricsStripParts } from './teach/token-attribution';

/**
 * Ticks every 1s while `active` is true. Returns elapsed ms from
 * `startMs`. Cleans up the interval on unmount or when `active`
 * flips false — so the counter stops the moment the stream ends.
 */
function useElapsedMs(startMs: number, active: boolean): number {
  const [elapsed, setElapsed] = useState(() => Date.now() - startMs);
  useEffect(() => {
    if (!active) return;
    setElapsed(Date.now() - startMs);
    const id = setInterval(() => setElapsed(Date.now() - startMs), 1000);
    return () => clearInterval(id);
  }, [startMs, active]);
  return elapsed;
}

/**
 * Stopwatch — `M:SS` under an hour, `H:MM:SS` past. Padded seconds so
 * the digit width is stable as the counter ticks, no layout shift.
 */
function formatStopwatch(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

function LiveChip() {
  return (
    <span className="inline-flex items-center rounded-full border border-[#3a3a48] px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-slate-gray animate-pulse">
      live
    </span>
  );
}

interface Props {
  message: ChatMessage;
  time: string;
  /** Click a tool call → drill into ReadingPane via the parent. */
  onSelectTool?: (messageId: string, callId: string) => void;
}

function safeParse(s: string | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Compact stats string for an activity tool row. Derived from the
 * structured `result.diff` (for writes) or `result.run` counts (for
 * runOnce). Falls back to the agent-facing `summary` with its
 * `${toolName} · ` prefix stripped for unknown tools.
 */
function statsForTool(call: ToolCall): string {
  if (call.resultJson === undefined) return 'running…';
  const parsed = {
    name: call.name,
    args: safeParse(call.argsJson),
    result: safeParse(call.resultJson),
  };
  const cleanSummary = call.summary?.startsWith(`${call.name} · `)
    ? call.summary.slice(call.name.length + 3)
    : call.summary;
  return rowStatForCall(parsed, cleanSummary) || (call.ok === false ? 'failed' : 'ok');
}

/**
 * Cost/token strip — the per-turn grounding line. Shows the token
 * SPLIT (`in 8.8k · out 1.2k · cached 6.4k`) rather than a bare total
 * so the user learns where turns get expensive: a fat `in` with no
 * `cached` means the prefix re-shipped; a fat `out` means the model
 * wrote a lot. Falls back to the legacy total for older messages.
 */
function formatMetrics(m: ChatMessage['metrics']): string | null {
  if (!m) return null;
  const parts: string[] = [];
  // Cost LEADS the strip — it's the primary per-turn metric, and the
  // row overflows from the right on narrow screens, so a trailing cost
  // was the first thing to get cut. `≈` prefix when locally-estimated
  // (Gemini pricing table), exact when the provider returned a real
  // number (OpenRouter `usage.cost`). Matches the AnalyzeSection
  // telemetry chip's vocab.
  if (typeof m.costUsd === 'number') {
    parts.push(`${m.costEstimated ? '≈' : ''}${formatCostUsd(m.costUsd)}`);
  }
  if (m.durationMs != null) parts.push(formatDuration(m.durationMs));
  parts.push(...buildMetricsStripParts(m));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Compose the "copy entire message" payload — a JSON dump of the
 * whole assistant message with args/result fields parsed back into
 * proper nested objects so the copied output reads as JSON rather
 * than strings-containing-JSON. Same convention the tool drill-in
 * copy uses.
 */
function buildEntireMessageCopy(m: ChatMessage): string {
  return JSON.stringify(
    {
      provider: m.providerLabel,
      model: m.modelLabel,
      timestamp: new Date(m.createdAt).toISOString(),
      thinking: m.thinking?.trimEnd() || undefined,
      thinkingChunks: m.thinkingChunks,
      toolCalls: m.toolCalls?.map((c) => ({
        name: c.name,
        summary: c.summary,
        ok: c.ok,
        args: safeParseJson(c.argsJson),
        result: safeParseJson(c.resultJson),
      })),
      delegatedActivity: m.delegatedActivity,
      rawTranscript: m.rawTranscript,
      text: m.text,
      metrics: m.metrics,
    },
    null,
    2,
  );
}

function safeParseJson(s: string | undefined): unknown {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function ThinkingBlock({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const trimmed = text.trimEnd();
  if (!trimmed) return null;
  return (
    <Fold
      tone="thought"
      header={
        <span>
          <span className="text-[10px] uppercase tracking-wider text-slate-gray mr-1.5">
            thinking
          </span>
          <span className="text-slate-gray/80">
            {trimmed.length} char{trimmed.length === 1 ? '' : 's'}
          </span>
        </span>
      }
      headerAction={<CopyButton value={trimmed} label="Copy thinking" size={12} />}
    >
      <div className="text-[12px] font-mono text-slate-gray leading-relaxed break-words">
        <Markdown source={trimmed} streaming={streaming} />
      </div>
    </Fold>
  );
}

function DelegatedActivityRow({ activity }: { activity: DelegatedActivity }) {
  const display = toolDisplay(activity.name);
  const running = activity.resultSummary === undefined;
  const stat = activity.resultSummary ?? activity.summary;
  return (
    <div
      className={[
        'w-full flex items-center gap-2.5 text-left px-1.5 py-1 rounded',
        running ? 'opacity-80' : '',
      ].join(' ')}
    >
      <span className="text-[10px] uppercase tracking-wider text-slate-gray shrink-0 w-8">
        tool
      </span>
      <span className="material-symbols-outlined text-[14px] text-slate-gray shrink-0">
        {display.icon}
      </span>
      <span className="text-[11px] font-mono uppercase tracking-wider shrink-0 text-soft-white">
        {display.humanLabel}
      </span>
      <span className="text-[11px] font-mono text-slate-gray truncate flex-1 min-w-0">
        · {stat}
      </span>
    </div>
  );
}

function ToolRow({ call, onSelect }: { call: ToolCall; onSelect: () => void }) {
  const running = call.resultJson === undefined;
  const failed = call.ok === false;
  const display = toolDisplay(call.name);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'w-full flex items-center gap-2.5 text-left',
        'px-1.5 py-1 rounded transition-colors',
        'hover:bg-[#2a2a35]/40',
        running ? 'opacity-80' : '',
      ].join(' ')}
    >
      <span className="text-[10px] uppercase tracking-wider text-slate-gray shrink-0 w-8">
        tool
      </span>
      <span className="material-symbols-outlined text-[14px] text-slate-gray shrink-0">
        {display.icon}
      </span>
      <span
        className={[
          'text-[11px] font-mono uppercase tracking-wider shrink-0',
          failed ? 'text-[#f0a0a0]' : 'text-soft-white',
        ].join(' ')}
      >
        {display.humanLabel}
      </span>
      <span className="text-[11px] font-mono text-slate-gray truncate flex-1 min-w-0">
        · {statsForTool(call)}
      </span>
    </button>
  );
}

function renderTimelineItem(
  item: TimelineItem,
  key: string,
  opts: {
    isFinalReply: boolean;
    isStreaming: boolean;
    messageId: string;
    onSelectTool?: (messageId: string, callId: string) => void;
  },
) {
  switch (item.kind) {
    case 'thinking':
      return (
        <ThinkingBlock
          key={key}
          text={item.text}
          streaming={!!item.live && opts.isStreaming}
        />
      );
    case 'tool':
      return (
        <ToolRow
          key={key}
          call={item.call}
          onSelect={() => opts.onSelectTool?.(opts.messageId, item.call.id)}
        />
      );
    case 'delegated':
      return (
        <div key={key}>
          <DelegatedActivityRow activity={item.activity} />
        </div>
      );
    case 'text':
      if (opts.isFinalReply) {
        return (
          <div key={key} className="pt-3 border-t border-[#2a2a35]">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] uppercase tracking-wider text-slate-gray">reply</p>
              <CopyButton value={item.text} label="Copy reply" />
            </div>
            <div className="text-[13px] text-soft-white leading-relaxed break-words">
              <Markdown source={item.text} streaming={opts.isStreaming} />
            </div>
          </div>
        );
      }
      return (
        <div key={key} className="text-[13px] text-soft-white/90 leading-relaxed break-words">
          <Markdown source={item.text} streaming={false} />
        </div>
      );
  }
}

export function AssistantBlock({ message, time, onSelectTool }: Props) {
  const hasThinking = !!message.thinking && message.thinking.length > 0;
  const toolCalls = message.toolCalls ?? [];
  const delegatedActivity = message.delegatedActivity ?? [];
  const text = message.text;
  const isStreaming = !!message.streaming;
  const replyHidden = isReplyHiddenWhileStreaming(message);
  const turnStatus = deriveTurnStatus(message);
  const useInterleaved = hasInterleavedTimeline(message);
  const assistantTimeline = buildAssistantTimeline(message, { streaming: isStreaming });
  const lastTextIdx = assistantTimeline ? lastTextTimelineIndex(assistantTimeline) : -1;
  const thinkingOnly = isThinkingOnlyTurn(message);
  const metricsLine = formatMetrics(message.metrics);
  // Live stopwatch while streaming so the user has a sense of how
  // long the model has been chewing on the turn. Swaps back to the
  // wall-clock start time the moment the stream completes.
  const elapsedMs = useElapsedMs(message.createdAt, isStreaming);

  // Identity row up top carries WHO (agent + which model). Metrics
  // moved to the bottom as a grounding line — they fit better as
  // closing facts than as another piece of preamble. Keeps the
  // header readable while streaming, before metrics have landed.
  const identityParts: string[] = ['assistant'];
  if (message.providerLabel && message.modelLabel) {
    identityParts.push(`${message.providerLabel.toLowerCase()} ${message.modelLabel.toLowerCase()}`);
  } else if (message.modelLabel) {
    identityParts.push(message.modelLabel.toLowerCase());
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-gray min-w-0 truncate">
          {identityParts.join(' · ')}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {isStreaming ? <LiveChip /> : null}
          <time className="text-[11px] font-mono text-slate-gray tabular-nums">
            {isStreaming ? formatStopwatch(elapsedMs) : time}
          </time>
        </span>
      </header>

      {hasThinking && !useInterleaved && !thinkingOnly ? (
        <ThinkingBlock text={message.thinking ?? ''} streaming={isStreaming} />
      ) : null}

      {/* Plan/phase stepper — how the strategy ran this turn (draft →
          validate → repair, critiques, escalations). Renders nothing
          for plain ReAct turns; sits ABOVE the timeline so the user
          reads the plan before the play-by-play. */}
      <StrategyStepper
        phaseEvents={message.phaseEvents}
        critiques={message.reflexionCritiques}
        streaming={isStreaming}
      />

      {/* Spec card — the draft's access matrix + assumptions
          (validation_result's spec payload). Renders nothing for
          ReAct turns and spec-fallback drafts. */}
      <SpecCard phaseEvents={message.phaseEvents} />

      {turnStatus?.showStrip ? (
        <p className="px-1.5 py-1 text-[11px] font-mono text-slate-gray">
          {turnStatus.label}
        </p>
      ) : null}

      {assistantTimeline && (useInterleaved || thinkingOnly)
        ? assistantTimeline.map((item, i) =>
            renderTimelineItem(item, `tl-${i}`, {
              isFinalReply: i === lastTextIdx,
              isStreaming,
              messageId: message.id,
              onSelectTool,
            }),
          )
        : null}

      {/* Legacy fallback — older messages without chunk metadata. */}
      {!useInterleaved && !thinkingOnly && toolCalls.length > 0 ? (
        <ul className="flex flex-col -mx-1">
          {toolCalls.map((call) => (
            <ToolRow
              key={call.id}
              call={call}
              onSelect={() => onSelectTool?.(message.id, call.id)}
            />
          ))}
        </ul>
      ) : null}

      {/* Strategy milestones (draft-validate phases, reflexion
          critiques) render in the StrategyStepper above the timeline
          — the old bottom strips moved up there as chips + detail
          lines so the plan reads BEFORE the play-by-play. */}

      {!useInterleaved && !thinkingOnly && text && !replyHidden ? (
        <div className="pt-3 border-t border-[#2a2a35]">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-gray">reply</p>
            <CopyButton value={text} label="Copy reply" />
          </div>
          <div className="text-[13px] text-soft-white leading-relaxed break-words">
            <Markdown source={text} streaming={isStreaming} />
          </div>
        </div>
      ) : null}

      {/* Grounding row at the bottom — closing stats + a "copy
       *  entire message" button. `copy_all` (Material's stacked-page
       *  icon) signals that this copy spans the whole turn, distinct
       *  from the per-section copies above (which use `content_copy`).
       *  Uses the shared `CopyButton` so the check-mark confirmation
       *  matches every other copy on the page. */}
      {(metricsLine || hasThinking || toolCalls.length > 0 || delegatedActivity.length > 0 || text) ? (
        <div className="mt-1 flex items-center justify-between gap-3">
          <p className="text-[10px] font-mono text-slate-gray/70 truncate">
            {metricsLine ?? ''}
          </p>
          <CopyButton
            value={buildEntireMessageCopy(message)}
            label="Copy entire message"
            text="Copy all"
            icon="copy_all"
          />
        </div>
      ) : null}
    </section>
  );
}
