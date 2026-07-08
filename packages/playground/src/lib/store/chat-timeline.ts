/**
 * Chronological assistant-turn timeline — interleaves thinking,
 * tool calls, and text in emission order.
 */
import type { ChatMessage, TextChunk, ThinkingChunk, ToolCall } from '~/lib/store/chat';

export type TimelineItem =
  | { kind: 'thinking'; ts: number; text: string; live?: boolean }
  | { kind: 'tool'; ts: number; call: ToolCall }
  | { kind: 'text'; ts: number; text: string };

export interface BuildTimelineOptions {
  streaming?: boolean;
}

function sumChunkLen(chunks: readonly { text: string }[]): number {
  return chunks.reduce((a, c) => a + c.text.length, 0);
}

/** Reconstruct thinking segment deltas from cumulative `thinkingUpToHere`
 *  snapshots on older messages that predate `thinkingChunks`. */
function deriveLegacyThinkingSegments(
  calls: readonly ToolCall[],
  wholeThinking: string | undefined,
): ThinkingChunk[] {
  const segments: ThinkingChunk[] = [];
  let prevLen = 0;
  for (const call of calls) {
    const full = call.thinkingUpToHere ?? '';
    const delta = full.slice(prevLen);
    if (delta.length > 0) {
      segments.push({ text: delta, ts: (call.emittedAt ?? 0) - 1 });
    }
    prevLen = full.length;
  }
  const tail = (wholeThinking ?? '').slice(prevLen);
  if (tail.length > 0) {
    segments.push({ text: tail, ts: (calls.at(-1)?.emittedAt ?? Date.now()) + 1 });
  }
  return segments;
}

function resolveThinkingChunks(message: ChatMessage): ThinkingChunk[] {
  const stored = message.thinkingChunks ?? [];
  if (stored.length > 0) return stored;
  const calls = message.toolCalls ?? [];
  if (calls.some((c) => c.thinkingUpToHere)) {
    return deriveLegacyThinkingSegments(calls, message.thinking);
  }
  // No tool boundaries yet — while streaming, the live tail owns
  // in-flight reasoning; after completion, one chunk is enough.
  if (message.thinking?.trim() && calls.length === 0) {
    if (message.streaming) return [];
    return [{ text: message.thinking, ts: message.createdAt }];
  }
  return [];
}

/** True when the renderer should use the interleaved timeline instead
 *  of the legacy top-level thinking fold + bucketed tools. */
export function hasInterleavedTimeline(message: ChatMessage): boolean {
  const calls = message.toolCalls ?? [];
  const chunks = message.textChunks ?? [];
  const thinking = resolveThinkingChunks(message);
  if (thinking.length > 0 && calls.length > 0) return true;
  if ((message.thinking?.trim()?.length ?? 0) > 0 && calls.length > 0) return true;
  if (chunks.length > 0 && (calls.length > 0 || thinking.length > 0)) {
    return true;
  }
  if (chunks.length > 0 && calls.length > 0) return true;
  if (message.streaming && message.thinking && calls.length > 0) {
    return true;
  }
  return false;
}

export function buildAssistantTimeline(
  message: ChatMessage,
  opts: BuildTimelineOptions = {},
): TimelineItem[] | null {
  const streaming = opts.streaming ?? !!message.streaming;
  const calls = message.toolCalls ?? [];
  const textChunks = message.textChunks ?? [];
  const thinkingChunks = resolveThinkingChunks(message);

  if (
    thinkingChunks.length === 0 &&
    calls.length === 0 &&
    textChunks.length === 0
  ) {
    return null;
  }

  const items: TimelineItem[] = [];

  for (const c of thinkingChunks) {
    items.push({ kind: 'thinking', ts: c.ts, text: c.text });
  }

  for (const c of calls) {
    items.push({ kind: 'tool', ts: c.emittedAt ?? 0, call: c });
  }

  for (const c of textChunks) {
    items.push({ kind: 'text', ts: c.ts, text: c.text });
  }

  if (streaming && message.thinking) {
    const snapshotted = sumChunkLen(thinkingChunks);
    const tail = message.thinking.slice(snapshotted);
    if (tail.length > 0) {
      const afterTs = items.reduce((max, it) => Math.max(max, it.ts), message.createdAt);
      items.push({ kind: 'thinking', ts: afterTs + 1, text: tail, live: true });
    }
  }

  items.sort((a, b) => a.ts - b.ts);
  return items;
}

/** Index of the last text item — gets the REPLY chrome. */
export function lastTextTimelineIndex(timeline: TimelineItem[]): number {
  let idx = -1;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i]!.kind === 'text') idx = i;
  }
  return idx;
}

/** Thinking-only turn with no tools/text timeline activity. */
export function isThinkingOnlyTurn(message: ChatMessage): boolean {
  const timeline = buildAssistantTimeline(message, { streaming: message.streaming });
  if (!timeline) return !!message.thinking?.trim();
  return timeline.every((it) => it.kind === 'thinking');
}
