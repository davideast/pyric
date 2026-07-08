/**
 * Right-panel Activity tab — groups the chat store into per-turn
 * containers. Each user prompt + the assistant messages that
 * followed render together inside one `<Turn>` card, so a single
 * "send" reads as a contained unit no matter how many ReAct
 * iterations the agent went through.
 *
 * Thinking is foldable inline (default collapsed). Tool calls are
 * listed compactly; clicking a tool row opens its args + result in
 * the `ReadingPane` — that drill-in pattern stays because tool
 * payloads can be long and reading them in a focused full-pane view
 * is nicer than a sprawling inline fold.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore, type ChatMessage, type ToolCall } from '~/lib/store/chat';
import type { CompactionMarker } from '@inbrowser/agent/usage';
import { useEnhancerStore, type Enhancement } from '~/lib/store/enhancer';
import { useNavStore } from '~/lib/store/nav';
import { useSettingsStore } from '~/lib/store/settings';
import { EmptyState } from './EmptyState';
import { PromptEnhancementCard } from './PromptEnhancementCard';
import { ToolDetailView } from './ToolDetailView';
import { TraceView } from './TraceView';
import { Turn } from './Turn';

interface TurnGroup {
  prompt: ChatMessage;
  responses: ChatMessage[];
}

function groupByTurn(messages: readonly ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      current = { prompt: m, responses: [] };
      groups.push(current);
      continue;
    }
    if (m.role === 'assistant') {
      if (!current) {
        // Defensive: assistant message with no preceding prompt
        // shouldn't happen, but synthesize a placeholder so we don't
        // silently drop it.
        current = {
          prompt: { ...m, role: 'user', text: '(unknown prompt)', toolCalls: undefined },
          responses: [],
        };
        groups.push(current);
      }
      current.responses.push(m);
    }
  }
  return groups;
}

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 5);
}

function findTool(
  groups: readonly TurnGroup[],
  messageId: string,
  callId: string,
): { call: ToolCall; createdAt: number } | null {
  for (const g of groups) {
    for (const m of g.responses) {
      if (m.id !== messageId) continue;
      const call = m.toolCalls?.find((c) => c.id === callId);
      if (call) return { call, createdAt: m.createdAt };
    }
  }
  return null;
}

type Selected =
  | { kind: 'tool'; messageId: string; callId: string }
  | { kind: 'trace'; turnId: string };

interface ActivityTabProps {
  /** Pass through to `ToolDetailView` so its AnalyzeSection's
   *  suggested-prompt card can submit a prompt to the agent. */
  onSendPrompt?: (prompt: string) => void;
  /** True while a turn is in flight — disables Send buttons. */
  sendBusy?: boolean;
  /** Called after a Send-to-agent click — used to drop the user out
   *  of the drill-in back to the timeline. */
  onAfterSend?: () => void;
  /** Approve a streamed enhancement → submits enhanced text to the
   *  agent loop. Wired by PlaygroundPage. */
  onApproveEnhancement?: (id: string, enhancedText: string) => void;
  /** Edit an enhancement → drops it into the composer with toggle off. */
  onEditEnhancement?: (id: string, enhancedText: string) => void;
  /** Discard an enhancement → tombstone state. */
  onDiscardEnhancement?: (id: string) => void;
  /** Retry a failed enhancement → re-runs the enhancer call. */
  onRetryEnhancement?: (id: string, rawInput: string) => void;
}

/** True when the card is still live UI — not approved/edited/discarded.
 *  Surfaced live cards stay at the bottom; resolved cards interleave
 *  with turns by createdAt. */
function isLiveEnhancement(e: Enhancement): boolean {
  return e.state === 'streaming' || e.state === 'ready' || e.state === 'errored';
}

/** Distance from the bottom (px) within which we treat the user as
 *  "following" the live stream — auto-scroll only while pinned. */
const SCROLL_PIN_THRESHOLD_PX = 80;

function isPinnedToBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_PIN_THRESHOLD_PX;
}

