/**
 * The specifier map behind `@pyric/cli/register`: unmodified Firebase
 * imports resolve to their pyric mirrors, 1:1 including every subpath
 * (`firebase-admin/app` → `pyric-admin/app`, `firebase/firestore` →
 * `pyric/firestore`, …).
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
export function mapFirebaseSpecifier(specifier: string): string | null {
  for (const [from, to] of MAPPINGS) {
    if (specifier === from) return to;
    if (specifier.startsWith(`${from}/`)) return to + specifier.slice(from.length);
  }
  return null;
}
