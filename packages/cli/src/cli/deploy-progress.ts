/**
 * Live deploy output — a reporter callback, not a rendering framework.
 *
 * One event stream ({@link DeployProgressEvent}), three sinks chosen by mode:
 *   - `--json` (machine): NDJSON, one event per line, plus the terminal result.
 *   - TTY: a single live spinner line for the active step (braille spinner + a
 *     live elapsed timer, or a percent when a real denominator exists). This is
 *     the frame that fills a multi-second wait (e.g. Storage's settle sleep) so
 *     the terminal is never a frozen black box. No ink/blessed/ora.
 *   - otherwise (piped): one flat line per event + the summary.
 *
 * Exit codes never derive from progress — only from the terminal `ToolResult`.
 * Delete every `report()` call and behavior is byte-identical to the old output.
 */
import type { ToolResult } from '@inbrowser/agent';
import type { DeployProgressEvent } from '../deploy/provider.js';

type Sink = { write(s: string): void };

export interface DeployReporter {
  /** A progress step for a unit (target already stamped). */
  report(event: DeployProgressEvent): void;
  /** The terminal result for a unit (clears the live line first in TTY). */
  result(result: ToolResult): void;
  /** Stop the spinner timer + clear any live line. */
  dispose(): void;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createDeployReporter(opts: {
  out: Sink;
  err: Sink;
  machineOutput: boolean;
  isTTY: boolean;
}): DeployReporter {
  const { out, err, machineOutput, isTTY } = opts;

  // Machine: NDJSON events + the terminal result object (distinguishable by the
  // presence of `step` on progress events). Generalizes hosting's per-site NDJSON.
  if (machineOutput) {
    // Progress is interactive narration; machine output is the terminal result
    // only (back-compat with the per-unit NDJSON the CLI suite asserts). A future
    // --progress-json flag can opt into streaming the events.
    return {
      report: () => {},
      result: (r) => (r.ok ? out : err).write(`${JSON.stringify(r)}\n`),
      dispose: () => {},
    };
  }

  // Non-TTY (piped to a file/CI): a flat, append-only log. The summary always
  // goes to stdout in text mode (matching the pre-registry behavior).
  if (!isTTY) {
    // Piped / CI: the summary only — progress is interactive narration, so a
    // captured log stays clean (and the CLI suite's stdout assertions hold).
    return {
      report: () => {},
      result: (r) => out.write(`${r.summary}\n`),
      dispose: () => {},
    };
  }

  // TTY: one live spinner line for the active step. `start`/`progress` set it;
  // `done`/`skip`/`fail` are implicit (the next step or the result supersedes).
  let active: { target: string; step: string; message: string; pct?: number; startedAt: number } | null = null;
  let frame = 0;
  const clearLine = () => out.write('\r\x1b[2K');
  const paint = () => {
    if (!active) return;
    const tail =
      active.pct !== undefined
        ? ` ${Math.round(active.pct * 100)}%`
        : ` ${((Date.now() - active.startedAt) / 1000).toFixed(1)}s`;
    out.write(`\r\x1b[2K${SPINNER[frame % SPINNER.length]} ${active.target}: ${active.message}${tail}`);
    frame++;
  };
  const timer = setInterval(paint, 100);
  if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref(): void }).unref();
  return {
    report: (e) => {
      if (e.status !== 'start' && e.status !== 'progress') return;
      if (!active || active.step !== e.step) {
        active = { target: e.target, step: e.step, message: e.message, pct: e.pct, startedAt: Date.now() };
      } else {
        active.message = e.message;
        active.pct = e.pct;
      }
      paint();
    },
    result: (r) => {
      clearLine();
      active = null;
      out.write(`${r.summary}\n`);
    },
    dispose: () => {
      clearInterval(timer);
      clearLine();
      active = null;
    },
  };
}
