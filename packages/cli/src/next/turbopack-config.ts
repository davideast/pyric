/**
 * Turbopack configuration augmentation for Next.js client SDK aliases.
 */
import type { NextConfigObject } from './types.js';
import { getClientAliases } from './client-aliases.js';

function assembleTurbopackAliases(existingTurbo: Record<string, any> | undefined): Record<string, any> {
  const turboSection = existingTurbo !== undefined ? Object.assign({}, existingTurbo) : {};
  const currentAliases = turboSection.resolveAlias !== undefined ? Object.assign({}, turboSection.resolveAlias) : {};
  const pyricAliases = getClientAliases();
  turboSection.resolveAlias = Object.assign(currentAliases, pyricAliases);
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


