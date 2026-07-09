/**
 * Traffic rules-inspector selection ↔ URL query (`?inspect=<id>`) — pure logic.
 *
 * The Traffic surface's RULES INSPECTOR is URL-driven so an inspection view is
 * linkable: the command palette deep-links `{ tab: 'traffic', query:
 * { inspect: <id> } }` ("Open in rules inspector", `features/home/command.ts`),
 * and `shell/path.ts` documents `inspect` as the Traffic surface's query key.
 * (The key was `denial` when the inspector opened denials only; it generalized
 * to `inspect` when allowed ops became inspectable too — nothing external
 * depended on the old URL.) These helpers own the query round-trip (select →
 * param, close → param removed, other keys preserved) so the surface only
 * navigates; no component state mirrors the URL.
 */

/** The Traffic surface's rules-inspector query key (see `shell/path.ts`). */
export const INSPECT_PARAM = 'inspect';

/** The inspected op's event id, or null when none is focused. */
export function selectedInspectId(
  query: Record<string, string>,
): string | null {
  const id = query[INSPECT_PARAM];
  return id ? id : null;
}

/**
 * The query with the inspector focus set (`id`) or cleared (`null`), preserving
 * every other key. Returns a NEW object; the input is never mutated.
 */
export function queryWithInspect(
  query: Record<string, string>,
  id: string | null,
): Record<string, string> {
  const { [INSPECT_PARAM]: _removed, ...rest } = query;
  return id ? { ...rest, [INSPECT_PARAM]: id } : rest;
}

/**
 * Row-click semantics: clicking the inspected op's row closes it; clicking
 * any other rules-evaluated row focuses it. Returns the NEXT query.
 */
export function toggleInspect(
  query: Record<string, string>,
  id: string,
): Record<string, string> {
  return queryWithInspect(query, selectedInspectId(query) === id ? null : id);
}
