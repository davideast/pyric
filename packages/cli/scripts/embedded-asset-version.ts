import { createHash } from 'node:crypto';

export type EmbeddedAssetTrees = Record<string, Record<string, string>>;

/** Stable content identity for the file trees materialized by a standalone binary. */
export function embeddedAssetVersion(trees: EmbeddedAssetTrees): string {
  const hash = createHash('sha256');
  for (const [tree, files] of Object.entries(trees).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [relpath, contents] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(tree).update('\0').update(relpath).update('\0').update(contents).update('\0');
    }
  }
  return hash.digest('hex').slice(0, 16);
}
