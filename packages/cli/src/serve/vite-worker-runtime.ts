import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
  prepare(epochSalt?: string): Promise<void>;
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
  const defaultSdkDir = join(cacheRoot, cacheKey);
  const bundle = options.bundle ?? bundleWorker;
  let current: ViteWorkerRuntimeStatus = { sdkDir: defaultSdkDir, ready: false, epoch: null };

  return {
    async prepare(epochSalt) {
      const sdkDir = epochSalt
        ? join(
            cacheRoot,
            `${cacheKey}-${createHash('sha256').update(epochSalt).digest('hex').slice(0, 12)}`,
          )
        : defaultSdkDir;
      current = { sdkDir, ready: false, epoch: null };
      const result = await bundle({ outDir: sdkDir, ...(epochSalt ? { epochSalt } : {}) });
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
