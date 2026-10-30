/**
 * Turbopack configuration augmentation for Next.js client SDK aliases.
 */
import type { NextConfigObject } from './types.js';
import { getClientAliases } from './client-aliases.js';
import { BRIDGE_IMPORT_LOADER, bridgeModuleFileNames, productionBridgeOptions, type BridgeImportOptions } from './bridge-imports.js';

/** The Turbopack rule that runs the bridge import loader on one wrapper. */
export interface TurbopackBridgeRule {
  loaders: Array<{ loader: string; options: BridgeImportOptions }>;
  as: '*.js';
}

/**
 * In production AI mode, a rule per shadow-app wrapper that runs the bridge
 * import loader, so the wrapper's Firebase SDK import escapes the alias that
 * names the wrapper itself. Keyed by the wrapper's file name; the loader
 * leaves any other file of that name unchanged.
 */
function assembleBridgeRules(existingRules: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const options = productionBridgeOptions();
  if (options === undefined) return existingRules;
  const rules: Record<string, unknown> = Object.assign({}, existingRules);
  for (const name of bridgeModuleFileNames()) {
    const rule: TurbopackBridgeRule = { loaders: [{ loader: BRIDGE_IMPORT_LOADER, options }], as: '*.js' };
    rules[name] = rule;
  }
  return rules;
}

function assembleTurbopackAliases(existingTurbo: Record<string, any> | undefined): Record<string, any> {
  const turboSection = existingTurbo !== undefined ? Object.assign({}, existingTurbo) : {};
  const currentAliases = turboSection.resolveAlias !== undefined ? Object.assign({}, turboSection.resolveAlias) : {};
  const pyricAliases = getClientAliases();
  turboSection.resolveAlias = Object.assign(currentAliases, pyricAliases);
  const rules = assembleBridgeRules(turboSection.rules);
  if (rules !== undefined) turboSection.rules = rules;
  return turboSection;
}

/**
 * Configure Turbopack module aliases across standard and experimental sections.
 */
export function augmentTurbopackConfig(config: NextConfigObject): NextConfigObject {
  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const hasModernTurbopack = typeof updatedConfig.turbopack === 'object' && updatedConfig.turbopack !== null;
  const hasLegacyTopLevelTurbo = typeof updatedConfig.turbo === 'object' && updatedConfig.turbo !== null;
  const hasExperimentalTurbo =
    typeof updatedConfig.experimental === 'object' &&
    updatedConfig.experimental !== null &&
    typeof updatedConfig.experimental.turbo === 'object' &&
    updatedConfig.experimental.turbo !== null;

  const shouldDefaultToModernTurbopack =
    !hasModernTurbopack && !hasLegacyTopLevelTurbo && !hasExperimentalTurbo;

  if (hasModernTurbopack || shouldDefaultToModernTurbopack) {
    const currentTurbopack = updatedConfig.turbopack;
    updatedConfig.turbopack = assembleTurbopackAliases(currentTurbopack);
  }

  if (hasLegacyTopLevelTurbo) {
    const currentTurbo = updatedConfig.turbo;
    updatedConfig.turbo = assembleTurbopackAliases(currentTurbo);
  }

  if (hasExperimentalTurbo) {
    const existingExperimental =
      typeof updatedConfig.experimental === 'object' && updatedConfig.experimental !== null
        ? Object.assign({}, updatedConfig.experimental)
        : {};
    const currentTurbo = existingExperimental.turbo;
    existingExperimental.turbo = assembleTurbopackAliases(currentTurbo);
    updatedConfig.experimental = existingExperimental;
  }

  return updatedConfig;
}


