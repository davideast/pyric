import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  bundleWorker,
  workerSourceHash,
  type WorkerBundleOptions,
  type WorkerBundleResult,
} from './bundler.js';

export interface ViteWorkerRuntimeStatus {
  sdkDir: string;
  ready: boolean;
  epoch: string | null;
}

export interface ViteWorkerRuntime {
  prepare(): Promise<void>;
  status(): ViteWorkerRuntimeStatus;
  headTag(marker: string): string;
}

interface ViteWorkerRuntimeOptions {
  cacheRoot?: string;
  cacheKey?: string;
  bundle?: (options: WorkerBundleOptions) => Promise<WorkerBundleResult>;
}

/** Own the Vite plugin's worker build state and its one HTML projection. */
export function createViteWorkerRuntime(
  options: ViteWorkerRuntimeOptions = {},
): ViteWorkerRuntime {
  const cacheRoot = options.cacheRoot ?? join(homedir(), '.pyric', 'vite-worker');
  const cacheKey = options.cacheKey ?? workerSourceHash();
  const sdkDir = join(cacheRoot, cacheKey);
  const bundle = options.bundle ?? bundleWorker;
  let current: ViteWorkerRuntimeStatus = { sdkDir, ready: false, epoch: null };

  return {
    async prepare() {
      current = { sdkDir, ready: false, epoch: null };
      const result = await bundle({ outDir: sdkDir });
      current = { sdkDir, ready: true, epoch: result.epoch };
    },
    status: () => current,
    headTag(marker) {
      return current.ready && current.epoch
        ? `<meta name="pyric-worker-v" content="${current.epoch}" ${marker}>`
        : `<script ${marker}>globalThis.__PYRIC_FORCE_INPAGE__=true;</script>`;
    },
  };
}
