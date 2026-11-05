/**
 * The crash watch for app scenarios. A scenario fails on a step that throws,
 * and also on a crash nothing asserted on: an uncaught exception or unhandled
 * rejection in a page or one of its workers, a renderer crash, or an
 * uncaught error in an app process's output that comes from Pyric's code.
 *
 * Pages: every page of the app's browser context reports `weberror` (which
 * Playwright raises for uncaught exceptions and unhandled rejections in a
 * page and its dedicated workers) and `crash`. Service workers get an
 * `error` and `unhandledrejection` listener that reports through the
 * worker's console. Playwright does not expose shared workers, so their
 * errors go unseen here.
 *
 * Processes: the forms Node and Pyric print. Node prints an uncaught
 * exception or unhandled rejection that ends a process as a stack followed
 * by a `Node.js v<version>` line. `pyric sandbox` keeps serving after one
 * and prints `✖ pyric sandbox: uncaught exception. The server was kept
 * alive.` (packages/cli/src/cli/serve.ts), the functions host prints
 * `functions uncaught exception, kept serving:`
 * (packages/cli/src/functions/http/report.ts), and the host's request
 * handler prints `✖ 500 <url>: <message>` for a request it threw on
 * (packages/cli/src/serve/server.ts).
 *
 * A scenario that provokes one of these on purpose exports
 * `expectedCrashes` from its scenario.ts: each entry matches a crash by its
 * message and its source, and says why the scenario provokes it.
 */
import type { BrowserContext, Page, WebError, Worker } from '@playwright/test';

/** One crash the watch saw. */
export interface Crash {
  /** What happened, such as "page error" or "uncaught exception". */
  kind: string;
  /** Where: `page <url>`, `service worker <url>`, or the app process's name. */
  source: string;
  /** The step that was running when a page crash was seen; empty for one read from a process's output. */
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
  /** Matches the crash's source: `page <url>`, `service worker <url>`, or a process name such as `dev server`. */
  source: RegExp;
  /** Why the scenario provokes it, in one line. */
  reason: string;
}

/** The output of one app process, as the driver recorded it. */
export interface WatchedOutput {
  name: string;
  output: string;
}

/** Marks a service worker's error report in its console output. */
export const WORKER_REPORT_MARKER = '[pyric crash watch] ';

const STACK_LINES_SHOWN = 6;

/** A path inside one of Pyric's installed packages. */
const PYRIC_FRAME = /node_modules\/(?:@pyric\/[^/\s]+|pyric|pyric-admin|create-pyric)\//;
const STACK_FRAME = /^\s*at\s/;
const NODE_VERSION_LINE = /^Node\.js v\d+\.\d+\.\d+/;
const CARET_LINE = /^\s*\^+\s*$/;
const SANDBOX_GUARD = /✖ pyric sandbox: (unhandled rejection|uncaught exception)\. The server was kept alive/;
const FUNCTIONS_UNCAUGHT = /functions uncaught exception, kept serving: (.*)$/;
const HANDLER_THREW = /^\s*✖ 500 (\S+): (.*)$/;

/** Splits an error's printed text into its first line and the rest. */
function splitError(text: string): { message: string; stack: string[] } {
  const [message = '', ...stack] = text.split('\n');
  return { message, stack };
}

/**
 * A stack from Pyric's own code: one of its frames, or no frames at all,
 * such as a rejection with a string reason, which cannot say whose it is.
 */
function isPyricStack(lines: readonly string[]): boolean {
  const frames = lines.filter((line) => STACK_FRAME.test(line));
  const hasNoFrames = frames.length === 0;
  return hasNoFrames || lines.some((line) => PYRIC_FRAME.test(line));
}

type FoundCrash = Omit<Crash, 'source' | 'step'>;

/** The indented lines after `start`, which hold a stack. */
function indentedAfter(lines: readonly string[], start: number, indent: RegExp): string[] {
  const block: string[] = [];
  for (let index = start + 1; index < lines.length && indent.test(lines[index]!); index += 1) block.push(lines[index]!.trim());
  return block;
}

/** The error Node printed before a `Node.js v<version>` line at `end`. */
function nodeFatalError(lines: readonly string[], end: number): FoundCrash {
  let caret = -1;
  for (let index = end - 1; index >= Math.max(0, end - 80); index -= 1) {
    if (CARET_LINE.test(lines[index]!)) { caret = index; break; }
  }
  const header = caret >= 2 ? lines.slice(caret - 2, caret) : [];
  const start = caret >= 0 ? caret + 1 : Math.max(0, end - 20);
  const body = lines.slice(start, end).filter((line) => line.trim() !== '');
  const isRejection = header.some((line) => line.includes('fromPromise')) || body.some((line) => line.includes('UnhandledPromiseRejection'));
  const [message = '(no message)', ...stack] = body;
  return { kind: isRejection ? 'unhandled rejection' : 'uncaught exception', message, stack: [...stack, ...header.map((line) => `thrown at ${line.trim()}`)] };
}

/** Each uncaught error from Pyric's code in one process's output. */
export function findProcessCrashes(output: string): FoundCrash[] {
  const lines = output.split('\n');
  const found: FoundCrash[] = [];
  for (const [index, line] of lines.entries()) {
    const guard = line.match(SANDBOX_GUARD);
    if (guard) {
      const { message, stack } = splitError(indentedAfter(lines, index, /^\s{4}/).join('\n'));
      found.push({ kind: `pyric sandbox ${guard[1]}`, message, stack });
      continue;
    }
    const functions = line.match(FUNCTIONS_UNCAUGHT);
    if (functions) {
      const stack = indentedAfter(lines, index, STACK_FRAME);
      if (isPyricStack(stack)) found.push({ kind: 'functions uncaught exception', message: functions[1]!, stack });
      continue;
    }
    const threw = line.match(HANDLER_THREW);
    if (threw) {
      found.push({ kind: 'host request handler threw', message: threw[2]!, stack: [`request ${threw[1]}`] });
      continue;
    }
    if (NODE_VERSION_LINE.test(line)) {
      const fatal = nodeFatalError(lines, index);
      if (isPyricStack([fatal.message, ...fatal.stack])) found.push(fatal);
    }
  }
  return found;
}

