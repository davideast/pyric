/**
 * Transient handoff for the home page's first prompt.
 *
 * The home page creates a session with an empty conversation, then
 * navigates to `/playground?session={id}`. The workspace needs to fire
 * the agent loop with the user's prompt — but it can't pre-seed the
 * `conversation` array of the saved session, because hydration would
 * render the user message without ever triggering the agent loop
 * (which is what appends the streaming assistant placeholder + runs
 * `runOneTurn`). The user would see their prompt sitting in chat
 * history with no reply and have to manually type "build it" to
 * kick things off.
 *
 * Instead, the prompt is stashed under a session-scoped sessionStorage
 * key. The workspace reads it after hydration completes, clears it
 * (so a reload doesn't re-fire), and either calls
 * `agentLoop.send(prompt)` directly OR routes it through the prompt
 * enhancer first depending on the stashed `mode`.
 *
 * sessionStorage rather than localStorage: scoped to the tab,
 * disappears on close, doesn't survive a hard reload — exactly what
 * we want for a one-shot handoff.
 */

const PENDING_PROMPT_PREFIX = 'pyric:pending-prompt:';

/** Action the workspace should take with the stashed prompt. */
export type PendingPromptMode = 'send' | 'enhance';

export interface PendingPrompt {
  prompt: string;
  mode: PendingPromptMode;
}

function key(sessionId: string): string {
  return `${PENDING_PROMPT_PREFIX}${sessionId}`;
}

export function stashPendingPrompt(
  sessionId: string,
  prompt: string,
  mode: PendingPromptMode = 'send',
): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: PendingPrompt = { prompt, mode };
    window.sessionStorage.setItem(key(sessionId), JSON.stringify(payload));
  } catch (e) {
    console.warn('[pending-prompt] stash failed:', e);
  }
}

/**
 * Pop the pending prompt for `sessionId`. Returns the prompt + mode
 * and clears it from storage, so a subsequent reload doesn't re-fire
 * the agent loop. Returns `null` when no prompt is pending (e.g., when
 * the user opened a session card rather than starting a fresh one).
 *
 * Tolerates the legacy raw-string format that an earlier revision of
 * this module wrote — bare strings are read back as `{ prompt, mode:
 * 'send' }`. Stash payloads have been short-lived (session scope) for
 * a while; the legacy path is mostly defensive in case a tab survived
 * an HMR reload mid-rollout.
 */
export function takePendingPrompt(sessionId: string): PendingPrompt | null {
  if (typeof window === 'undefined') return null;
  const k = key(sessionId);
  try {
    const raw = window.sessionStorage.getItem(k);
    if (raw === null) return null;
    window.sessionStorage.removeItem(k);
    try {
      const parsed = JSON.parse(raw) as Partial<PendingPrompt>;
      if (typeof parsed.prompt === 'string' && parsed.prompt.length > 0) {
        return {
          prompt: parsed.prompt,
          mode: parsed.mode === 'enhance' ? 'enhance' : 'send',
        };
      }
      return null;
    } catch {
      // Pre-mode revision wrote a raw string. Treat as send.
      return { prompt: raw, mode: 'send' };
    }
  } catch (e) {
    console.warn('[pending-prompt] take failed:', e);
    return null;
  }
}
