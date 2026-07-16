/**
 * The guide groups — the outcome-first sections the left nav renders in
 * full. Everything else is reference: the nav collapses each of those
 * groups to a single link (its overview page) under one "Reference"
 * disclosure, so the sidebar reads as a guide, not a manual. The pages
 * themselves are unaffected: still built, still in llms.txt, index.json,
 * and search, still reachable from their overview and in-page links.
 *
 * One authored set: the porter (scripts/port-content.ts) asserts its
 * GUIDE_GROUPS labels against this module, so a rename either updates
 * both surfaces or fails the port loudly instead of silently collapsing
 * the nav into the Reference shelf.
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
