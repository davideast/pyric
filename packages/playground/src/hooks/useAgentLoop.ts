/**
 * `useAgentLoop` — owns the submit / stop side of `ComposeBar`.
 *
 * One path: append the user message + a streaming-assistant
 * placeholder, then run `runOneTurn` from `session-host/` — the full
 * AgentSession (tools, strategy, metrics, live token streaming).
 *
 * The inference transport — page-direct `fallback`, or the resumable
 * `server` stream when `resumableServerMode` is on — is chosen inside
 * `createInference()`'s dispatch, transparently to this hook; the
 * AgentSession tool loop runs unchanged either way. See
 * inference/index.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { runOneTurn } from '~/lib/session-host';
import { isSessionWriter } from '~/lib/sessions/writer-lock';
import { PROVIDERS } from '~/lib/llm/registry';
import { SERVER_CAPABLE_PROVIDERS } from '~/lib/llm/inference';
import { useChatStore } from '~/lib/store/chat';
import { useLlmStore } from '~/lib/store/llm';
import { useSettingsStore } from '~/lib/store/settings';

/** A dropped-connection error from a page-direct fetch (the browser's
 *  wording varies: Chrome "Failed to fetch", Safari "Load failed",
 *  Firefox "NetworkError…"). */
function isNetworkDropError(msg: string): boolean {
  return /failed to fetch|load failed|networkerror|err_network|err_internet/i.test(msg);
}

/** Make a network-drop failure actionable: say what happened and — when a
 *  resumable path exists but wasn't active — how to get on it. */
function describeTurnError(msg: string): string {
  if (!isNetworkDropError(msg)) return msg;
  const providerId = useLlmStore.getState().providerId;
  const serverCapable = SERVER_CAPABLE_PROVIDERS.has(providerId);
  const serverMode = useSettingsStore.getState().resumableServerMode;
  if (serverCapable && !serverMode) {
    return (
      `${msg} — the connection dropped mid-turn (often a backgrounded tab). ` +
      'Enable "Resumable server mode" in Settings so turns keep running ' +
      'server-side and reconnect automatically.'
    );
  }
  if (!serverCapable) {
    return (
      `${msg} — the connection dropped mid-turn. This provider runs ` +
      'page-direct (no resumable server path), so the turn could not be resumed.'
    );
  }
  return `${msg} — the connection dropped mid-turn and could not be resumed.`;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface UseAgentLoopResult {
  sending: boolean;
  error: string | null;
  send(prompt: string): Promise<void>;
  stop(): void;
}

export function useAgentLoop(): UseAgentLoopResult {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const patchMessage = useChatStore((s) => s.patchMessage);
  const patchToolCall = useChatStore((s) => s.patchToolCall);

  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (prompt: string) => {
      if (!prompt.trim()) return;
      // Writer-lock gate — agent turns must not run in a read-only
      // tab (the session is open in another tab that holds the
      // writer lock). One check here covers every entry point:
      // compose bar, suggestions, fix-request, pending prompt.
      if (!isSessionWriter()) {
        setError('This session is open in another tab. Use "Take over" in the banner to continue here.');
        return;
      }
      // Semaphore — only one in-flight turn at a time. We check
      // `abortRef` (non-null while a turn is mid-flight) rather than
      // the `sending` state so the closure sees fresh status across
      // renders without living in the useCallback deps.
      if (abortRef.current) return;
      const userId = makeId('u');
      const asstId = makeId('a');
      const now = Date.now();
      // Capture the active provider/model at submit time so the
      // resulting message's identity row reflects what actually ran.
      const llm = useLlmStore.getState();
      const provider = PROVIDERS[llm.providerId];
      const modelDef = provider.models.find((m) => m.id === llm.modelId);
      const providerLabel = provider.label;
      const modelLabel = modelDef?.label ?? llm.modelId;

      appendMessage({ id: userId, role: 'user', text: prompt, createdAt: now });
      appendMessage({
        id: asstId,
        role: 'assistant',
        text: '',
        createdAt: now,
        streaming: true,
        providerLabel,
        modelLabel,
      });

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setSending(true);
      setError(null);

      try {
        await runOneTurn(prompt, asstId, userId, {
          signal: ctrl.signal,
          appendMessage,
          patchMessage,
          patchToolCall,
        });
        const tail = useChatStore.getState().messages.at(-1);
        if (tail?.streaming) patchMessage(tail.id, { streaming: false });
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = describeTurnError(rawMsg);
        const tail = useChatStore.getState().messages.at(-1);
        if (tail?.role === 'assistant') {
          patchMessage(tail.id, {
            text: tail.text || `_(${msg})_`,
            streaming: false,
            // A network-drop death leaves the turn incomplete mid-loop —
            // mark it so the ResumeTurnBanner offers a one-tap
            // continuation instead of only a dead red bar. Provider/user
            // errors don't get the marker: resuming wouldn't help.
            ...(isNetworkDropError(rawMsg)
              ? { interrupted: { toolCallsPending: true } }
              : {}),
          });
        }
        setError(msg);
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        setSending(false);
      }
    },
    [appendMessage, patchMessage, patchToolCall],
  );

  return { sending, error, send, stop };
}
