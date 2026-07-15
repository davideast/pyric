/**
 * Package-docs pages the site has replaced OUTRIGHT — same job, told
 * once. Most stay in their package's docs/ tree because they ship with
 * the npm package. Removed pages may remain here as redirect records so
 * old relative links still resolve to the replacement during the site build.
 *
 * This list is for role duplicates only. Reference depth the guide links
 * into does not belong here. The API entries below are the old handwritten
 * inventories now owned by the generated TypeDoc template at the same route.
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
  'packages/pyric/docs/firestore/reference/api.md': 'pyric-firestore-reference-api',
  'packages/pyric/docs/auth/reference/api.md': 'pyric-auth-reference-api',
  'packages/pyric/docs/database/reference/api.md': 'pyric-database-reference-api',
  'packages/pyric/docs/storage/reference/api.md': 'pyric-storage-reference-api',
  'packages/pyric/docs/rules/reference/api.md': 'pyric-rules-reference-api',
  'packages/pyric/docs/sandbox/reference/api.md': 'pyric-sandbox-reference-api',
  'packages/pyric-admin/docs/app/reference/api.md': 'pyric-admin-app-reference-api',
  'packages/pyric-admin/docs/firestore/reference/api.md':
    'pyric-admin-firestore-reference-api',
  'packages/pyric-admin/docs/auth/reference/api.md': 'pyric-admin-auth-reference-api',
  'packages/pyric-admin/docs/database/reference/api.md':
    'pyric-admin-database-reference-api',
  'packages/pyric-admin/docs/storage/reference/api.md': 'pyric-admin-storage-reference-api',
};
