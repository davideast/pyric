import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  bundleWorker,
  workerSourceHash,
  type WorkerBundleOptions,
  type WorkerBundleResult,
} from './bundler.js';
import { disposeSaltedWorkerDir, markSaltedWorkerDir } from './bundle-cache-evict.js';

export interface ViteWorkerRuntimeStatus {
  sdkDir: string;
  ready: boolean;
  epoch: string | null;
}

export interface ViteWorkerRuntime {
  prepare(epochSalt?: string): Promise<void>;
  status(): ViteWorkerRuntimeStatus;
  headTag(marker: string): string;
  dispose?(): void;
}

interface ViteWorkerRuntimeOptions {
  cacheRoot?: string;
  cacheKey?: string;
  bundle?: (options: WorkerBundleOptions) => Promise<WorkerBundleResult>;
  allowCustomRootForTesting?: boolean;
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
      let sdkDir = defaultSdkDir;
      if (epochSalt !== undefined && epochSalt.length > 0) {
        const saltDigest = createHash('sha256').update(epochSalt).digest('hex').slice(0, 12);
        sdkDir = join(cacheRoot, `${cacheKey}-${saltDigest}`);
      }
      current = { sdkDir, ready: false, epoch: null };
      const bundleOptions: WorkerBundleOptions = { outDir: sdkDir, evictCache: true };
      if (epochSalt !== undefined && epochSalt.length > 0) {
        bundleOptions.epochSalt = epochSalt;
      }
      const result = await bundle(bundleOptions);
      if (epochSalt !== undefined && epochSalt.length > 0) {
        markSaltedWorkerDir(sdkDir, epochSalt);
      }
      current = { sdkDir, ready: true, epoch: result.epoch };
    },
    status: () => current,
    headTag(marker) {
      if (current.ready && current.epoch !== null) {
        return `<meta name="pyric-worker-v" content="${current.epoch}" ${marker}>`;
      }
      return `<script ${marker}>globalThis.__PYRIC_FORCE_INPAGE__=true;</script>`;
    },
    dispose() {
      const activeDir = current.sdkDir;
      current = { sdkDir: defaultSdkDir, ready: false, epoch: null };
      if (activeDir === defaultSdkDir) {
        return;
      }
      disposeSaltedWorkerDir(activeDir, options.allowCustomRootForTesting);
    },
  };
}
