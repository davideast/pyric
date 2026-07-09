/**
 * Traffic denial selection ↔ URL query (`?denial=<id>`) — pure logic.
 *
 * The Traffic surface's denial inspection is URL-driven so a denial view is
 * linkable: the command palette already deep-links `{ tab: 'traffic', query:
 * { denial: <id> } }` ("Focus denial in Traffic", `features/home/command.ts`),
 * and `shell/path.ts` documents `denial` as the Traffic surface's query key.
 * These helpers own the query round-trip (select → param, close → param
 * removed, other keys preserved) so the surface only navigates; no component
 * state mirrors the URL.
 */

/** The Traffic surface's denial-focus query key (see `shell/path.ts`). */
export const DENIAL_PARAM = 'denial';

/** The selected denial id, or null when none is focused. */
export function selectedDenialId(
  query: Record<string, string>,
): string | null {
  const id = query[DENIAL_PARAM];
  return id ? id : null;
}

/**
 * The query with the denial focus set (`id`) or cleared (`null`), preserving
 * every other key. Returns a NEW object; the input is never mutated.
 */
export function queryWithDenial(
  query: Record<string, string>,
  id: string | null,
): Record<string, string> {
  const { [DENIAL_PARAM]: _removed, ...rest } = query;
  return id ? { ...rest, [DENIAL_PARAM]: id } : rest;
}

/**
 * Row-click semantics: clicking the focused denial's row closes it; clicking
 * any other denial row focuses it. Returns the NEXT query.
 */
export function toggleDenial(
  query: Record<string, string>,
  id: string,
): Record<string, string> {
  return queryWithDenial(query, selectedDenialId(query) === id ? null : id);
}
