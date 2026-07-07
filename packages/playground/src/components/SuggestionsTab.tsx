/**
 * Centralized suggestions panel — one screen that aggregates every
 * suggestion the agent or the explainer has surfaced this session,
 * regardless of where it came from (tool-call analysis, denial
 * inspection). Without this, a user had to remember WHICH tool call
 * in WHICH turn had a useful follow-up — they were buried.
 *
 * Sources:
 *   - `analysis.suggestions` on every assistant message's tool calls
 *     (lives in `useChatStore`)
 *   - `analysis.suggestions` on every denial blurb (lives in
 *     `useRuntimeStore.liveDenials`)
 *
 * Each row reuses the visual treatment of `SuggestedPromptCard` — a
 * compact strip with confidence chip + Send / Dismiss affordances —
 * plus a "view source" link that drills the user back to the tool
 * call or denial that surfaced the suggestion. Drill navigation
 * goes through `useNavStore` so the cross-tab plumbing stays
 * declarative.
 *
 * Sent and dismissed state persists on the source's analysis object
 * (same pattern the per-source cards already use), so toggling
 * `sent` here updates the suggestion everywhere it appears.
 */
import { useMemo } from 'react';
import { useChatStore } from '~/lib/store/chat';
import { useMobileNavStore } from '~/lib/store/mobile-nav';
import { useNavStore } from '~/lib/store/nav';
import { useRuntimeStore } from '~/lib/store/runtime';
import { EmptyState } from './EmptyState';
import { SuggestedPromptCard, type RenderedSuggestion } from './SuggestedPromptCard';

interface SourceTool {
  kind: 'tool';
  messageId: string;
  callId: string;
  toolName: string;
  /** When the analysis was generated. Used for chronological sort. */
  generatedAt: number;
}

interface SourceDenial {
  kind: 'denial';
  denialId: string;
  /** Same as `denialId` — TrafficEntry.id == DenialBlurb.id by
   *  construction; aliased here to make the navigation intent
   *  explicit. */
  entryId: string;
  /** "create users/alice" — same `op` shape as the row label. */
  op: string;
  generatedAt: number;
}

type Source = SourceTool | SourceDenial;

interface Row {
  source: Source;
  /** Index within the source's `suggestions` array — needed for
   *  patch operations (mark sent / dismiss) which key by index. */
  suggestionIndex: number;
  suggestion: RenderedSuggestion;
}

interface Props {
  /** Called on Send — submits a suggested prompt to the agent. */
  onSendPrompt?: (prompt: string) => void;
  /** True while a turn is in flight — disables Send buttons. */
  sendBusy?: boolean;
  /** Called after a Send click. Parent uses this to switch tabs. */
  onAfterSend?: () => void;
  /** Activity tab id setter — so the source-drill can navigate the
   *  user to Activity (for a tool-call source) or Firestore (for a
   *  denial source). The Suggestions panel itself doesn't own
   *  `activeTab`; the parent does. */
  onNavigateActivity?: () => void;
  onNavigateFirestoreTraffic?: () => void;
}

