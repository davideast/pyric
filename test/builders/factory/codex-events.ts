/**
 * How a Codex session ended, from what the harness saw: whether it stopped
 * the session itself, how the process exited, Codex's JSON event stream,
 * and the forwarder's channel record.
 *
 * `codex exec --json` prints one event per line (`thread.started`,
 * `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`). Out
 * of usage, Codex prints an `error` and a `turn.failed` whose message says
 * "You've hit your usage limit", with the reset only as local wall-clock
 * text. A 429 it gave up retrying ends with "exceeded retry limit, last
 * status: 429". The forwarder saw the 429 itself and recorded its reset
 * (`codex-rate-limit.ts`), so the reset comes from the record.
 */
import { z } from 'zod';
import type { CodexChannelEvent } from './codex-forwarder.ts';
import type { EndedBy } from './session.ts';

const eventSchema = z.object({
  type: z.string(),
  message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

export type CodexEvent = z.infer<typeof eventSchema>;

/** The events in Codex's stdout; a line that is not an event is left out. */
export function parseEvents(text: string): CodexEvent[] {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    try {
      const parsed = eventSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

const USAGE_LIMIT = /usage limit|last status: 429|too many requests/i;

const failureText = (event: CodexEvent) => event.message ?? event.error?.message ?? '';

/** Whether Codex reported running out of usage, or a 429 it gave up on. */
export function reportsUsageLimit(events: readonly CodexEvent[]): boolean {
  return events.some((event) => (event.type === 'error' || event.type === 'turn.failed') && USAGE_LIMIT.test(failureText(event)));
}

/** The forwarded requests that came back 429, oldest first. */
const limitLines = (channel: readonly CodexChannelEvent[]) => channel.filter((event) => event.action === 'forwarded' && event.rateLimit?.limitReached === true);

/** The reset the latest 429 named, when one did. */
export function latestReset(channel: readonly CodexChannelEvent[]): string | undefined {
  return limitLines(channel).at(-1)?.rateLimit?.resetAt ?? undefined;
}

/** Whether the last request the forwarder passed on came back 429. */
function lastForwardHitLimit(channel: readonly CodexChannelEvent[]): boolean {
  const forwarded = channel.filter((event) => event.action === 'forwarded');
  return forwarded.at(-1)?.rateLimit?.limitReached === true;
}

export interface SessionFacts {
  /** Why the harness stopped the session, when it did. */
  stoppedBy: 'deadline' | 'killed' | null;
  /** The exit code, null when a signal ended the process. */
  code: number | null;
  signal: NodeJS.Signals | null;
  events: readonly CodexEvent[];
  channel: readonly CodexChannelEvent[];
}

export interface SessionEnd {
  endedBy: EndedBy;
  resetAt?: string;
}

/**
 * How the session ended. The harness's own stop wins; then a usage limit,
 * when the session failed and Codex said so or its last request came back
 * 429; then a signal no one in the harness sent; otherwise its exit.
 */
export function sessionEnd(facts: SessionFacts): SessionEnd {
  if (facts.stoppedBy !== null) return { endedBy: facts.stoppedBy };
  const failed = facts.code !== 0;
  const hitLimit = failed && (reportsUsageLimit(facts.events) || lastForwardHitLimit(facts.channel));
  if (hitLimit) {
    const resetAt = latestReset(facts.channel);
    return resetAt === undefined ? { endedBy: 'rate-limit' } : { endedBy: 'rate-limit', resetAt };
  }
  if (facts.signal !== null) return { endedBy: 'killed' };
  return { endedBy: 'exit' };
}
