import type { ClientDb } from '@pyric/cli/serve/worker';
import {
  createWorkerReplacement,
  getWorkerVersion,
  onWorkerRuntimeReload,
  preflightWorkerEpochStorage,
  rememberWorkerEpoch,
  retireWorkerRuntime,
  type WorkerReplacement,
} from '@pyric/cli/serve/worker';

interface EpochStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface StudioWorkerRuntimeSnapshot {
  servedEpoch: string | null;
  runningEpoch: string | null;
  updateAvailable: boolean;
  updating: boolean;
  error: string | null;
}

export interface StudioWorkerRuntime {
  getSnapshot(): StudioWorkerRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  update(): Promise<void>;
  dispose(): void;
}

interface StudioWorkerRuntimeOptions {
  db: ClientDb;
  servedEpoch: string | null;
  storage?: EpochStorage;
  readVersion?: () => Promise<string>;
  retire?: (epoch: string) => Promise<void>;
  subscribeReload?: (listener: (epoch: string) => void) => () => void;
  preflight?: () => void;
  remember?: (epoch: string) => void;
  reload?: () => void;
  schedule?: (run: () => void) => void;
}

/** Keep a Studio page on the same explicit worker-replacement lifecycle as the app. */
export function createStudioWorkerRuntime(
  options: StudioWorkerRuntimeOptions,
): StudioWorkerRuntime {
  const listeners = new Set<() => void>();
  let snapshot: StudioWorkerRuntimeSnapshot = {
    servedEpoch: options.servedEpoch,
    runningEpoch: null,
    updateAvailable: false,
    updating: false,
    error: null,
  };
  const publish = (patch: Partial<StudioWorkerRuntimeSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const storage = options.storage;
  const servedEpoch = options.servedEpoch;
  let replacement: WorkerReplacement | null = null;
  const ensureReplacement = (): WorkerReplacement | null => {
    if (!servedEpoch) return null;
    replacement ??= createWorkerReplacement({
      targetEpoch: servedEpoch,
      retire: () => options.retire
        ? options.retire(servedEpoch)
        : retireWorkerRuntime(options.db, servedEpoch),
      subscribeReload: options.subscribeReload ?? onWorkerRuntimeReload,
      preflight: options.preflight ?? (() => preflightWorkerEpochStorage(storage)),
      commitGeneration: options.remember ?? ((epoch) => rememberWorkerEpoch(epoch, storage)),
      onPreparationError: (error) => publish({
        updating: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      reload: options.reload ?? (() => window.location.reload()),
      ...(options.schedule ? { schedule: options.schedule } : {}),
    });
    return replacement;
  };

  void (options.readVersion ?? (() => getWorkerVersion(options.db)))()
    .then((runningEpoch) => publish({
      runningEpoch,
      updateAvailable: Boolean(
        servedEpoch
        && runningEpoch !== 'dev'
        && runningEpoch !== servedEpoch
      ),
    }))
    .catch((error) => publish({
      error: error instanceof Error ? error.message : String(error),
    }));

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      ensureReplacement();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          replacement?.dispose();
          replacement = null;
        }
      };
    },
    async update() {
      const activeReplacement = ensureReplacement();
      if (!activeReplacement || !snapshot.updateAvailable || snapshot.updating) {
        throw new Error('No Pyric worker update is available.');
      }
      publish({ updating: true, error: null });
      try {
        await activeReplacement.request();
      } catch (error) {
        publish({
          updating: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    dispose() {
      listeners.clear();
      replacement?.dispose();
      replacement = null;
    },
  };
}
