/**
 * Joins the names a register message lists: `a, b and c`, or `a, b or c`.
 * The stop's fix (`./swap-or-stop.ts`) and the live guard's reasons
 * (`./live-net-guard.ts`) both name the live rows' imports this way.
 * `@pyric/live`'s refusal keeps its own joiner, since the page plane can't
 * import CLI code.
 *
 * Loaded by both resolve hooks, including the loader-thread one, so it
 * imports nothing.
 */
export function joinedList(items: readonly string[], conjunction: 'and' | 'or'): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;
}
