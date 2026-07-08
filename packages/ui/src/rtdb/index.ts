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

export function isRtdbObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rtdbChildEntries(value: unknown): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
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
