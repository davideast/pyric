/**
 * Addresses of Studio's sections, derived from the one base URL the runtime
 * manifest carries.
 *
 * The manifest names the Studio hub, and the sections are siblings of it rather
 * than children, so a section address replaces the hub's last segment. The
 * trailing slash is kept: the served host redirects the slashless form, and a
 * redirect hop drops the query a link carries.
 *
 * A section a Studio build does not publish, or a parameter it does not read,
 * is not an error there: it opens its default view. That is why these links can
 * carry a filter without the chip knowing which Studio is on the other end.
 */

/**
 * One Studio section's address, with an optional query appended after whatever
 * query the base already carried.
 */
export function studioSectionUrl(
  studioUrl: string,
  section: string,
  query?: string,
): string {
  const queryStart = studioUrl.indexOf('?');
  const base = queryStart === -1 ? studioUrl : studioUrl.slice(0, queryStart);
  const existing = queryStart === -1 ? '' : studioUrl.slice(queryStart + 1);
  const segments = base.replace(/\/+$/, '').split('/');
  if (segments[segments.length - 1] === 'studio') segments.pop();
  segments.push(section);
  const parts = [existing, query ?? ''].filter((part) => part !== '');
  const suffix = parts.length === 0 ? '' : `?${parts.join('&')}`;
  return `${segments.join('/')}/${suffix}`;
}
