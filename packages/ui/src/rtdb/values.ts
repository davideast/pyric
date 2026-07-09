/**
 * RTDB path + value helpers (pure). Paths are ALWAYS normalized to the
 * `'/'`-rooted form (`'/'` for the root, `'/a/b'` otherwise) so every module in
 * this package — the tree reducer, the path bar, the viewer components — agrees
 * on what a path is.
 */

export function normalizeRtdbPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export function rtdbPathSegments(path: string): string[] {
  return normalizeRtdbPath(path).split('/').filter(Boolean);
}

export function joinRtdbPath(base: string, child: string): string {
  return normalizeRtdbPath([...rtdbPathSegments(base), ...child.split('/').filter(Boolean)].join('/'));
}

export function parentRtdbPath(path: string): string {
  const segments = rtdbPathSegments(path);
  if (segments.length <= 1) return '/';
  return `/${segments.slice(0, -1).join('/')}`;
}

/**
 * The path of `target` RELATIVE to `base`, or `null` when `target` is not
 * `base` or one of its descendants. `'/'` means "target IS base". Lets the
 * tree address nodes by absolute database path while the loaded value sits at
 * the view root.
 */
export function relativeRtdbPath(base: string, target: string): string | null {
  const baseSegs = rtdbPathSegments(base);
  const targetSegs = rtdbPathSegments(target);
  if (targetSegs.length < baseSegs.length) return null;
  for (let i = 0; i < baseSegs.length; i++) {
    if (targetSegs[i] !== baseSegs[i]) return null;
  }
  const rest = targetSegs.slice(baseSegs.length);
  return rest.length === 0 ? '/' : `/${rest.join('/')}`;
}

export function isRtdbObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Does this value render as a PARENT node (has child keys)? RTDB has no true
 *  arrays — an array is an object with numeric keys, and renders as one. */
export function hasRtdbChildren(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

/** Child entries sorted RTDB-console style: numeric-aware key order
 *  (`2` before `10`), then lexicographic. */
export function rtdbChildEntries(value: unknown): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

export function rtdbValueAt(root: unknown, path: string): unknown {
  let value = root ?? null;
  for (const segment of rtdbPathSegments(path)) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[segment] ?? null;
  }
  return value;
}

export function formatRtdbJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

export function parseRtdbJson(value: string): unknown {
  const text = value.trim();
  return text.length === 0 ? null : JSON.parse(text);
}

export function rtdbValueKind(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function previewRtdbValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `${value.length} items`;
  if (isRtdbObjectValue(value)) {
    const count = Object.keys(value).length;
    return count === 1 ? '1 child' : `${count} children`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
