/**
 * What Codex's output says about how a session ended, for the generic
 * `../../session-end.ts`.
 *
 * `codex exec --json` prints one event per line (`thread.started`,
 * `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`). Out
 * of usage, Codex prints an `error` and a `turn.failed` whose message says
 * "You've hit your usage limit", with the reset only as local wall-clock
 * text. A 429 it gave up retrying ends with "exceeded retry limit, last
 * status: 429". The forwarder saw the 429 itself and recorded its reset
 * (`rate-limit.ts`), so the reset comes from the record.
 */
import { z } from 'zod';

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
