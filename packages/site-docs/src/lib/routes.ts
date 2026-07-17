/**
 * Route derivation shared by the content module (Vite, import.meta.glob) and
 * the remark link plugin (Node, filesystem). Kept dependency-free so both
 * worlds can import it.
 *
 * Route = path relative to src/content, minus `.md`, with:
 *   - a leading `_generated/` segment stripped (generated pages keep their
 *     flat slug as the whole route, so their public URL is unchanged), and
 *   - a trailing `README` segment dropped (directory index).
 * A `slug` front-matter value, when present, overrides the derived route.
 */
export function routeForRel(rel: string, slugOverride?: string): string {
  if (slugOverride) return slugOverride;
  let r = rel.replace(/\\/g, '/').replace(/^_generated\//, '');
  r = r.replace(/\.md$/, '');
  const segs = r.split('/');
  if (segs[segs.length - 1] === 'README') segs.pop();
  return segs.join('/');
}
