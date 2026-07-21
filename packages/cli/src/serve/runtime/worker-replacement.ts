interface WorkerReplacementOptions {
  targetEpoch: string;
  retire(): Promise<void>;
  subscribeReload(listener: (epoch: string) => void): () => void;
  preflight(): void;
  commitGeneration(epoch: string): void;
  onPreparationError?(error: unknown): void;
  reload(): void;
  schedule?: (run: () => void) => void;
}

export interface WorkerReplacement {
  request(): Promise<void>;
  dispose(): void;
}

/** Coordinate one reload per page after the old SharedWorker announces retirement. */
export function createWorkerReplacement(options: WorkerReplacementOptions): WorkerReplacement {
  const schedule = options.schedule ?? ((run) => { setTimeout(run, 100); });
  let reloadScheduled = false;
  const unsubscribe = options.subscribeReload((epoch) => {
    if (reloadScheduled) return;
    try {
      options.commitGeneration(epoch);
    } catch (error) {
      options.onPreparationError?.(error);
      return;
    }
    reloadScheduled = true;
    schedule(options.reload);
  });
  return {
    async request() {
      // Verify that this page can persist the successor before asking the old
      // worker to retire, but do not publish that successor until the worker
      // announces that its drain and capture barrier completed.
      options.preflight();
      await options.retire();
    },
    dispose: unsubscribe,
  };
}
