/**
 * The nav plan for the docs site, expressed as data the build validates
 * against.
 *
 * `GUIDE_GROUP_LABELS` — the outcome-first sections the left nav renders in
 * full. Everything else is reference: the nav collapses each of those groups
 * to a single link (its overview page) under one "Reference" disclosure, so
 * the sidebar reads as a guide, not a manual. The pages themselves are
 * unaffected: still built, in llms.txt / index.json / search, reachable from
 * their overview and in-page links.
 *
 * `GROUP_ORDER` — the fixed top-level order of every known group. Pages carry
 * a per-group `order` (spaced by 10s); the group they belong to is placed by
 * this list. Any `group` front-matter value not in this list fails the build
 * (content.ts assertion) rather than silently collapsing into Reference.
 */
export const GUIDE_GROUP_LABELS: ReadonlySet<string> = new Set([
  'Overview',
  'Get started',
  'Build',
  'Secure & debug',
  'Observe & shape',
  'Ship & test',
  'Work with an agent',
  'Trust',
  'Conformance',
]);

export const GROUP_ORDER: readonly string[] = [
  // Guide groups (rendered expanded, in this order).
  'Overview',
  'Get started',
  'Build',
  'Secure & debug',
  'Observe & shape',
  'Ship & test',
  'Work with an agent',
  'Trust',
  'Conformance',
  // Reference groups (collapse into the Reference shelf, in this order).
  'pyric',
  'pyric / firestore',
  'pyric / rules',
  'pyric / sandbox',
  'pyric / storage',
  'pyric / auth',
  'pyric / database',
  'pyric / ai',
  '@pyric/cli',
  'pyric-admin / app',
  'pyric-admin / firestore',
  'pyric-admin / auth',
  'pyric-admin / database',
  'pyric-admin / storage',
  '@pyric/ui',
  // The generated API reference now renders inside the Reference shelf.
  'API reference',
];

export const GROUP_RANK: ReadonlyMap<string, number> = new Map(
  GROUP_ORDER.map((label, i) => [label, i]),
);
