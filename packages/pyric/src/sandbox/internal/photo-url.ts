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
