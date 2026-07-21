import { nextId, rpcWithTimeout, subscribeRuntimeReload } from './core.js';
import type { ClientDb } from './handles.js';

/** Ask the current SharedWorker to drain accepted work and retire. */
export async function retireWorkerRuntime(
  db: ClientDb,
  targetEpoch: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  await rpcWithTimeout(
    db.port,
    { t: 'op', id: nextId(), method: 'retireRuntime', targetEpoch },
    timeoutMs,
    `Timed out waiting for the Pyric worker to retire after ${timeoutMs}ms.`,
  );
}

/** Observe the worker's all-pages reload signal. */
export function onWorkerRuntimeReload(listener: (epoch: string) => void): () => void {
  return subscribeRuntimeReload((message) => listener(message.epoch));
}
