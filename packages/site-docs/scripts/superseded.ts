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
  'packages/cli/docs/tutorials/getting-started.md': 'start-building',
  // Modernization pass, 2026-07-10: role duplicates the editors flagged
  // and the gate confirmed (whole job done by the guide, no unique depth
  // left behind). Pages with unique depth stay (server-adoption,
  // wire-claude-code's prod security, enforce-rules' verb table).
  'packages/pyric/docs/firestore/how-to/build-queries.md': 'store-and-query-data',
  'packages/pyric/docs/rules/tutorials/01-lint-your-first-rules-file.md': 'simulate-and-lint',
  'packages/pyric/docs/rules/tutorials/02-write-a-test-suite-for-your-rules.md':
    'write-a-rules-test-suite',
  'packages/pyric/docs/sandbox/tutorials/02-use-the-sandbox-in-a-test-harness.md':
    'test-in-node',
  'packages/pyric/docs/sandbox/tutorials/03-build-a-traffic-monitor.md':
    'see-whats-happening',
  'packages/pyric/docs/storage/tutorials/01-upload-and-download.md': 'store-files',
  'packages/pyric/docs/storage/how-to/round-trip-metadata.md': 'store-files',
};
