/**
 * Copies one installed `node_modules` tree, for `copyTree` in copy-tree.ts.
 * It runs in a worker thread: `cpSync` copies a 374 MB tree in about 1.5 s,
 * and in a worker it does not stall the apps already running on the runner's
 * event loop.
 *
 * The result is written atomically to `resultFile` before it is posted, so a
 * parent that sees the worker exit without its message can tell a copy that
 * ended from a worker that never ran it.
 */
import { cpSync, renameSync, writeFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { from, to, resultFile } = workerData as { from: string; to: string; resultFile: string };
let result: { ok: boolean; message?: string };
try {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  result = { ok: true };
} catch (error) {
  let message: string;
  if (error instanceof Error) message = error.message;
  else message = String(error);
  result = { ok: false, message };
}
const tempFile = `${resultFile}.tmp`;
writeFileSync(tempFile, JSON.stringify(result));
renameSync(tempFile, resultFile);
parentPort?.postMessage(result);
