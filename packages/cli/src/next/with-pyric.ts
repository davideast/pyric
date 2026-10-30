/**
 * Core execution coordinator for the Next.js `withPyric` configuration wrapper.
 */
import type { NextConfig, NextConfigFunction, NextConfigObject, PyricNextOptions } from './types.js';
import { enforceSandboxGuard, isProductionPassthrough } from './guard.js';
import { augmentServerExternalPackages } from './server-external-packages.js';
import { augmentWebpackConfig } from './webpack-config.js';
import { augmentTurbopackConfig } from './turbopack-config.js';
import { augmentDevRewrites } from './dev-rewrites.js';
import { augmentRuntimeEnv } from './runtime-env.js';
import { findEdgeRuntimeFiles, formatEdgeRuntimeWarning } from './edge-runtime.js';
import { callingConfigDir } from './config-dir.js';
import { NET_GUARD_GLOBAL, type NetGuard } from '../register/net-guard.js';

const DEV_SERVER_PHASE = 'phase-development-server';
const DEV_GUARD_REASON = 'withPyric runs the Next dev server, which defaults to PYRIC_GUARD=block (#1443)';

function isFunctionConfig(config: NextConfig): config is NextConfigFunction {
  return typeof config === 'function';
}

function warnAboutEdgeRuntime(): void {
  const warning = formatEdgeRuntimeWarning(findEdgeRuntimeFiles(process.cwd()));
  if (warning !== null) {
    console.warn(warning);
  }
}

/**
 * The Next dev server defaults the network guard to `block` (#1443), as the
 * Vite dev server does (`serve/vite-net-guard.ts`): inside a framework dev
 * server pyric's plugin wraps, nothing is meant to reach live Firebase except
 * allowlisted hosts, and a missed import looks swapped to its author. It
 * escalates the guard the register installed in this process, and sets
 * `PYRIC_GUARD=block` for the processes Next starts afterward. An explicit
 * `PYRIC_GUARD` (`warn`, `off`) still names the mode, and `PYRIC_GUARD_ALLOW`
 * still permits its hosts.
 */
function blockByDefaultInDevServer(phase: string): void {
  const isDevServer = phase === DEV_SERVER_PHASE;
  const namesMode = (process.env.PYRIC_GUARD ?? '').trim().length > 0;
  const takesDefault = isDevServer && !namesMode;
  if (!takesDefault) return;
  process.env.PYRIC_GUARD = 'block';
  const guard = (globalThis as unknown as Record<symbol, Pick<NetGuard, 'escalate'> | undefined>)[NET_GUARD_GLOBAL];
  guard?.escalate(DEV_GUARD_REASON);
}

function applyPyricEnhancements(config: NextConfigObject, projectDir: string, options?: PyricNextOptions): NextConfigObject {
  let enhancedConfig = augmentServerExternalPackages(config);
  enhancedConfig = augmentWebpackConfig(enhancedConfig, projectDir);
  enhancedConfig = augmentTurbopackConfig(enhancedConfig, projectDir);
  enhancedConfig = augmentDevRewrites(enhancedConfig, options);
  enhancedConfig = augmentRuntimeEnv(enhancedConfig, options);
  return enhancedConfig;
}

/**
 * Higher-order configuration wrapper for Next.js (`next.config.js` or `next.config.mjs`).
 *
 * During the development server phase (`pyric sandbox -- next dev`):
 *   - Applies Webpack and Turbopack alias mappings to swap `firebase/*` imports
 *     for Pyric local sandbox mirrors on client components.
 *   - Adds `firebase` and `firebase-admin` to `serverExternalPackages` to prevent
 *     inlining in Server Components and API routes, preserving `@pyric/cli/register` hooks.
 *   - Configures dev-time rewrites (`/__pyric/*`) to proxy socket and bridge traffic
 *     to the local Pyric server without CORS errors.
 *   - Enforces a bundler safety interlock (guard) to prevent accidental connections to
 *     production databases when `PYRIC_SANDBOX` is inactive.
 *   - Defaults the network guard to `block` unless `PYRIC_GUARD` names a mode.
 *
 * In the production build, export and production server phases (without
 * `PYRIC_SANDBOX_FORCE=1`):
 *   - Returns the user's configuration unchanged, leaving standard builds untouched.
 *
 * The result is always a configuration function, because the decision depends on
 * the phase Next passes in rather than on NODE_ENV.
 */
export function withPyric(config: NextConfig = {}, options?: PyricNextOptions): NextConfigFunction {
  // Read now: the config module that calls withPyric sits in Next's project directory.
  const projectDir = callingConfigDir();
  return async (phase, defaults) => {
    if (isProductionPassthrough(phase)) {
      return isFunctionConfig(config) ? await config(phase, defaults) : config;
    }

    enforceSandboxGuard(options);
    blockByDefaultInDevServer(phase);
    warnAboutEdgeRuntime();

    const resolvedConfig = isFunctionConfig(config) ? await config(phase, defaults) : config;
    return applyPyricEnhancements(resolvedConfig, projectDir, options);
  };
}
