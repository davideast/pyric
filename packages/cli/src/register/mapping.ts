/**
 * The specifier map behind `@pyric/cli/register`: unmodified Firebase
 * imports resolve to their pyric mirrors. Most subpaths map 1:1
 * (`firebase-admin/app` → `pyric-admin/app`, `firebase/firestore` →
 * `pyric/firestore`, …). `firebase/app` maps to the Node register adapter,
 * which translates FirebaseOptions into the process sandbox before entering
 * the strict `pyric/app` mirror.
 *
 * Pure — the resolution hooks (index.ts / hooks.ts) call this and the unit
 * suite exercises it directly. Deliberately narrow: only the two package
 * roots match. `@firebase/*` internals, `firebase-functions`, and anything
 * merely *containing* "firebase" pass through untouched.
 */

const MAPPINGS: ReadonlyArray<readonly [from: string, to: string]> = [
  // firebase-admin first — `firebase-admin` must never match the bare
  // `firebase` root (it can't today, but the order documents the intent).
  ['firebase-admin', 'pyric-admin'],
  ['firebase', 'pyric'],
];

/**
 * Map a Firebase specifier to its pyric mirror, or return `null` when the
 * specifier is not a Firebase package (leave it for the default resolver).
 */
export function mapFirebaseSpecifier(
  specifier: string,
  importer?: string,
  options?: { aiMode?: 'sandbox' | 'production' },
): string | null {
  const isShadowBridgeImporter = importer !== undefined &&
    (importer.includes('app-bridge') || importer.includes('app-ai-passthrough'));
  const isFirebaseAppSpecifier = specifier === 'firebase/app';
  const isBypassedBridgeImport = isShadowBridgeImporter && isFirebaseAppSpecifier;
  if (isBypassedBridgeImport) {
    return null;
  }

  let mode: 'sandbox' | 'production' = 'sandbox';
  const explicitMode = options?.aiMode;
  const hasExplicitMode = explicitMode !== undefined;
  if (hasExplicitMode) {
    mode = explicitMode;
  } else {
    const isEnvProductionMode = process.env.PYRIC_AI_MODE === 'production';
    const isEnvPassthroughFlag = process.env.PYRIC_AI_PASSTHROUGH === '1';
    const isProductionEnv = isEnvProductionMode || isEnvPassthroughFlag;
    if (isProductionEnv) {
      mode = 'production';
    }
  }

  const isProductionMode = mode === 'production';
  const isFirebaseAiSpecifier = specifier === 'firebase/ai';
  const isProductionAiPassthrough = isProductionMode && isFirebaseAiSpecifier;
  if (isProductionAiPassthrough) {
    return null;
  }

  if (isFirebaseAppSpecifier) {
    if (isProductionMode) {
      return '@pyric/cli/register/app-bridge';
    }
    return 'pyric/app/register';
  }

  for (const [from, to] of MAPPINGS) {
    const isExactMatch = specifier === from;
    if (isExactMatch) {
      return to;
    }
    const isSubpathMatch = specifier.startsWith(`${from}/`);
    if (isSubpathMatch) {
      const subpath = specifier.slice(from.length);
      return to + subpath;
    }
  }
  return null;
}
