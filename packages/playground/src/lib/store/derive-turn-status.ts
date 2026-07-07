/**
 * Provider-agnostic streaming status for assistant turns.
 * Derives one-line progress copy from message state — not provider id.
 */
import type { ChatMessage } from '~/lib/store/chat';
import { toolDisplay } from '~/lib/tools/display';

export interface TurnStatus {
  label: string;
  /** When true, render the mono status strip below the stepper. */
  showStrip: boolean;
}

function inFlightTools(message: ChatMessage) {
  return (message.toolCalls ?? []).filter((c) => c.resultJson === undefined);
}

function inFlightDelegated(message: ChatMessage) {
  return (message.delegatedActivity ?? []).filter((a) => a.resultSummary === undefined);
}

/** True when the reply Markdown is intentionally hidden during stream
 *  (Claude CLI transcript noise today; extend if other lanes need it). */
export function isReplyHiddenWhileStreaming(message: ChatMessage): boolean {
  return !!message.streaming && message.providerLabel === 'Claude (local CLI)';
}

export function deriveTurnStatus(message: ChatMessage): TurnStatus | null {
  if (!message.streaming) return null;

  const thinkingLen = message.thinking?.length ?? 0;
  const hasText = (message.text?.trim().length ?? 0) > 0;
  const replyHidden = isReplyHiddenWhileStreaming(message);
  const tools = inFlightTools(message);
  const delegated = inFlightDelegated(message);

  const latestDelegated = delegated.at(-1);
  if (latestDelegated) {
    return {
      label: `${latestDelegated.summary}…`,
      showStrip: replyHidden || !hasText,
    };
  }

  const latestTool = tools.at(-1);
  if (latestTool) {
    return {
      label: `${toolDisplay(latestTool.name).humanLabel} · running…`,
      showStrip: replyHidden || !hasText,
    };
  }

  const anyActivity =
    (message.toolCalls?.length ?? 0) > 0 || (message.delegatedActivity?.length ?? 0) > 0;

  if (thinkingLen > 0 && !hasText && !anyActivity) {
    return { label: 'Reasoning…', showStrip: false };
  }

  if (replyHidden || (!hasText && anyActivity)) {
    return { label: 'Running tools…', showStrip: true };
  }

  if (!hasText && !anyActivity && thinkingLen === 0) {
    return { label: 'Starting turn…', showStrip: true };
  }

  return null;
}
