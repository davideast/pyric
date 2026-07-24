/**
 * Webpack configuration augmentation for Next.js client component builds.
 */
import type { NextConfigObject } from './types.js';
import { getClientAliases, getNodeBuiltinFallbacks } from './client-aliases.js';

interface WebpackOptions {
  isServer: boolean;
  [key: string]: unknown;
}

function isClientSideBuild(options: WebpackOptions): boolean {
  return options.isServer === false;
}

function assembleClientResolveSection(existingResolve: Record<string, any> | undefined): Record<string, any> {
  const resolveSection = existingResolve !== undefined ? Object.assign({}, existingResolve) : {};

  const currentAliases = resolveSection.alias !== undefined ? Object.assign({}, resolveSection.alias) : {};
  const newAliases = getClientAliases();
  resolveSection.alias = Object.assign(currentAliases, newAliases);

  const currentFallbacks = resolveSection.fallback !== undefined ? Object.assign({}, resolveSection.fallback) : {};
  const newFallbacks = getNodeBuiltinFallbacks();
  resolveSection.fallback = Object.assign(currentFallbacks, newFallbacks);

  return resolveSection;
}

/**
 * Wrap the existing Next.js Webpack configuration builder to inject client-side
 * Firebase module aliases when bundling for browser runtime execution.
 */
export function augmentWebpackConfig(config: NextConfigObject): NextConfigObject {
  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const originalWebpack = updatedConfig.webpack;

  updatedConfig.webpack = (webpackConfig: any, webpackOptions: WebpackOptions) => {
    if (isClientSideBuild(webpackOptions)) {
      const currentResolve = webpackConfig.resolve;
      webpackConfig.resolve = assembleClientResolveSection(currentResolve);
    }
    if (typeof originalWebpack === 'function') {
      return originalWebpack(webpackConfig, webpackOptions);
    }
    return webpackConfig;
  };

  return updatedConfig;
}
