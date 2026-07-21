import { PYRIC_WORKER_NAME } from './manifest.js';

export const PYRIC_WORKER_GENERATION_KEY = 'pyric:worker-generation';
const PYRIC_WORKER_GENERATION_PROBE_KEY = 'pyric:worker-generation-probe';

interface EpochStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Select the replacement generation only after this page was told to move. */
export function workerNameForEpoch(
  _servedEpoch: string | null,
  storage: EpochStorage | undefined,
): string {
  if (!storage) return PYRIC_WORKER_NAME;
  try {
    const generation = storage.getItem(PYRIC_WORKER_GENERATION_KEY);
    return generation && /^[a-f0-9]{16}$/.test(generation)
      ? `${PYRIC_WORKER_NAME}:${generation}`
      : PYRIC_WORKER_NAME;
  } catch {
    return PYRIC_WORKER_NAME;
  }
}

/** Persist the generation boundary before a page reloads. */
export function rememberWorkerEpoch(
  epoch: string,
  storage: EpochStorage | undefined,
): void {
  if (!/^[a-f0-9]{16}$/.test(epoch)) {
    throw new Error('Pyric cannot replace the worker: invalid served worker epoch.');
  }
  if (!storage) {
    throw new Error(
      'Pyric cannot replace the worker because origin storage is unavailable. Close all tabs for this origin and reopen the app.',
    );
  }
  try {
    storage.setItem(PYRIC_WORKER_GENERATION_KEY, epoch);
    if (storage.getItem(PYRIC_WORKER_GENERATION_KEY) !== epoch) {
      throw new Error('the worker generation could not be read back');
    }
  } catch (cause) {
    throw new Error(
      'Pyric cannot replace the worker because origin storage is unavailable. Close all tabs for this origin and reopen the app.',
      { cause },
    );
  }
}

/** Prove origin storage works without publishing a successor generation. */
export function preflightWorkerEpochStorage(storage: EpochStorage | undefined): void {
  if (!storage?.removeItem) {
    throw new Error(
      'Pyric cannot replace the worker because origin storage is unavailable. Close all tabs for this origin and reopen the app.',
    );
  }
  try {
    const previousProbe = storage.getItem(PYRIC_WORKER_GENERATION_PROBE_KEY);
    storage.setItem(PYRIC_WORKER_GENERATION_PROBE_KEY, 'ok');
    if (storage.getItem(PYRIC_WORKER_GENERATION_PROBE_KEY) !== 'ok') {
      throw new Error('the worker generation probe could not be read back');
    }
    if (previousProbe === null) storage.removeItem(PYRIC_WORKER_GENERATION_PROBE_KEY);
    else storage.setItem(PYRIC_WORKER_GENERATION_PROBE_KEY, previousProbe);
  } catch (cause) {
    throw new Error(
      'Pyric cannot replace the worker because origin storage is unavailable. Close all tabs for this origin and reopen the app.',
      { cause },
    );
  }
}
