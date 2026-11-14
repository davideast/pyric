/**
 * Copies an installed `node_modules` tree into an app, in a worker thread
 * (copy-tree-worker.ts), for the shared installs (shared-installs.ts) and
 * the dependency store (dependency-store.ts).
 */
import type { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';

/** What `copyTree` needs of its worker: the events a Worker emits, and a way to end it. */
export type CopyWorker = Pick<EventEmitter, 'once'> & { terminate(): unknown };

/** Starts a worker that copies `from` to `to` and writes its result to `resultFile` before posting it. */
export type StartCopyWorker = (from: string, to: string, resultFile: string) => CopyWorker;

/** What a copy worker reports, in its message and in its result file. */
interface CopyResult {
  ok: boolean;
  message?: string;
}

/** How one copy worker ended. */
type CopyOutcome =
  | { kind: 'copied' }
  | { kind: 'failed'; message: string }
  /** It exited cleanly and left no result, so it never ran the copy to its end. */
  | { kind: 'no-result' };

/** How many workers a copy gets when each exits cleanly without a result. */
const COPY_ATTEMPTS = 2;

const startCopyTreeWorker: StartCopyWorker = (from, to, resultFile) => new Worker(new URL('./copy-tree-worker.ts', import.meta.url), { workerData: { from, to, resultFile } });

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function outcomeOf(result: CopyResult): CopyOutcome {
  if (result.ok) return { kind: 'copied' };
  return { kind: 'failed', message: result.message ?? 'unknown error' };
}

/** The result the worker wrote before it exited, or undefined when it wrote none or left a partial file. */
function writtenResult(resultFile: string): CopyResult | undefined {
  if (!existsSync(resultFile)) return undefined;
  try {
    return JSON.parse(readFileSync(resultFile, 'utf8')) as CopyResult;
  } catch {
    return undefined;
  }
}

/**
 * One worker's copy. Its message settles it. So does its exit: a non-zero
 * exit before a result (out of memory, say) fails the copy, and a clean exit
 * is read from the result file, because the exit can be handled before the
 * message it posted (#1280).
 */
function runCopyWorker(from: string, to: string, startWorker: StartCopyWorker): Promise<CopyOutcome> {
  const resultFile = `${to}.copy-result.json`;
  const tempFile = `${resultFile}.tmp`;
  rmSync(resultFile, { force: true });
  rmSync(tempFile, { force: true });
  const ended = new Promise<CopyOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CopyOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const worker = startWorker(from, to, resultFile);
    worker.once('message', (result: CopyResult) => {
      void worker.terminate();
      finish(outcomeOf(result));
    });
    worker.once('error', (error) => {
      finish({ kind: 'failed', message: errorMessage(error) });
    });
    worker.once('exit', (code: number) => {
      if (settled) return;
      const isClean = code === 0;
      if (!isClean) {
        finish({ kind: 'failed', message: `the copy worker exited with code ${code} before it finished` });
        return;
      }
      const result = writtenResult(resultFile);
      if (result === undefined) {
        finish({ kind: 'no-result' });
        return;
      }
      finish(outcomeOf(result));
    });
  });
  return ended.finally(() => {
    rmSync(resultFile, { force: true });
    rmSync(tempFile, { force: true });
  });
}

export interface CopyTreeOptions {
  startWorker?: StartCopyWorker;
  /** Gets one `[runner]` line when a copy is run again; the run's output by default. */
  report?: (line: string) => void;
}

/**
 * Copy an installed `node_modules` into an app, symlinks as symlinks, in a
 * worker thread (copy-tree-worker.ts) so the apps already running keep their
 * timers and sockets moving while it copies.
 *
 * A copy, not hard links: with hard links, every full run here had an app
 * whose server process stalled or never closed, and with copies runs passed.
 * Each app also gets files it can change without changing every other app's.
 * Not a `cp` child process either: under Bun, a burst of children exiting
 * together, as when several apps get their set's install at once, left
 * exited children unreaped, and the runner waited on one forever.
 *
 * On CI a worker has exited with code 0 moments after it started, having
 * reported nothing: the copy failed about 5 s after it began, and 5 s was
 * the wait then given to a late result. That is the runtime's failure, not
 * the copy's, so the copy gets one more worker, and the retry is reported.
 * A copy that reports an error, and a worker that exits with another code,
 * fail at once.
 */
export async function copyTree(from: string, to: string, options: CopyTreeOptions = {}): Promise<void> {
  const startWorker = options.startWorker ?? startCopyTreeWorker;
  const report = options.report ?? ((line: string) => console.log(line));
  mkdirSync(dirname(to), { recursive: true });
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
    const outcome = await runCopyWorker(from, to, startWorker);
    if (outcome.kind === 'copied') return;
    if (outcome.kind === 'failed') throw new Error(`copying ${from} to ${to} failed: ${outcome.message}`);
    const hasAttemptLeft = attempt < COPY_ATTEMPTS;
    if (!hasAttemptLeft) break;
    report(`[runner] infrastructure retry: the copy worker for ${to} exited with code 0 before it finished; copying once more`);
    await rm(to, { recursive: true, force: true });
  }
  throw new Error(`copying ${from} to ${to} failed: the copy worker exited with code 0 before it finished, on each of ${COPY_ATTEMPTS} attempts`);
}
