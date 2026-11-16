/**
 * Webpack configuration augmentation for Next.js client component builds.
 */
import type { NextConfigObject } from './types.js';
import {
  CLIENT_STOP_MODULE,
  getClientAliases,
  getClientStopSpecifiers,
  getNodeBuiltinFallbacks,
} from './client-aliases.js';
import {
  BRIDGE_IMPORT_LOADER,
  PRODUCTION_AI_SDK_FILE_PATTERN,
  productionBridgeOptions,
  type BridgeImportOptions,
} from './bridge-imports.js';

interface WebpackOptions {
  isServer: boolean;
  [key: string]: unknown;
}

function isClientSideBuild(options: WebpackOptions): boolean {
  return options.isServer === false;
}

interface WebpackAliasEntry {
  readonly name: string;
  readonly alias: string | false | string[];
  readonly onlyModule: boolean;
}

function pyricClientAliases(): Array<{ readonly name: string; readonly alias: string; readonly onlyModule: true }> {
  const entries: Array<{ readonly name: string; readonly alias: string; readonly onlyModule: true }> = [];
  for (const [source, target] of Object.entries(getClientAliases())) {
    entries.push({ name: source, alias: target, onlyModule: true });
  }
  for (const unserved of getClientStopSpecifiers()) {
    entries.push({ name: unserved, alias: CLIENT_STOP_MODULE, onlyModule: true });
  }
  return entries;
}

function clonePlainObject(value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    Object.assign(copy, value);
  }
  return copy;
}

function mergeResolveAliases(existingAlias: unknown): Record<string, unknown> | WebpackAliasEntry[] {
  const pyricEntries = pyricClientAliases();
  if (Array.isArray(existingAlias)) {
    // Webpack 5 array-form `resolve.alias` evaluates entries in order without
    // stripping trailing `$`, so Pyric's exact entries (`onlyModule: true`) go
    // first while preserving all user entries without mutating the input array.
    return [...pyricEntries, ...(existingAlias as WebpackAliasEntry[])];
  }
  const currentAliases = clonePlainObject(existingAlias);
  // Webpack matches an object key as a prefix unless it ends in `$`. Exact keys
  // keep `firebase/firestore` from capturing `firebase/firestore/lite`.
  const newAliases: Record<string, string> = {};
  for (const entry of pyricEntries) {
    newAliases[`${entry.name}$`] = entry.alias;
  }
  return Object.assign(currentAliases, newAliases);
}

function mergeResolveFallbacks(existingFallback: unknown): Record<string, unknown> | WebpackAliasEntry[] {
  const newFallbacks = getNodeBuiltinFallbacks();
  if (Array.isArray(existingFallback)) {
    const pyricFallbacks: WebpackAliasEntry[] = [];
    for (const [name, enabled] of Object.entries(newFallbacks)) {
      if (!enabled) {
        pyricFallbacks.push({ name, alias: false, onlyModule: false });
      }
    }
    return [...pyricFallbacks, ...(existingFallback as WebpackAliasEntry[])];
  }
  const currentFallbacks = clonePlainObject(existingFallback);
  return Object.assign(currentFallbacks, newFallbacks);
}

function assembleClientResolveSection(existingResolve: Record<string, any> | undefined): Record<string, any> {
  const resolveSection = existingResolve !== undefined ? Object.assign({}, existingResolve) : {};
  resolveSection.alias = mergeResolveAliases(resolveSection.alias);
  resolveSection.fallback = mergeResolveFallbacks(resolveSection.fallback);
  return resolveSection;
}

/**
 * In production AI mode, a rule that runs the bridge import loader on the
 * shadow-app wrappers, so their Firebase SDK imports escape the aliases that
 * name the wrappers themselves (see `bridge-imports.ts`).
 */
function assembleClientModuleSection(
  existingModule: { rules?: unknown[]; [key: string]: unknown } | undefined,
): { rules?: unknown[]; [key: string]: unknown } | undefined {
  const options = productionBridgeOptions();
  if (options === undefined) return existingModule;
  const moduleSection = Object.assign({}, existingModule);
  const rules = Array.isArray(moduleSection.rules) ? [...moduleSection.rules] : [];
  const rule: WebpackBridgeRule = {
    test: [...Object.keys(options.wrappers), PRODUCTION_AI_SDK_FILE_PATTERN],
    use: [{ loader: BRIDGE_IMPORT_LOADER, options }],
  };
  rules.push(rule);
  moduleSection.rules = rules;
  return moduleSection;
}

/** The webpack rule that runs the bridge import loader on the wrappers and production AI SDK browser files. */
export interface WebpackBridgeRule {
  test: Array<string | RegExp>;
  use: Array<{ loader: string; options: BridgeImportOptions }>;
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
    // The user's function runs first so it cannot replace the Pyric aliases,
    // fallbacks and entry hook that the sandbox swap depends on.
    const userResult = typeof originalWebpack === 'function' ? originalWebpack(webpackConfig, webpackOptions) : webpackConfig;
    const resolvedConfig = userResult ?? webpackConfig;
    if (!isClientSideBuild(webpackOptions)) {
      return resolvedConfig;
    }
    resolvedConfig.resolve = assembleClientResolveSection(resolvedConfig.resolve);
    resolvedConfig.module = assembleClientModuleSection(resolvedConfig.module);
    resolvedConfig.experiments = assembleClientExperimentsSection(resolvedConfig.experiments);
    resolvedConfig.output = assembleClientOutputSection(resolvedConfig.output);
    resolvedConfig.entry = assembleClientEntry(resolvedConfig.entry);
    return resolvedConfig;
  };

  return updatedConfig;
}
