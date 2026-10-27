/**
 * Copies one installed `node_modules` tree, for `copyTree` in
 * shared-installs.ts. It runs in a worker thread: `cpSync` copies a 374 MB
 * tree in about 1.5 s, and in a worker it does not stall the apps already
 * running on the runner's event loop.
 */
import { cpSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { from, to } = workerData as { from: string; to: string };
try {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
