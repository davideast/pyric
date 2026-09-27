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
  // Webpack matches a key as a prefix unless it ends in `$`. Exact keys keep
  // `firebase/firestore` from capturing `firebase/firestore/lite`.
  const newAliases: Record<string, string> = {};
  for (const [source, target] of Object.entries(getClientAliases())) {
    newAliases[`${source}$`] = target;
  }
  resolveSection.alias = Object.assign(currentAliases, newAliases);

  const currentFallbacks = resolveSection.fallback !== undefined ? Object.assign({}, resolveSection.fallback) : {};
  const newFallbacks = getNodeBuiltinFallbacks();
  resolveSection.fallback = Object.assign(currentFallbacks, newFallbacks);

  return resolveSection;
}

/** The module that installs React's commit hook; it must evaluate before React. */
export const REACT_HOOK_ENTRY = '@pyric/cli/next/internal/react-hook';

/** Next's client runtime entries: `main-app` for the App Router, `main` for Pages. */
const CLIENT_RUNTIME_ENTRIES = ['main-app', 'main'];

type EntryValue = string | string[] | { import: string | string[]; [key: string]: unknown };

function withHookFirst(value: EntryValue): EntryValue {
  if (typeof value === 'string') return value === REACT_HOOK_ENTRY ? value : [REACT_HOOK_ENTRY, value];
  if (Array.isArray(value)) return value.includes(REACT_HOOK_ENTRY) ? value : [REACT_HOOK_ENTRY, ...value];
  const imports = Array.isArray(value.import) ? value.import : [value.import];
  if (imports.includes(REACT_HOOK_ENTRY)) return value;
  return { ...value, import: [REACT_HOOK_ENTRY, ...imports] };
}

/**
 * Wrap Next's client entry so React's commit hook evaluates first. Webpack
 * evaluates an entry's modules in order, and React loads from the runtime
 * entry's own imports, so the hook is in place before React reads it.
 */
function assembleClientEntry(existingEntry: unknown): unknown {
  if (existingEntry === undefined) return existingEntry;
  return async () => {
    const resolved = typeof existingEntry === 'function' ? await existingEntry() : existingEntry;
    const entries: Record<string, EntryValue> = Object.assign({}, resolved as Record<string, EntryValue>);
    for (const name of CLIENT_RUNTIME_ENTRIES) {
      const value = entries[name];
      if (value !== undefined) entries[name] = withHookFirst(value);
    }
    return entries;
  };
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

      webpackConfig.entry = assembleClientEntry(webpackConfig.entry);
    }
    if (typeof originalWebpack === 'function') {
      return originalWebpack(webpackConfig, webpackOptions);
    }
    return webpackConfig;
  };

  return updatedConfig;
}
