/**
 * Core execution coordinator for the Next.js `withPyric` configuration wrapper.
 */
import type { NextConfig, NextConfigFunction, NextConfigObject, PyricNextOptions } from './types.js';
import { enforceSandboxGuard, isProductionPassthrough } from './guard.js';
import { installRemotePeerMark } from '../register/remote-peer-mark.js';
import { augmentServerExternalPackages, projectDirWarning } from './server-external-packages.js';
import { augmentWebpackConfig } from './webpack-config.js';
import { augmentTurbopackConfig } from './turbopack-config.js';
import { augmentDevRewrites } from './dev-rewrites.js';
import { augmentRuntimeEnv } from './runtime-env.js';
import { findEdgeRuntimeFiles, formatEdgeRuntimeWarning } from './edge-runtime.js';
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

function warnAboutProjectDir(): void {
  const warning = projectDirWarning(process.cwd());
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

function applyPyricEnhancements(config: NextConfigObject, options?: PyricNextOptions): NextConfigObject {
  let enhancedConfig = augmentServerExternalPackages(config);
  enhancedConfig = augmentWebpackConfig(enhancedConfig);
  enhancedConfig = augmentTurbopackConfig(enhancedConfig);
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
 *   - Adds `firebase`, `firebase-admin`, every installed `@firebase/*` package and
 *     every name a Firebase SDK is installed under (an npm alias such as
 *     `"admin": "npm:firebase-admin@13"`) to `serverExternalPackages`, so Server
 *     Components and API routes leave them to Node and `@pyric/cli/register`.
 *     It finds them in the `node_modules` folders above `process.cwd()`, and
 *     warns when that directory has no `next.config.*`.
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
  return async (phase, defaults) => {
    if (isProductionPassthrough(phase)) {
      return isFunctionConfig(config) ? await config(phase, defaults) : config;
    }

    enforceSandboxGuard(options);
    // The rewrite below forwards to the host, also when the guard is turned off and the preload is absent.
    installRemotePeerMark();
    blockByDefaultInDevServer(phase);
    warnAboutEdgeRuntime();
    warnAboutProjectDir();

    const resolvedConfig = isFunctionConfig(config) ? await config(phase, defaults) : config;
    return applyPyricEnhancements(resolvedConfig, options);
  };
}
