/**
 * Augment Next.js configuration environment variables to pass Pyric runtime
 * options (such as chip state) down into browser client builds.
 */
import type { NextConfigObject, PyricNextOptions } from './types.js';
import { runtimeChipMetaValue } from '../serve/runtime/chip-config.js';
import { resolveSandboxTargetUrl } from './target-url.js';

/**
 * Sanitize the launcher's transport selection before inlining it into Next.js
 * public client bundles (`NEXT_PUBLIC_PYRIC_WORKER_INIT`): never embed a
 * per-boot `sessionToken`, and redact hosted `projectKey` / `bridgeUrl` so
 * remote clients never observe raw local paths and always adopt the
 * server-selected (opaque on remote) project key from `/__pyric/init.json`.
 */
function sanitizeClientWorkerInit(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return raw;
    }
    const copy: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    delete copy.sessionToken;
    if (copy.hosted === true) {
      copy.projectKey = null;
      copy.bridgeUrl = null;
    }
    return JSON.stringify(copy);
  } catch {
    return raw;
  }
}

/** The launcher's page selection, or undefined when it names another host than `targetUrl`. */
function launcherWorkerInit(targetUrl: string): string | undefined {
  const workerInit = process.env.PYRIC_WORKER_INIT;
  const launcherHost = process.env.PYRIC_WORKER_INIT_HOST?.replace(/\/$/, '');
  const namesTarget = launcherHost === targetUrl;
  if (!namesTarget || workerInit === undefined) return undefined;
  return sanitizeClientWorkerInit(workerInit);
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
