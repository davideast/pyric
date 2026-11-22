/**
 * The read-time form of a sandbox user's photo URL.
 *
 * A served host mints the avatar as a relative path so the persisted record
 * stays portable across origins. Production `photoURL` values are always
 * absolute, and a relative one cannot resolve in a document whose base is not
 * the page (a blob-URL or srcdoc iframe, a server-side consumer). So every
 * read surface resolves the stored value against the page origin it knows.
 */

/** `photoUrl` resolved against `origin` when it is a root-relative path and
 *  `origin` is an http(s) origin; any other value is returned unchanged. */
export function absolutePhotoUrl(photoUrl: string | null, origin: string | null | undefined): string | null {
  if (photoUrl === null || !photoUrl.startsWith('/') || photoUrl.startsWith('//')) return photoUrl;
  if (origin == null || !/^https?:\/\//.test(origin)) return photoUrl;
  return new URL(photoUrl, origin).href;
}

/** The origin of the realm this code runs in: the page or worker origin in a
 *  browser, `null` in Node or an opaque-origin document. */
export function realmOrigin(): string | null {
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
  return typeof origin === 'string' && /^https?:\/\//.test(origin) ? origin : null;
}

const SERVED_AVATAR_PATH_PREFIX = '/__pyric/assets/avatar/';
const ABSOLUTE_SERVED_AVATAR_URL = /^(https?:\/\/[^/?#]+)(\/__pyric\/assets\/avatar\/.*)$/;

/** Parse a root-relative or absolute served avatar URL into its portable path and optional origin. */
export function parseServedAvatarPhotoUrl(
  photoUrl: string | null,
): { relativePath: string; origin: string | null } | null {
  if (photoUrl === null) {
    return null;
  }
  if (photoUrl.startsWith(SERVED_AVATAR_PATH_PREFIX)) {
    return { relativePath: photoUrl, origin: null };
  }
  const match = ABSOLUTE_SERVED_AVATAR_URL.exec(photoUrl);
  if (match === null) {
    return null;
  }
  const origin = match[1];
  const relativePath = match[2];
  if (origin === undefined || relativePath === undefined) {
    return null;
  }
  return { relativePath, origin };
}

/** Normalize an absolute served avatar URL back to its portable root-relative path for storage. */
export function portableAvatarPhotoUrl(photoUrl: string | null): string | null {
  const parsed = parseServedAvatarPhotoUrl(photoUrl);
  if (parsed !== null) {
    return parsed.relativePath;
  }
  return photoUrl;
}

/** Resolve `photoURL` on every entry of a `providerData` array against `origin`. */
export function absoluteProviderPhotoUrls<T extends { readonly photoURL: string | null }>(
  entries: ReadonlyArray<T>,
  origin: string | null | undefined,
): T[] {
  return entries.map((entry) => {
    const resolved = absolutePhotoUrl(entry.photoURL, origin);
    if (resolved === entry.photoURL) {
      return entry;
    }
    return { ...entry, photoURL: resolved };
  });
}
