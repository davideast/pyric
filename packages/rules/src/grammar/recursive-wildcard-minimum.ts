/**
 * The fewest segments a recursive wildcard (`{name=**}`) matches under a
 * ruleset's `rules_version`, for Firestore and Storage alike. Version 1, the
 * default when the source declares none, needs one or more; version 2 takes
 * zero or more. A `2+modules` source resolves to version 2 before it
 * compiles.
 *
 * The Firestore docs: "In version 1, recursive wildcards match one or more
 * path items." The Storage docs: "In version 1, recursive wildcards match one
 * or more filename elements, not zero or more elements." Captures
 * `rules-firestore-rules-version-1-recursive-glob` and
 * `rules-storage-h1-v1-recursive-wildcard`.
 */
export function recursiveWildcardMinimum(rulesVersion: string): number {
  return rulesVersion === '1' ? 1 : 0;
}