/** Reads a service worker's error report from one of its console lines. */
export function readWorkerReport(text: string): FoundCrash | undefined {
  if (!text.startsWith(WORKER_REPORT_MARKER)) return undefined;
  try {
    const report = JSON.parse(text.slice(WORKER_REPORT_MARKER.length)) as { kind?: unknown; stack?: unknown; message?: unknown };
    const printed = typeof report.stack === 'string' && report.stack !== '' ? report.stack : String(report.message);
    return { kind: `service worker ${String(report.kind)}`, ...splitError(printed) };
  } catch {
    return { kind: 'service worker error', message: text.slice(WORKER_REPORT_MARKER.length), stack: [] };
  }
}

/** Runs inside a service worker: reports its uncaught errors and unhandled rejections on its console. */
function installWorkerReports(marker: string): void {
  const report = (kind: string, error: unknown): void => {
    const isError = error instanceof Error;
    console.error(marker + JSON.stringify({ kind, message: isError ? error.message : String(error), stack: isError ? error.stack ?? '' : '' }));
  };
  const scope = globalThis as unknown as EventTarget;
  scope.addEventListener('error', (event) => {
    const { error, message } = event as Event & { error?: unknown; message?: string };
    report('uncaught exception', error ?? message);
  });
  scope.addEventListener('unhandledrejection', (event) => report('unhandled rejection', (event as Event & { reason?: unknown }).reason));
}

function pageSource(page: Pick<Page, 'url'> | null): string {
  return page ? `page ${page.url()}` : 'page (closed)';
}

function webErrorSource(webError: WebError): string {
  const where = webError.location?.();
  const script = where?.url ? ` (at ${where.url}:${where.line})` : '';
  return `${pageSource(webError.page())}${script}`;
}

function isExpected(crash: Crash, expected: readonly ExpectedCrash[]): boolean {
  return expected.some((entry) => entry.message.test(crash.message) && entry.source.test(crash.source));
}

/** Records the crashes of one app run's pages and workers, and reads its processes' output for more. */
export class CrashWatch {
  private readonly seen: Crash[] = [];

  /** `currentStep` names the step running when a page reports a crash. */
  constructor(private readonly currentStep: () => string) {}

  /** The crashes pages and workers reported so far. */
  get pageCrashes(): readonly Crash[] {
    return this.seen;
  }

  /** Watches every page and service worker `context` has now and opens later. */
  watchContext(context: BrowserContext): void {
    context.on('weberror', (webError) => {
      const { message, stack } = splitError(webError.error().stack || `${webError.error().name}: ${webError.error().message}`);
      this.record({ kind: 'page error', source: webErrorSource(webError), message, stack });
    });
    context.on('page', (page) => this.watchPage(page));
    context.on('serviceworker', (worker) => void this.watchServiceWorker(worker));
    for (const page of context.pages()) this.watchPage(page);
    for (const worker of context.serviceWorkers()) void this.watchServiceWorker(worker);
  }

  private watchPage(page: Page): void {
    page.on('crash', () => this.record({ kind: 'page crash', source: pageSource(page), message: "the page's renderer crashed", stack: [] }));
  }

  private async watchServiceWorker(worker: Worker): Promise<void> {
    const source = `service worker ${worker.url()}`;
    worker.on('console', (message) => {
      const report = readWorkerReport(message.text());
      if (report) this.record({ ...report, source });
    });
    // A worker that stops before this runs has nothing more to report.
    await worker.evaluate(installWorkerReports, WORKER_REPORT_MARKER).catch(() => {});
  }

  private record(crash: Omit<Crash, 'step'>): void {
    this.seen.push({ ...crash, step: this.currentStep() });
  }

  /** Every crash in the pages, the workers, and `processes`' output that no `expected` entry matches. */
  unexpected(expected: readonly ExpectedCrash[], processes: readonly WatchedOutput[]): Crash[] {
    const fromOutput = processes.flatMap((child) => findProcessCrashes(child.output).map((crash) => ({ ...crash, source: child.name, step: '' })));
    return [...this.seen, ...fromOutput].filter((crash) => !isExpected(crash, expected));
  }
}

/** The failure text for `crashes`: what crashed, where, and the head of each stack. */
export function describeCrashes(crashes: readonly Crash[]): string {
  const count = crashes.length === 1 ? '1 crash' : `${crashes.length} crashes`;
  const entries = crashes.map((crash) => {
    const during = crash.step ? `, during "${crash.step}"` : '';
    const shown = crash.stack.slice(0, STACK_LINES_SHOWN).map((line) => `    ${line.trim()}`);
    const more = crash.stack.length > STACK_LINES_SHOWN ? [`    ... ${crash.stack.length - STACK_LINES_SHOWN} more lines`] : [];
    return [`- ${crash.kind} in ${crash.source}${during}: ${crash.message}`, ...shown, ...more].join('\n');
  });
  const hint = 'A crash the scenario provokes on purpose goes in its scenario.ts `expectedCrashes`, with a message pattern, a source pattern, and a reason.';
  return [`${count} the scenario did not expect:`, ...entries, hint].join('\n');
}
