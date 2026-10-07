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

function isFunctionConfig(config: NextConfig): config is NextConfigFunction {
  return typeof config === 'function';
}

function warnAboutEdgeRuntime(): void {
  const warning = formatEdgeRuntimeWarning(findEdgeRuntimeFiles(process.cwd()));
  if (warning !== null) {
    console.warn(warning);
  }
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
 *   - Adds `firebase` and `firebase-admin` to `serverExternalPackages` to prevent
 *     inlining in Server Components and API routes, preserving `@pyric/cli/register` hooks.
 *   - Configures dev-time rewrites (`/__pyric/*`) to proxy socket and bridge traffic
 *     to the local Pyric server without CORS errors.
 *   - Enforces a bundler safety interlock (guard) to prevent accidental connections to
 *     production databases when `PYRIC_SANDBOX` is inactive.
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
    warnAboutEdgeRuntime();

    const resolvedConfig = isFunctionConfig(config) ? await config(phase, defaults) : config;
    return applyPyricEnhancements(resolvedConfig, options);
  };
}
