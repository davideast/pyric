/**
 * How an agent session ended, from what the harness saw: whether it stopped
 * the session itself, how the process exited, whether the agent's output
 * says it hit the upstream rate limit (`AgentAdapter.reportsRateLimit`), and this
 * session's lines of the forwarder's channel record. Agents print a reset,
 * when at all, only as local wall-clock text; the forwarder read the 429
 * itself (`UpstreamPolicy.rateLimitOf`), so the reset comes from the record.
 */
import type { EndedBy } from './session.ts';
import type { UpstreamEvent } from './upstream-forwarder.ts';

/** The forwarded requests that came back 429, oldest first. */
const limitLines = (channel: readonly UpstreamEvent[]) => channel.filter((event) => event.action === 'forwarded' && event.rateLimit?.limitReached === true);

/** The reset the latest 429 named, when one did. */
export function latestReset(channel: readonly UpstreamEvent[]): string | undefined {
  return limitLines(channel).at(-1)?.rateLimit?.resetAt ?? undefined;
}

/** Whether the last request the forwarder passed on came back 429. */
function lastForwardHitLimit(channel: readonly UpstreamEvent[]): boolean {
  const forwarded = channel.filter((event) => event.action === 'forwarded');
  return forwarded.at(-1)?.rateLimit?.limitReached === true;
}

export interface SessionFacts {
  /** Why the harness stopped the session, when it did. */
  stoppedBy: 'deadline' | 'killed' | null;
  /** The exit code, null when a signal ended the process. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Whether the agent's output says it hit the upstream rate limit. */
  reportsRateLimit: boolean;
  channel: readonly UpstreamEvent[];
}

export interface SessionEnd {
  endedBy: EndedBy;
  resetAt?: string;
}

/**
 * How the session ended. The harness's own stop wins; then a rate limit,
 * when the session failed and the agent said so or its last request came
 * back 429; then a signal no one in the harness sent; otherwise its exit.
 */
export function sessionEnd(facts: SessionFacts): SessionEnd {
  if (facts.stoppedBy !== null) return { endedBy: facts.stoppedBy };
  const failed = facts.code !== 0;
  const hitLimit = failed && (facts.reportsRateLimit || lastForwardHitLimit(facts.channel));
  if (hitLimit) {
    const resetAt = latestReset(facts.channel);
    return resetAt === undefined ? { endedBy: 'rate-limit' } : { endedBy: 'rate-limit', resetAt };
  }
  if (facts.signal !== null) return { endedBy: 'killed' };
  return { endedBy: 'exit' };
}
