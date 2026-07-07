/**
 * Reattach — recover the rest of an interrupted server-mode response
 * after a page reload / mobile tab discard.
 *
 * While a server-mode request streams, the session host stamps the
 * streaming assistant message with `activeJob: { jobId, seq: 0 }`
 * (persisted by session autosave). If the page dies mid-request the
 * stamp survives; on next session load `recoverInterruptedJobs` tails
 * the job's durable log from seq 0 and appends the MISSING SUFFIX of
 * the response to the message (overlap-dedup against the text already
 * rendered before the drop), then clears the stamp.
 *
 * Scope (v1, honest limits): this recovers the remaining TEXT of the
 * one in-flight model response — the agent LOOP itself died with the
 * page, so any tool calls in the recovered tail did not and will not
 * run. When the tail contains tool calls, the recovered message says
 * so and invites a re-prompt. Within a live (non-reloaded) page, drops
 * are handled upstream by the resumable client's reconnect-and-replay
 * and never reach this module.
 */
import type { ModelEvent as RelayModelEvent } from '@inbrowser/relay';
import { useChatStore } from '~/lib/store/chat';
import { pullWorkspaceFromBridge } from '../claude-workspace-sync';
import {
  inferenceAuthHeaders,
  jobStreamUrl,
  modelEventToInferenceEvent,
  resolveApiBase,
} from './index';
import { logPage } from './diagnostics';

/** Overall safety valve — a still-running job streams live and this
 *  keeps appending; a wedged connection gets cut here. */
const RECOVERY_TIMEOUT_MS = 10 * 60_000;

/** Scan the loaded conversation for interrupted server-mode requests
 *  and recover each (in practice: zero or one). Fire-and-forget from
 *  session load; every failure degrades to "clear the stamp + note". */
export async function recoverInterruptedJobs(): Promise<void> {
  const candidates = useChatStore
    .getState()
    .messages.filter((m) => m.role === 'assistant' && m.activeJob);
  for (const msg of candidates) {
    try {
      await recoverOne(msg.id);
    } catch (e) {
      logPage('reattach_failed', undefined, {
        messageId: msg.id,
        error: e instanceof Error ? e.message : String(e),
      });
      annotate(msg.id, 'its resumable stream could not be recovered');
    }
  }
}

async function recoverOne(messageId: string): Promise<void> {
  const msg = useChatStore.getState().messages.find((m) => m.id === messageId);
  const jobId = msg?.activeJob?.jobId;
  if (!msg || !jobId) return;
  const baseText = msg.text;
  const isClaudeJob = msg.activeJob?.provider === 'claude';

  // Claude-lane jobs run on the SAME-ORIGIN relay (the Agent SDK lives
  // on the owner's machine, never the Cloud Function) — mirror
  // `serverBaseFor` in ./index.ts.
  const base = isClaudeJob ? '' : await resolveApiBase();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RECOVERY_TIMEOUT_MS);
  let res: Response;
  try {
    // Carry the inference auth token (#766) — the Cloud Function's gate
    // requires it when configured. No-op for same-origin Claude jobs.
    res = await fetch(jobStreamUrl(base, jobId, 0), {
      signal: abort.signal,
      headers: inferenceAuthHeaders(),
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  if (res.status === 404) {
    clearTimeout(timer);
    annotate(messageId, 'its resumable stream expired before it could be recovered');
    return;
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    annotate(messageId, `its resumable stream returned ${res.status}`);
    return;
  }

  // Replay the full response from seq 0; accumulate its text and note
  // any tool calls in the tail we cannot run.
  let fullText = '';
  let sawToolCall = false;
  let sawDone = false;
  try {
    for await (const payload of sseDataLines(res.body)) {
      if (payload === '[DONE]') {
        sawDone = true;
        break;
      }
      let raw: RelayModelEvent;
      try {
        raw = JSON.parse(payload) as RelayModelEvent;
      } catch {
        continue; // tolerate a malformed frame
      }
      const ev = modelEventToInferenceEvent(raw);
      if (ev.kind === 'text') fullText += ev.chunk;
      else if (ev.kind === 'tool_call') sawToolCall = true;
    }
  } finally {
    clearTimeout(timer);
  }

  // Overlap-dedup: the message already ends with whatever part of this
  // response streamed in before the drop — append only what's missing.
  const overlap = longestPrefixSuffixOverlap(fullText, baseText);
  const suffix = fullText.slice(overlap);

  const notes: string[] = [];
  if (suffix) notes.push('recovered the rest of this reply from the resumable stream after a page reload');
  else notes.push('this reply was interrupted by a page reload; its resumable stream had nothing further');
  if (sawToolCall) notes.push('its remaining tool calls did not run');
  if (!sawDone) notes.push('recovery ended before the stream finished');

  // Claude-lane job: the turn's tool loop ran INSIDE the server-side
  // agent against the server workspace — the reload killed only the
  // viewer. Pull the workspace so the recovered turn's file changes
  // actually land in the files panel/preview. Best-effort: the text
  // recovery above is still worth keeping if the pull fails.
  let workspacePulled = false;
  if (isClaudeJob) {
    try {
      await pullWorkspaceFromBridge();
      workspacePulled = true;
      notes.push('pulled its workspace changes from the server');
    } catch {
      notes.push('its server workspace changes could not be pulled — re-prompt to retry');
    }
  }

  const note = `\n\n_(${notes.join('; ')})_`;
  // Turn incomplete (unrun tool calls, or the stream never finished) →
  // mark it so the UI offers an interactive "Resume turn".
  const incomplete = sawToolCall || !sawDone;

  logPage('reattach_recovered', undefined, {
    jobId,
    recoveredChars: suffix.length,
    sawToolCall,
    sawDone,
    ...(isClaudeJob ? { claudeWorkspacePulled: workspacePulled } : {}),
  });

  const current = useChatStore.getState().messages.find((m) => m.id === messageId);
  if (!current) return;
  useChatStore.getState().patchMessage(messageId, {
    text: baseText + suffix + note,
    // The interleaved renderer prefers textChunks when present — append
    // the recovered tail there too so it actually displays.
    ...(current.textChunks
      ? { textChunks: [...current.textChunks, { text: suffix + note, ts: Date.now() }] }
      : {}),
    streaming: false,
    activeJob: undefined,
    ...(incomplete ? { interrupted: { toolCallsPending: sawToolCall } } : {}),
  });
}

/** Clear the stamp and leave an honest one-line note on the message. */
function annotate(messageId: string, reason: string): void {
  const msg = useChatStore.getState().messages.find((m) => m.id === messageId);
  if (!msg) return;
  const note = `\n\n_(this reply was interrupted by a page reload; ${reason})_`;
  useChatStore.getState().patchMessage(messageId, {
    text: msg.text + note,
    ...(msg.textChunks ? { textChunks: [...msg.textChunks, { text: note, ts: Date.now() }] } : {}),
    streaming: false,
    activeJob: undefined,
    // Recovery failed outright — the turn is definitely incomplete.
    interrupted: { toolCallsPending: true },
  });
}

/** Longest k such that `haystackTail` ends with the first k chars of
 *  `replay` — i.e. how much of the replayed response is already on the
 *  message. Linear scan from the largest plausible k down. */
function longestPrefixSuffixOverlap(replay: string, haystackTail: string): number {
  const max = Math.min(replay.length, haystackTail.length);
  for (let k = max; k > 0; k--) {
    if (haystackTail.endsWith(replay.slice(0, k))) return k;
  }
  return 0;
}

/** Minimal SSE reader: yields each `data:` payload line. */
async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
    }
  } finally {
    reader.releaseLock();
  }
}
