import type { ToolCallResponse } from '../protocol.js';
import { hasValidReplyOutcome } from '../../serve/worker/outbound-validation.js';

/** Tool outcomes carry a second status and summary inside successful transport replies. */
export function hasValidToolReply(reply: ToolCallResponse): boolean {
  const isMalformedOutcome = !hasValidReplyOutcome(reply);
  if (isMalformedOutcome) return false;
  const isFailure = reply.ok === false;
  if (isFailure) return true;
  const result: unknown = reply.result;
  const isRecord = result !== null && typeof result === 'object' && !Array.isArray(result);
  return isRecord && 'ok' in result && typeof result.ok === 'boolean'
    && 'summary' in result && typeof result.summary === 'string';
}
