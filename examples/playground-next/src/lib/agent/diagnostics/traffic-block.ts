/**
 * Traffic-log skill block. Teaches the agent WHEN to call
 * `inspect_firestore_traffic` — the full-session traffic dump tool.
 *
 * The block is intentionally light on data. It does NOT inline traffic
 * stats every turn (the ring buffer is up to 5000 entries — way too
 * much for a prompt) and it does NOT duplicate the recent-denials
 * inline list that `denials-block` already provides. It surfaces:
 *
 *   - A counter of how much traffic is captured (so the agent knows
 *     there's something to query — silent during quiet sessions).
 *   - A nudge on WHEN to call the tool: after a user interaction in
 *     the preview produced unexpected denials, before proposing a
 *     rules change, when listener cascades are suspected, etc.
 *
 * Pyric-specific. Off-by-default for stock providers; on when
 * `pyricDiagnosticsEnabled` is true (master gate handled by the
 * caller in `buildSystemPrompt`).
 */
import { useRuntimeStore } from '~/lib/store/runtime';
import type { PromptBlock } from './index';

/** Below this many captured entries we skip the block entirely — the
 *  agent doesn't need to think about a tool that has nothing to query.
 *  At zero traffic the recent-denials block would also be empty so
 *  this is consistent: silence until there's data. */
const MIN_FOR_NUDGE = 1;

export const trafficBlock: PromptBlock = {
  heading: 'SANDBOX TRAFFIC LOG (full-session)',
  render() {
    const traffic = useRuntimeStore.getState().traffic;
    if (traffic.length < MIN_FOR_NUDGE) return null;

    // Quick decision breakdown for context. Cheap (single pass over
    // the ring buffer) and small to render (three counts).
    let allow = 0;
    let deny = 0;
    let unsupported = 0;
    for (const t of traffic) {
      if (t.result === 'allow') allow++;
      else if (t.result === 'deny') deny++;
      else if (t.result === 'unsupported') unsupported++;
    }

    const lines: string[] = [];
    lines.push(
      `${traffic.length} op${traffic.length === 1 ? '' : 's'} captured this session — ${allow} allow, ${deny} deny, ${unsupported} unsupported.`,
    );
    lines.push(
      'Query the full trail with `inspect_firestore_traffic` (`{ decision: "deny" }` to pattern-spot, `{ pathPrefix }` before a rules change, `{ origin: "listener" }` for suspected cascades); for ONE denial prefer `inspect_denial({ path? })`. Detail: `man diagnostics`.',
    );
    return lines.join('\n');
  },
};
