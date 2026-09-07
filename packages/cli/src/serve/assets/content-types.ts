/**
 * The four image content types the asset resolver knows how to persist and
 * serve. Deliberately narrow: a manifest, a cache write, or a fetched
 * response carrying anything outside this set is treated as unknown and
 * falls through to the caller's fallback (resolver.ts).
 */

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** File extension (no dot) for a known content type, or null. */
export function extensionFor(contentType: string): string | null {
  return EXTENSION_BY_CONTENT_TYPE[contentType] ?? null;
}

/** Content type inferred from a filename's extension, or null when the
 *  extension is absent or unknown. */
export function contentTypeFor(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? null;
}
