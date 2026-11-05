/**
 * Reads the uncaught errors an app process printed. These are the forms Node,
 * Next.js, and Pyric print:
 *
 * - Node, for an uncaught exception or unhandled rejection that ends the
 *   process: the throw site, a caret, the error and its stack, then a
 *   `Node.js v<version>` line. A rejection's throw site is
 *   `triggerUncaughtException(err, true /* fromPromise *\/)`.
 * - Next.js dev servers keep running and print `⨯ uncaughtException: <err>`
 *   (next/dist/server/lib/router-server.js) and `⨯ unhandledRejection: <err>`
 *   (next/dist/server/node-environment-extensions/process-error-handlers.js).
 * - `pyric sandbox` keeps serving and prints `✖ pyric sandbox: uncaught
 *   exception. The server was kept alive.` (packages/cli/src/cli/serve.ts).
 * - The functions host prints `functions uncaught exception, kept serving:`
 *   (packages/cli/src/functions/http/report.ts).
 * - The host's request handler prints `✖ 500 <url>: <message>` for a request
 *   it threw on (packages/cli/src/serve/server.ts).
 *
 * Every one counts, whoever's frames are on the stack: after an `await`, a
 * Pyric bug that returns the wrong shape crashes in the app's own code.
 */

/** One uncaught error in a process's output. */
export interface OutputCrash {
  kind: string;
  message: string;
  stack: string[];
}

const STACK_FRAME = /^\s*at\s/;
const NODE_VERSION_LINE = /^Node\.js v\d+\.\d+\.\d+/;
const CARET_LINE = /^\s*\^+\s*$/;
const SANDBOX_GUARD = /✖ pyric sandbox: (unhandled rejection|uncaught exception)\. The server was kept alive/;
const FUNCTIONS_UNCAUGHT = /functions uncaught exception, kept serving: (.*)$/;
const NEXT_UNCAUGHT = /^\s*(?:⨯\s*)?(uncaughtException|unhandledRejection):\s+(.*)$/;
const HANDLER_THREW = /^\s*✖ 500 (\S+): (.*)$/;
/** How far back from `Node.js v<version>` the throw site's caret can be. */
const CARET_SEARCH_LINES = 80;

function splitError(text: string): { message: string; stack: string[] } {
  const [message = '', ...stack] = text.split('\n');
  return { message, stack };
}

/** The lines after `start` that match `pattern`, trimmed. */
function linesAfter(lines: readonly string[], start: number, pattern: RegExp): string[] {
  const block: string[] = [];
  for (let index = start + 1; index < lines.length && pattern.test(lines[index]!); index += 1) block.push(lines[index]!.trim());
  return block;
}

/** The error Node printed before a `Node.js v<version>` line at `end`. */
function nodeFatalError(lines: readonly string[], end: number): OutputCrash {
  let caret = -1;
  for (let index = end - 1; index >= Math.max(0, end - CARET_SEARCH_LINES); index -= 1) {
    if (CARET_LINE.test(lines[index]!)) { caret = index; break; }
  }
  const throwSite = caret >= 2 ? lines.slice(caret - 2, caret) : [];
  const start = caret >= 0 ? caret + 1 : Math.max(0, end - 20);
  const body = lines.slice(start, end).filter((line) => line.trim() !== '');
  const isFromPromise = throwSite.some((line) => line.includes('fromPromise'));
  const isRejection = isFromPromise || body.some((line) => line.includes('UnhandledPromiseRejection') || line.includes('ERR_UNHANDLED_REJECTION'));
  const [message = '(no message)', ...stack] = body;
  const site = isFromPromise ? [] : throwSite.map((line) => `thrown at ${line.trim()}`);
  return { kind: isRejection ? 'unhandled rejection' : 'uncaught exception', message, stack: [...stack, ...site] };
}

/** One crash that starts at `lines[index]`, if one does. */
function crashAt(lines: readonly string[], index: number): OutputCrash | undefined {
  const line = lines[index]!;
  const guard = line.match(SANDBOX_GUARD);
  if (guard) return { kind: `pyric sandbox ${guard[1]}`, ...splitError(linesAfter(lines, index, /^\s{4}/).join('\n')) };
  const functions = line.match(FUNCTIONS_UNCAUGHT);
  if (functions) return { kind: 'functions uncaught exception', message: functions[1]!, stack: linesAfter(lines, index, STACK_FRAME) };
  const next = line.match(NEXT_UNCAUGHT);
  if (next) {
    const kind = next[1] === 'unhandledRejection' ? 'Next.js unhandled rejection' : 'Next.js uncaught exception';
    return { kind, message: next[2]!, stack: linesAfter(lines, index, STACK_FRAME) };
  }
  const threw = line.match(HANDLER_THREW);
  if (threw) return { kind: 'host request handler threw', message: threw[2]!, stack: [`request ${threw[1]}`] };
  if (NODE_VERSION_LINE.test(line)) return nodeFatalError(lines, index);
  return undefined;
}

/** Each uncaught error in one process's output. */
export function findProcessCrashes(output: string): OutputCrash[] {
  const lines = output.split('\n');
  return lines.flatMap((_, index) => crashAt(lines, index) ?? []);
}