export function SuggestionsTab({
  onSendPrompt,
  sendBusy,
  onAfterSend,
  onNavigateActivity,
  onNavigateFirestoreTraffic,
}: Props) {
  const messages = useChatStore((s) => s.messages);
  const patchToolCall = useChatStore((s) => s.patchToolCall);
  const liveDenials = useRuntimeStore((s) => s.liveDenials);
  const patchDenial = useRuntimeStore((s) => s.patchDenial);
  const requestToolDrill = useNavStore((s) => s.requestToolDrill);
  const requestDenialDrill = useNavStore((s) => s.requestDenialDrill);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.toolCalls) continue;
      for (const call of m.toolCalls) {
        const suggestions = call.analysis?.suggestions;
        if (!suggestions) continue;
        const generatedAt = call.analysis?.generatedAt ?? m.createdAt;
        for (let i = 0; i < suggestions.length; i++) {
          out.push({
            source: {
              kind: 'tool',
              messageId: m.id,
              callId: call.id,
              toolName: call.name,
              generatedAt,
            },
            suggestionIndex: i,
            suggestion: suggestions[i] as RenderedSuggestion,
          });
        }
      }
    }
    for (const d of liveDenials) {
      const suggestions = d.analysis?.suggestions;
      if (!suggestions) continue;
      // Denial analysis carries telemetry but not a separate
      // generatedAt; fall back to the denial timestamp. Suggestions
      // ordering is chronological by source-creation time.
      const generatedAt = d.at;
      for (let i = 0; i < suggestions.length; i++) {
        out.push({
          source: {
            kind: 'denial',
            denialId: d.id,
            entryId: d.id,
            op: d.op,
            generatedAt,
          },
          suggestionIndex: i,
          suggestion: suggestions[i] as RenderedSuggestion,
        });
      }
    }
    // Newest first — fresh suggestions deserve the top of the list.
    return out.sort((a, b) => b.source.generatedAt - a.source.generatedAt);
  }, [messages, liveDenials]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="tips_and_updates"
        title="No suggestions yet"
        body="Suggestions surface when you analyze a tool call or inspect a denial. Once one appears, it lands here regardless of which tab you analyzed it from."
      />
    );
  }

  // Group consecutive rows by source so the source-drill stays
  // attached to the suggestion(s) it produced. Most sources emit
  // 1-3 suggestions, so groups stay short.
  const groups = (() => {
    const out: { source: Source; rows: Row[] }[] = [];
    let currentKey: string | null = null;
    for (const r of rows) {
      const key =
        r.source.kind === 'tool'
          ? `tool:${r.source.messageId}:${r.source.callId}`
          : `denial:${r.source.denialId}`;
      if (key !== currentKey) {
        out.push({ source: r.source, rows: [] });
        currentKey = key;
      }
      out[out.length - 1].rows.push(r);
    }
    return out;
  })();

  const patchSuggestionAt = (row: Row, patch: { sent?: boolean; dismissed?: boolean }) => {
    const src = row.source;
    if (src.kind === 'tool') {
      const msg = messages.find((m) => m.id === src.messageId);
      const call = msg?.toolCalls?.find((c) => c.id === src.callId);
      const cached = call?.analysis;
      if (!cached) return;
      const next = (cached.suggestions ?? []).map((s, i) =>
        i === row.suggestionIndex ? { ...s, ...patch } : s,
      );
      patchToolCall(src.messageId, src.callId, {
        analysis: { ...cached, suggestions: next },
      });
      return;
    }
    const denial = liveDenials.find((d) => d.id === src.denialId);
    const cached = denial?.analysis;
    if (!cached) return;
    const next = (cached.suggestions ?? []).map((s, i) =>
      i === row.suggestionIndex ? { ...s, ...patch } : s,
    );
    patchDenial(src.denialId, {
      analysis: { ...cached, suggestions: next },
    });
  };

  const handleMarkSent = (row: Row) => patchSuggestionAt(row, { sent: true });
  const handleDismiss = (row: Row) => patchSuggestionAt(row, { dismissed: true });

  const navigateToSource = (source: Source) => {
    // On mobile we also need to land on the Agent bottom-tab; on
    // desktop the right pane is always visible.
    useMobileNavStore.getState().setActive('agent');
    if (source.kind === 'tool') {
      requestToolDrill(source.messageId, source.callId);
      onNavigateActivity?.();
    } else {
      requestDenialDrill(source.entryId);
      onNavigateFirestoreTraffic?.();
    }
  };

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="grid gap-3 w-full pt-4 px-4 pb-6">
        {groups.map((g) => (
          <section
            key={
              g.source.kind === 'tool'
                ? `tool:${g.source.messageId}:${g.source.callId}`
                : `denial:${g.source.denialId}`
            }
            className="rounded-md border border-[#2a2a35]/60 bg-[#0f0f17] overflow-hidden"
          >
            <header className="px-3 py-2 border-b border-[#2a2a35]/40 flex items-center gap-2 flex-wrap">
              <span
                className={[
                  'px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider font-mono',
                  g.source.kind === 'tool'
                    ? 'text-soft-white border-soft-white/30'
                    : 'text-[#f0a0a0] border-[#f0a0a0]/40',
                ].join(' ')}
              >
                {g.source.kind === 'tool' ? 'tool' : 'denial'}
              </span>
              <span className="text-[11px] font-mono text-soft-white truncate min-w-0">
                {g.source.kind === 'tool' ? g.source.toolName : g.source.op}
              </span>
              <button
                type="button"
                onClick={() => navigateToSource(g.source)}
                className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#2a2a35] text-[10px] font-mono uppercase tracking-wider text-slate-gray hover:text-soft-white hover:border-[#3a3a45] transition-colors shrink-0"
                title="Drill into the source tool call / denial"
              >
                <span className="material-symbols-outlined text-[12px]">
                  arrow_outward
                </span>
                <span>view source</span>
              </button>
            </header>
            <div className="px-3 pb-2 pt-1">
              <SuggestedPromptCard
                suggestions={g.rows.map((r) => r.suggestion)}
                {...(onSendPrompt ? { onSend: onSendPrompt } : {})}
                {...(sendBusy !== undefined ? { sendBusy } : {})}
                {...(onAfterSend ? { onAfterSend } : {})}
                onMarkSent={(localIdx) => handleMarkSent(g.rows[localIdx]!)}
                onDismiss={(localIdx) => handleDismiss(g.rows[localIdx]!)}
              />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