export function ActivityTab({
  onSendPrompt,
  sendBusy,
  onAfterSend,
  onApproveEnhancement,
  onEditEnhancement,
  onDiscardEnhancement,
  onRetryEnhancement,
}: ActivityTabProps = {}) {
  const messages = useChatStore((s) => s.messages);
  const compactionMarkers = useChatStore((s) => s.compactionMarkers);
  const enhancements = useEnhancerStore((s) => s.enhancements);
  const autoFoldOlder = useSettingsStore((s) => s.autoFoldOlder);
  const bumpCollapse = useSettingsStore((s) => s.bumpCollapse);
  const groups = useMemo(() => groupByTurn(messages), [messages]);
  const [selected, setSelected] = useState<Selected | null>(null);

  // Honor a cross-tab drill request from the Suggestions panel (or
  // any future surface). The Suggestions row writes `requestToolDrill`
  // + switches the active tab to `activity`; this effect applies the
  // drill on mount and clears the pending request.
  const pending = useNavStore((s) => s.pending);
  const clearPending = useNavStore((s) => s.clearPending);
  useEffect(() => {
    if (pending?.kind !== 'tool') return;
    setSelected({
      kind: 'tool',
      messageId: pending.messageId,
      callId: pending.callId,
    });
    clearPending();
  }, [pending, clearPending]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** True while the user is at (or near) the bottom — streaming updates
   *  auto-scroll only in this state so reading earlier turns isn't
   *  interrupted. Reset when a new turn starts (user just sent). */
  const followStreamRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followStreamRef.current = isPinnedToBottom(el);
  };

  // Split enhancement cards: resolved (approved/edited/discarded) ones
  // interleave with turn groups in chronological order; live ones
  // (streaming/ready/errored) pin to the bottom so the action surface
  // is always reachable without scrolling.
  const { resolvedEnhancements, liveEnhancements } = useMemo(() => {
    const live: Enhancement[] = [];
    const resolved: Enhancement[] = [];
    for (const e of enhancements) {
      if (isLiveEnhancement(e)) live.push(e);
      else resolved.push(e);
    }
    return { resolvedEnhancements: resolved, liveEnhancements: live };
  }, [enhancements]);

  // Auto-scroll while the user is pinned to the bottom. Scrolling up
  // breaks the pin so fast streams (e.g. Claude CLI transcript dumps)
  // don't yank the viewport; scrolling back to the bottom re-enables it.
  const tailMsg = groups[groups.length - 1]?.responses.at(-1);
  const tailLen = tailMsg?.text.length ?? 0;
  const tailThinkingLen = tailMsg?.thinking?.length ?? 0;
  const liveEnhancementText = liveEnhancements
    .map((e) => e.enhancedText.length)
    .reduce((a, b) => a + b, 0);

  const prevTurnCountForScrollRef = useRef(groups.length);
  useEffect(() => {
    if (groups.length > prevTurnCountForScrollRef.current) {
      followStreamRef.current = true;
      const el = scrollRef.current;
      if (el && !selected) el.scrollTop = el.scrollHeight;
    }
    prevTurnCountForScrollRef.current = groups.length;
  }, [groups.length, selected]);

  useEffect(() => {
    if (selected) return;
    if (!followStreamRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [
    tailLen,
    tailThinkingLen,
    selected,
    liveEnhancements.length,
    liveEnhancementText,
  ]);

  // Auto-fold older turns on each new turn when the setting is on.
  // Bumps the shared collapse signal so every Turn resets to its
  // `isLatest` open state. User can still manually expand any after.
  const prevTurnCountRef = useRef(groups.length);
  useEffect(() => {
    if (!autoFoldOlder) {
      prevTurnCountRef.current = groups.length;
      return;
    }
    if (groups.length > prevTurnCountRef.current) {
      bumpCollapse();
    }
    prevTurnCountRef.current = groups.length;
  }, [groups.length, autoFoldOlder, bumpCollapse]);

  if (selected?.kind === 'trace') {
    return (
      <TraceView
        turnId={selected.turnId}
        onBack={() => setSelected(null)}
      />
    );
  }

  if (selected?.kind === 'tool') {
    const hit = findTool(groups, selected.messageId, selected.callId);
    if (hit) {
      // Owning prompt's createdAt — needed to compute "time into turn"
      // in the drill-in header.
      const owningGroup = groups.find((g) =>
        g.responses.some((m) => m.id === selected.messageId),
      );
      return (
        <ToolDetailView
          call={hit.call}
          messageId={selected.messageId}
          time={fmtTime(hit.createdAt)}
          promptCreatedAt={owningGroup?.prompt.createdAt}
          onBack={() => setSelected(null)}
          onSendPrompt={onSendPrompt}
          sendBusy={sendBusy}
          onAfterSend={() => {
            // Close the drill-in so the user lands on the timeline
            // and can watch the assistant message stream in. The
            // parent's onAfterSend may also switch tabs.
            setSelected(null);
            onAfterSend?.();
          }}
        />
      );
    }
  }

  if (groups.length === 0 && liveEnhancements.length === 0 && resolvedEnhancements.length === 0) {
    return (
      <EmptyState
        icon="bolt"
        title="No actions yet"
        body="Type a prompt below to start a conversation. The agent's actions will appear here as they run."
      />
    );
  }

  // Unified timeline: turns + resolved enhancement cards interleaved
  // by createdAt. Live enhancements pin to the bottom regardless of
  // timestamp so the active action surface is always reachable
  // without scrolling.
  type TimelineItem =
    | { kind: 'turn'; createdAt: number; group: TurnGroup; isLast: boolean }
    | { kind: 'enhancement'; createdAt: number; enhancement: Enhancement }
    | { kind: 'compaction'; createdAt: number; marker: CompactionMarker };
  const timeline: TimelineItem[] = [
    ...groups.map((g, i) => ({
      kind: 'turn' as const,
      createdAt: g.prompt.createdAt,
      group: g,
      isLast: i === groups.length - 1,
    })),
    ...resolvedEnhancements.map((e) => ({
      kind: 'enhancement' as const,
      createdAt: e.createdAt,
      enhancement: e,
    })),
    ...compactionMarkers.map((marker) => ({
      kind: 'compaction' as const,
      createdAt: marker.ts,
      marker,
    })),
  ].sort((a, b) => a.createdAt - b.createdAt);

  // `isLatest` = the item is the most recent thing in the activity
  // timeline. Live enhancement cards always live at the bottom, so
  // when one is present every prior item (turns + resolved cards)
  // loses its "latest" flag. The live card itself stays open
  // regardless of the flag (PromptEnhancementCard handles that).
  const liveLatestId =
    liveEnhancements.length > 0
      ? liveEnhancements[liveEnhancements.length - 1].id
      : null;
  const lastTimelineIdx = timeline.length - 1;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto custom-scrollbar"
    >
      <div className="flex flex-col gap-4 w-full pt-4 px-4 pb-6">
        {timeline.map((item, idx) => {
          const isLatestInTimeline =
            liveLatestId === null && idx === lastTimelineIdx;
          if (item.kind === 'compaction') {
            return <CompactionMarkerRow key={`compaction-${item.marker.ts}`} marker={item.marker} />;
          }
          if (item.kind === 'turn') {
            return (
              <Turn
                key={item.group.prompt.id}
                prompt={item.group.prompt}
                responses={item.group.responses}
                onSelectTool={(messageId, callId) =>
                  setSelected({ kind: 'tool', messageId, callId })
                }
                onSelectTrace={(turnId) =>
                  setSelected({ kind: 'trace', turnId })
                }
                isLatest={isLatestInTimeline}
              />
            );
          }
          return (
            <PromptEnhancementCard
              key={item.enhancement.id}
              enhancement={item.enhancement}
              onApprove={onApproveEnhancement ?? (() => {})}
              onEdit={onEditEnhancement ?? (() => {})}
              onDiscard={onDiscardEnhancement ?? (() => {})}
              {...(onRetryEnhancement ? { onRetry: onRetryEnhancement } : {})}
              approveBusy={!!sendBusy}
              isLatest={isLatestInTimeline}
            />
          );
        })}
        {liveEnhancements.map((e) => (
          <PromptEnhancementCard
            key={e.id}
            enhancement={e}
            onApprove={onApproveEnhancement ?? (() => {})}
            onEdit={onEditEnhancement ?? (() => {})}
            onDiscard={onDiscardEnhancement ?? (() => {})}
            {...(onRetryEnhancement ? { onRetry: onRetryEnhancement } : {})}
            approveBusy={!!sendBusy}
            isLatest
          />
        ))}
      </div>
    </div>
  );
}


/**
 * Compaction event in the feed — visible, read-only, collapsible
 * (plans/context-compaction-redesign.md; Claude-Code-style). Collapsed:
 * a one-line receipt. Expanded: the summary that IS the agent's memory
 * of everything before the boundary — if it forgot something that
 * matters, say so in your next message.
 */
function CompactionMarkerRow({ marker }: { marker: CompactionMarker }) {
  const saved = Math.max(0, marker.beforeTokens - marker.afterTokens);
  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  return (
    <details className="my-2 rounded-md border border-[#2a2a35] bg-[#15151d] text-[12px]">
      <summary className="cursor-pointer select-none px-3 py-2 font-mono text-slate-gray hover:text-soft-white flex items-center gap-2">
        <span className="material-symbols-outlined text-[14px]">compress</span>
        <span>
          compacted · {fmt(marker.beforeTokens)} → {fmt(marker.afterTokens)} (−{fmt(saved)}) ·{' '}
          {marker.source === 'model' ? 'written by the model' : 'mechanical fallback'}
        </span>
      </summary>
      <div className="border-t border-[#2a2a35] px-3 py-2 whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-slate-gray max-h-72 overflow-y-auto">
        {marker.summaryText}
      </div>
    </details>
  );
}
