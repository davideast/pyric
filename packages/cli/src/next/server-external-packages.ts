/**
 * Server module externalization logic for Next.js runtime loader interception.
 */
import type { NextConfigObject } from './types.js';

const TARGET_SERVER_PACKAGES = ['firebase', 'firebase-admin'];

function appendExternalPackages(existingPackages?: unknown): string[] {
  const packageSet = new Set<string>();
  if (Array.isArray(existingPackages)) {
    for (const pkg of existingPackages) {
      if (typeof pkg === 'string') {
        packageSet.add(pkg);
      }
    }
  }
  for (const pkg of TARGET_SERVER_PACKAGES) {
    packageSet.add(pkg);
  }
  return Array.from(packageSet);
}

/**
 * Inject Pyric backend target packages into `serverExternalPackages` so Next.js
 * avoids inlining them during Server Component and API Route bundling.
 */
export function augmentServerExternalPackages(config: NextConfigObject): NextConfigObject {
  const updatedConfig: NextConfigObject = Object.assign({}, config);

  const currentExternalPackages = updatedConfig.serverExternalPackages;
  updatedConfig.serverExternalPackages = appendExternalPackages(currentExternalPackages);

  const hasExperimentalSection = typeof updatedConfig.experimental === 'object' && updatedConfig.experimental !== null;
  const shouldAugmentLegacySection = hasExperimentalSection || updatedConfig.serverExternalPackages === undefined;
  if (shouldAugmentLegacySection) {
    const experimentalSection = hasExperimentalSection ? Object.assign({}, updatedConfig.experimental) : {};
    const legacyPackages = experimentalSection.serverComponentsExternalPackages;
    experimentalSection.serverComponentsExternalPackages = appendExternalPackages(legacyPackages);
    updatedConfig.experimental = experimentalSection;
  }

  return updatedConfig;
}
