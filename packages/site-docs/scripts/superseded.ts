/**
 * Package-docs pages the guide has replaced OUTRIGHT — same job, told
 * once. These stay in their package's docs/ tree (they ship with the
 * npm package), but the site does not build a page for them, and any
 * link that points at one rewrites to its guide replacement, so a
 * reader never lands in the superseded copy.
 *
 * This list is for ROLE duplicates only (the old getting-started
 * tutorial vs the guide's Quickstart). Reference depth the guide links
 * INTO (how-tos, explanations, API reference) does not belong here.
 *
 * Key: source path relative to the repo root. Value: the guide slug
 * that replaced it.
 */
export const SUPERSEDED: Record<string, string> = {
  'packages/pyric-tools/docs/tutorials/getting-started.md': 'start-building',
};
