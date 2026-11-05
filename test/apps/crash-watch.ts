/**
 * The crash watch for app scenarios. A scenario fails on a step that throws,
 * and also on a crash nothing asserted on:
 *
 * - pages: `weberror`, which Playwright raises for an uncaught exception or
 *   unhandled rejection in a page or one of its dedicated workers, and a
 *   renderer `crash`;
 * - shared workers and service workers, read over CDP (crash-targets.ts);
 * - app processes: every uncaught error printed in their output
 *   (crash-output.ts), and a process the scenario started to run until
 *   stopped that exited on its own with a non-zero code and printed none.
 *
 * A scenario that provokes one on purpose exports `expectedCrashes` from its
 * scenario.ts: each entry matches a crash by its message and its source, and
 * says why the scenario provokes it. An entry that matches nothing in a
 * passing run fails it, so the list cannot outlive what it describes.
 */
import type { BrowserContext, Page, WebError } from '@playwright/test';
import { findProcessCrashes } from './crash-output.ts';
import { watchWorkerTargets, type TargetCrash } from './crash-targets.ts';

/** One crash the watch saw. */
export interface Crash {
  /** What happened, such as "page error" or "uncaught exception". */
  kind: string;
  /** Where: `page <url>`, `shared worker <url>`, `service worker <url>`, or the app process's name. */
  source: string;
  /** The step that was running when a page or worker crash was seen; empty for one read from a process's output. */
  step: string;
  /** The error's first line. */
  message: string;
  /** The lines after the message, as printed. */
  stack: string[];
}

/** A crash a scenario provokes on purpose, declared in its scenario.ts's `expectedCrashes`. */
export interface ExpectedCrash {
  /** Matches the crash's message. */
  message: RegExp;
  /** Matches the crash's source: `page <url>`, `shared worker <url>`, `service worker <url>`, or a process name such as `dev server`. */
  source: RegExp;
  /** Why the scenario provokes it, in one line. */
  reason: string;
}

/** One app process, as the driver recorded it. */
export interface WatchedProcess {
  name: string;
  output: string;
  /** The non-zero code it exited with on its own, for a process started to run until the scenario stops it. */
  earlyExitCode?: number;
}

/** What a run's crashes and its `expectedCrashes` came to. */
export interface CrashVerdict {
  unexpected: Crash[];
  /** Entries that matched no crash. */
  unmatched: ExpectedCrash[];
}

const STACK_LINES_SHOWN = 6;
const EXIT_OUTPUT_LINES = 5;

function splitError(text: string): { message: string; stack: string[] } {
  const [message = '', ...stack] = text.split('\n');
  return { message, stack };
}

function pageSource(page: Pick<Page, 'url'> | null): string {
  return page ? `page ${page.url()}` : 'page (closed)';
}

function webErrorSource(webError: WebError): string {
  const where = webError.location?.();
  const script = where?.url ? ` (at ${where.url}:${where.line})` : '';
  return `${pageSource(webError.page())}${script}`;
}

/** The last lines a process printed, for a process that exited without printing a crash. */
function lastLines(output: string): string[] {
  return output.trimEnd().split('\n').slice(-EXIT_OUTPUT_LINES);
}

/** The crashes in one process: what its output printed, or else its early non-zero exit. */
function processCrashes(child: WatchedProcess): Crash[] {
  const printed = findProcessCrashes(child.output).map((crash) => ({ ...crash, source: child.name, step: '' }));
  if (printed.length > 0 || child.earlyExitCode === undefined) return printed;
  const message = `exited with code ${child.earlyExitCode} before the scenario stopped it`;
  return [{ kind: 'process exited early', source: child.name, step: '', message, stack: lastLines(child.output) }];
}

