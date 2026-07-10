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

/**
 * Normalize a snapshot value to RTDB semantics before it enters tree state:
 * an empty object IS null (RTDB has no empty containers — the server prunes
 * them), so `{}` — and any object whose children all normalize away — becomes
 * `null`. Without this, an empty database's root value `{}` fails
 * `hasRtdbChildren` and renders as a scalar leaf (`String({})` →
 * `"[object Object]"`). Reuses the input object when nothing changed.
 */
export function normalizeRtdbSnapshotValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const normalized = normalizeRtdbSnapshotValue(child);
    if (normalized === null) {
      changed = true;
      continue;
    }
    if (normalized !== child) changed = true;
    next[key] = normalized;
  }
  if (Object.keys(next).length === 0) return null;
  return changed ? next : value;
}

/** Leaf value text, console style: strings quoted, primitives literal.
 *  Defensive on objects: never `String`-coerce (that's `[object Object]`) —
 *  fall back to JSON. Object values should have been normalized/expanded away
 *  before reaching a leaf label; this keeps the label honest if one slips in. */
export function formatRtdbValueLabel(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? 'null';
    } catch {
      return 'null';
    }
  }
  return String(value);
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

/** Structural equality for JSON-shaped RTDB snapshots and row fingerprints. */
export function rtdbValuesEqual(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next)) return false;
    if (previous.length !== next.length) return false;
    return previous.every((value, index) => rtdbValuesEqual(value, next[index]));
  }
  if (
    previous === null ||
    next === null ||
    typeof previous !== 'object' ||
    typeof next !== 'object'
  ) {
    return false;
  }
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord);
  const nextKeys = Object.keys(nextRecord);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every(
    (key) => key in nextRecord && rtdbValuesEqual(previousRecord[key], nextRecord[key]),
  );
}

/** One comparison fingerprint per RTDB row. Parent fingerprints contain only
 * direct child keys, so leaf changes remain local while additions/removals
 * also light the immediate parent. */
export function rtdbUpdateEntries(
  value: unknown,
  rootPath: string,
): ReadonlyMap<string, unknown> {
  const entries = new Map<string, unknown>();
  const visit = (current: unknown, path: string) => {
    if (!hasRtdbChildren(current)) {
      entries.set(path, ['leaf', current ?? null]);
      return;
    }
    const children = rtdbChildEntries(current);
    entries.set(path, ['parent', children.map(([key]) => key)]);
    for (const [key, child] of children) visit(child, joinRtdbPath(path, key));
  };
  visit(value, normalizeRtdbPath(rootPath));
  return entries;
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
