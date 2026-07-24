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

function assembleClientExperimentsSection(existingExperiments: Record<string, any> | undefined): Record<string, any> {
  const experimentsSection = existingExperiments !== undefined ? Object.assign({}, existingExperiments) : {};
  experimentsSection.topLevelAwait = true;
  return experimentsSection;
}

function assembleClientOutputSection(existingOutput: Record<string, any> | undefined): Record<string, any> {
  const outputSection = existingOutput !== undefined ? Object.assign({}, existingOutput) : {};
  const environmentSection = outputSection.environment !== undefined ? Object.assign({}, outputSection.environment) : {};
  environmentSection.asyncFunction = true;
  outputSection.environment = environmentSection;
  return outputSection;
}

/**
 * Wrap the existing Next.js Webpack configuration builder to inject client-side
 * Firebase module aliases and modern async runtime compatibility settings when
 * bundling for browser execution.
 */
export function augmentWebpackConfig(config: NextConfigObject): NextConfigObject {
  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const originalWebpack = updatedConfig.webpack;

  updatedConfig.webpack = (webpackConfig: any, webpackOptions: WebpackOptions) => {
    if (isClientSideBuild(webpackOptions)) {
      const currentResolve = webpackConfig.resolve;
      webpackConfig.resolve = assembleClientResolveSection(currentResolve);

      const currentExperiments = webpackConfig.experiments;
      webpackConfig.experiments = assembleClientExperimentsSection(currentExperiments);

      const currentOutput = webpackConfig.output;
      webpackConfig.output = assembleClientOutputSection(currentOutput);
    }
    if (typeof originalWebpack === 'function') {
      return originalWebpack(webpackConfig, webpackOptions);
    }
    return webpackConfig;
  };

  return updatedConfig;
}