/** What is wrong with a scenario's `expectedCrashes`, one line each. */
export function checkExpectedCrashes(entries: unknown): string[] {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return ['expectedCrashes is not an array'];
  return entries.flatMap((entry: Partial<ExpectedCrash>, index) => {
    const problems: string[] = [];
    for (const field of ['message', 'source'] as const) {
      const pattern = entry[field];
      if (!(pattern instanceof RegExp)) problems.push(`expectedCrashes[${index}].${field} is not a RegExp`);
      // A g or y pattern keeps lastIndex between tests, so it matches every other crash.
      else if (pattern.global || pattern.sticky) problems.push(`expectedCrashes[${index}].${field} ${pattern} has the ${pattern.flags.replace(/[^gy]/g, '')} flag`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') problems.push(`expectedCrashes[${index}] has no reason`);
    return problems;
  });
}

/** Records the crashes of one app run's pages and workers, and reads its processes for more. */
export class CrashWatch {
  private readonly seen: Crash[] = [];

  /** `currentStep` names the step running when a page or worker reports a crash. */
  constructor(
    private readonly currentStep: () => string,
    /** Starts the CDP watch of a context's shared and service workers; tests pass a stand-in. */
    private readonly watchWorkers: (context: BrowserContext, record: (crash: TargetCrash) => void) => Promise<void> = watchWorkerTargets,
  ) {}

  /** Watches every page and worker `context` has now and opens later. */
  async watchContext(context: BrowserContext): Promise<void> {
    context.on('weberror', (webError) => {
      const error = webError.error();
      this.record({ kind: 'page error', source: webErrorSource(webError), ...splitError(error.stack || `${error.name}: ${error.message}`) });
    });
    context.on('page', (page) => this.watchPage(page));
    for (const page of context.pages()) this.watchPage(page);
    await this.watchWorkers(context, (crash) => this.record(crash));
  }

  private watchPage(page: Page): void {
    page.on('crash', () => this.record({ kind: 'page crash', source: pageSource(page), message: "the page's renderer crashed", stack: [] }));
  }

  private record(crash: Omit<Crash, 'step'>): void {
    this.seen.push({ ...crash, step: this.currentStep() });
  }

  /** Every crash in the pages, the workers, and `processes` that no `expected` entry matches, and the entries nothing matched. */
  verdict(expected: readonly ExpectedCrash[], processes: readonly WatchedProcess[]): CrashVerdict {
    const all = [...this.seen, ...processes.flatMap(processCrashes)];
    const matched = new Set<ExpectedCrash>();
    const unexpected = all.filter((crash) => {
      const entry = expected.find((candidate) => candidate.message.test(crash.message) && candidate.source.test(crash.source));
      if (entry) matched.add(entry);
      return entry === undefined;
    });
    return { unexpected, unmatched: expected.filter((entry) => !matched.has(entry)) };
  }
}

function describeCrash(crash: Crash): string {
  const during = crash.step ? `, during "${crash.step}"` : '';
  const shown = crash.stack.slice(0, STACK_LINES_SHOWN).map((line) => `    ${line.trim()}`);
  const more = crash.stack.length > STACK_LINES_SHOWN ? [`    ... ${crash.stack.length - STACK_LINES_SHOWN} more lines`] : [];
  return [`- ${crash.kind} in ${crash.source}${during}: ${crash.message}`, ...shown, ...more].join('\n');
}

/** The failure text for a verdict: what crashed, where, and the head of each stack; then each entry that matched nothing. */
export function describeVerdict({ unexpected, unmatched }: CrashVerdict): string {
  const lines: string[] = [];
  if (unexpected.length > 0) {
    lines.push(`${unexpected.length === 1 ? '1 crash' : `${unexpected.length} crashes`} the scenario did not expect:`, ...unexpected.map(describeCrash));
    lines.push('A crash the scenario provokes on purpose goes in its scenario.ts `expectedCrashes`, with a message pattern, a source pattern, and a reason.');
  }
  if (unmatched.length > 0) {
    lines.push(`${unmatched.length === 1 ? '1 expectedCrashes entry' : `${unmatched.length} expectedCrashes entries`} matched no crash; remove each or fix its patterns:`);
    lines.push(...unmatched.map((entry) => `- message ${entry.message}, source ${entry.source} (${entry.reason})`));
  }
  return lines.join('\n');
}

/** Whether a verdict fails the run. */
export function isFailing(verdict: CrashVerdict): boolean {
  return verdict.unexpected.length > 0 || verdict.unmatched.length > 0;
}
