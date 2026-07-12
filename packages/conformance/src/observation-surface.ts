/**
 * Shared longest-prefix ownership resolution for observation filenames.
 *
 * `observations/` and `probes/` are grouped into per-surface subdirectories
 * keyed by the SAME `observationPrefixes` every surface descriptor
 * (`surfaces/*.ts`) already declares. Two different consumers need to answer
 * "which owner claims this filename?": `rigs/load.ts`-style rig manifests
 * (which prefix belongs to which capture rig) and surface descriptors (which
 * prefix belongs to which surface, i.e. which subdirectory a file must live
 * in). Both use the identical longest-prefix rule, so it lives here once
 * instead of being reimplemented at each call site.
 */

export interface PrefixOwner {
  id: string;
  observationPrefixes: string[];
}

/**
 * All (owner id, prefix) pairs whose prefix is a longest match for `filename`
 * among every owner's `observationPrefixes`. Longest-prefix match decides
 * ownership (e.g. 'rtdb-modular-foo.json' matches both 'rtdb-' and
 * 'rtdb-modular-'; the longer one wins). More than one owner id in the result
 * means the match is ambiguous.
 */
export function longestPrefixOwners(filename: string, owners: PrefixOwner[]): { ownerId: string; prefix: string }[] {
  let maxLen = -1;
  let matches: { ownerId: string; prefix: string }[] = [];
  for (const owner of owners) {
    for (const prefix of owner.observationPrefixes) {
      if (!filename.startsWith(prefix)) continue;
      if (prefix.length > maxLen) {
        maxLen = prefix.length;
        matches = [{ ownerId: owner.id, prefix }];
      } else if (prefix.length === maxLen) {
        matches.push({ ownerId: owner.id, prefix });
      }
    }
  }
  return matches;
}

/**
 * The single owner id that claims `filename` by longest-prefix match, or
 * `undefined` if no owner's prefix matches or the match is ambiguous (two
 * owners tie on prefix length). Callers that need to distinguish "no match"
 * from "ambiguous match" should call `longestPrefixOwners` directly.
 */
export function soleLongestPrefixOwner(filename: string, owners: PrefixOwner[]): string | undefined {
  const matches = longestPrefixOwners(filename, owners);
  const distinct = new Set(matches.map((m) => m.ownerId));
  return distinct.size === 1 ? matches[0]!.ownerId : undefined;
}
