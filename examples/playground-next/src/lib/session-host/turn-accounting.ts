/**
 * Pure helpers for the session host's per-turn accounting. Extracted
 * from `./index.ts` so the two defects they fix stay pinned by unit
 * tests (sonnet-food session, 2026-06-10):
 *
 *   - **Metrics summation.** `@inbrowser/agent`'s ReAct strategy emits
 *     one `turn_complete` per LLM iteration, and the session forwards
 *     each as a `turn_completed` event with THAT ITERATION's usage.
 *     The host used to patch the assistant message's metrics on every
 *     event — so a 3-iteration turn that burned 60,583 + 183 output
 *     tokens reported the last iteration's 183 tokens / $0.04. The
 *     accumulator sums across iterations instead.
 *
 *   - **Prompt duplication.** The host snapshots the chat store as the
 *     session's `history`. The submit hook has ALREADY appended the
 *     user's prompt there, and `@inbrowser/agent` appends the prompt
 *     to history itself (session.js) AND the strategy appends it to
 *     the message array again (buildMessages) — a known upstream
 *     session-contract bug. Passing the prompt inside `history` too
 *     made it THREE copies on the wire. `snapshotHistoryForTurn`
 *     removes the in-flight user message (and the streaming assistant
 *     placeholder), capping the wire at the upstream two.
 */
export {
  createTurnMetricsAccumulator,
  type AggregatedTurnMetrics,
  type TurnMetricsAccumulator,
} from '@inbrowser/agent/usage';
import type { ChatMessage } from '~/lib/store/chat';

/**
 * History snapshot for `createAgentSession({ history })`. Drops the
 * streaming assistant placeholder (last message) and the in-flight
 * user message (`userMsgId`) — `@inbrowser/agent` re-adds the prompt
 * itself. Earlier turns pass through untouched.
 */
export function snapshotHistoryForTurn(
  messages: readonly ChatMessage[],
  userMsgId: string,
): ChatMessage[] {
  return messages.slice(0, -1).filter((m) => m.id !== userMsgId);
}
