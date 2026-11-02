/**
 * The supervisor's view of the work list. When the file exists but doesn't
 * parse, a session may be part-way through writing it: the reader keeps the
 * last list it read, logs the problem once, and asks to read again shortly,
 * rather than treating the list as empty and starting the lead to plan.
 */
import { readWorkList, type WorkItem } from './work-list.ts';

export const WORK_LIST_RETRY_MS = 2_000;

export class WorkListReader {
  private lastGood: WorkItem[] = [];
  private failingSince: number | undefined;

  constructor(private readonly path: string, private readonly log: (line: string) => void) {}

  read(now: number): WorkItem[] {
    const result = readWorkList(this.path);
    if (result.ok) {
      this.lastGood = result.items;
      this.failingSince = undefined;
      return result.items;
    }
    if (this.failingSince === undefined) this.log(`${this.path} is unreadable (${result.errors.join('; ')}); keeping the last list read`);
    this.failingSince ??= now;
    return this.lastGood;
  }

  /** When to read again, while the file is unreadable. */
  retryAt(now: number): number | undefined {
    if (this.failingSince === undefined) return undefined;
    return now + WORK_LIST_RETRY_MS;
  }
}
