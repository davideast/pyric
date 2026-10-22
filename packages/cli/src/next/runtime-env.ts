/**
 * Augment Next.js configuration environment variables to pass Pyric runtime
 * options (such as chip state) down into browser client builds.
 */
import type { NextConfigObject, PyricNextOptions } from './types.js';
import { runtimeChipMetaValue } from '../serve/runtime/chip-config.js';
import { resolveSandboxTargetUrl } from './target-url.js';

/** The launcher's page selection, or undefined when it names another host than `targetUrl`. */
function launcherWorkerInit(targetUrl: string): string | undefined {
  const workerInit = process.env.PYRIC_WORKER_INIT;
  const launcherHost = process.env.PYRIC_WORKER_INIT_HOST?.replace(/\/$/, '');
  const namesTarget = launcherHost === targetUrl;
  return namesTarget ? workerInit : undefined;
}

export function augmentRuntimeEnv(config: NextConfigObject, options?: PyricNextOptions): NextConfigObject {
  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const existingEnv = updatedConfig.env !== undefined ? Object.assign({}, updatedConfig.env) : {};

  const targetUrl = resolveSandboxTargetUrl(options);
  const studioUrl = `${targetUrl}/__pyric/ui/studio`;
  existingEnv.NEXT_PUBLIC_PYRIC_STUDIO_URL = studioUrl;
  existingEnv.PYRIC_STUDIO_URL = studioUrl;

  if (options?.runtimeChip !== undefined) {
    const chipValue = runtimeChipMetaValue(options.runtimeChip);
    // Next.js only inlines `.env`-sourced values into the browser bundle when the
    // key carries the `NEXT_PUBLIC_` prefix, so client components must read the
    // prefixed name. The unprefixed name is kept for backwards compatibility with
    // any existing server-side or bundler-level readers of `PYRIC_RUNTIME_CHIP`.
    existingEnv.NEXT_PUBLIC_PYRIC_RUNTIME_CHIP = chipValue;
    existingEnv.PYRIC_RUNTIME_CHIP = chipValue;
  }

  // Next serves the page, so no stamp reaches its HTML. The launcher's
  // selection is inlined instead (serve/entries/bundled-worker-init.ts), when
  // it names the host the rewrites reach.
  const workerInit = launcherWorkerInit(targetUrl);
  if (workerInit !== undefined) existingEnv.NEXT_PUBLIC_PYRIC_WORKER_INIT = workerInit;

  updatedConfig.env = existingEnv;
  return updatedConfig;
}
