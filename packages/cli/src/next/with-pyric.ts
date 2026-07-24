/**
 * Core execution coordinator for the Next.js `withPyric` configuration wrapper.
 */
import type { NextConfig, NextConfigFunction, NextConfigObject, PyricNextOptions } from './types.js';
import { enforceSandboxGuard, isProductionPassthrough } from './guard.js';
import { augmentServerExternalPackages } from './server-external-packages.js';
import { augmentWebpackConfig } from './webpack-config.js';
import { augmentTurbopackConfig } from './turbopack-config.js';
import { augmentDevRewrites } from './dev-rewrites.js';

function isFunctionConfig(config: NextConfig): config is NextConfigFunction {
  return typeof config === 'function';
}

function applyPyricEnhancements(config: NextConfigObject, options?: PyricNextOptions): NextConfigObject {
  let enhancedConfig = augmentServerExternalPackages(config);
  enhancedConfig = augmentWebpackConfig(enhancedConfig);
  enhancedConfig = augmentTurbopackConfig(enhancedConfig);
  enhancedConfig = augmentDevRewrites(enhancedConfig, options);
  return enhancedConfig;
}

/**
 * Higher-order configuration wrapper for Next.js (`next.config.js` or `next.config.mjs`).
 *
 * During development mode (`pyric dev` or non-production NODE_ENV):
 *   - Applies Webpack and Turbopack alias mappings to swap `firebase/*` imports
 *     for Pyric local sandbox mirrors on client components.
 *   - Adds `firebase` and `firebase-admin` to `serverExternalPackages` to prevent
 *     inlining in Server Components and API routes, preserving `@pyric/cli/register` hooks.
 *   - Configures dev-time rewrites (`/__pyric/*`) to proxy socket and bridge traffic
 *     to the local Pyric server without CORS errors.
 *   - Enforces a bundler safety interlock (guard) to prevent accidental connections to
 *     production databases when `PYRIC_SANDBOX` is inactive.
 *
 * In production (`NODE_ENV === 'production'` without `PYRIC_SANDBOX_FORCE=1`):
 *   - Functions as a zero-overhead identity passthrough, leaving standard builds untouched.
 */
export function withPyric(config: NextConfig = {}, options?: PyricNextOptions): NextConfig {
  if (isProductionPassthrough()) {
    return config;
  }

  enforceSandboxGuard(options);

  if (isFunctionConfig(config)) {
    const asyncConfigWrapper: NextConfigFunction = async (phase, defaults) => {
      const resolvedConfig = await config(phase, defaults);
      const augmentedConfig = applyPyricEnhancements(resolvedConfig, options);
      return augmentedConfig;
    };
    return asyncConfigWrapper;
  }

  return applyPyricEnhancements(config, options);
}
