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

import { isShadowAppImporter, resolveAiMode, type AiMode } from '../serve/firebase-module-swap.js';

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
  options?: { aiMode?: AiMode },
): string | null {
  const isFirebaseAppSpecifier = specifier === 'firebase/app';
  const isBypassedBridgeImport = isShadowAppImporter(importer) && isFirebaseAppSpecifier;
  if (isBypassedBridgeImport) {
    return null;
  }

  const isProductionMode = resolveAiMode(options?.aiMode, process.env) === 'production';
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
