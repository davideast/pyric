/**
 * `GET /__pyric/assets/avatar/<uid>` — the image behind a sandbox user's
 * `photoURL`.
 *
 * The sandbox assigns the URL synchronously when it creates a provider user,
 * so `photoURL` is never briefly null; the pixels resolve here, on first
 * fetch. This handler owns only the HTTP shape of that fetch — path matching,
 * uid validation, and the caching headers. Which bytes come back is the asset
 * resolver's decision (cache entry, static pool, configured source, generated
 * fallback), and this file never second-guesses it.
 *
 * Query parameters, all optional, all hints carried from the minted URL:
 *
 *   d  the resolution seed. Absent ⇒ `avatarSeed(uid)`, the same seed the
 *      in-page data-URI generator uses, so the two modes agree on a face.
 *   n  the user's display name    e  the user's email
 *   p  the provider id
 *
 * The hints travel in the URL rather than in server state because the URL is
 * written into persisted sandbox state: a source configured tomorrow must be
 * able to serve a uid minted today with nothing but the request.
 *
 * Caching is semantic, not a performance knob. A key's image never changes
 * once it is materialised, so every resolved origin is cacheable for an hour.
 * Two origins are the exception: `fallback` means the resolver did NOT
 * materialise anything (a source failed, or none is configured yet), and the
 * design's failure-never-caches rule says the next fetch must retry; `interim`
 * means a slow source is still generating behind the response the browser got.
 * `no-store` is how the retry, or the upgrade to the generated image, stays
 * visible to the browser.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { avatarSeed } from 'pyric/auth/internal';
import { AVATAR_ROUTE_PREFIX } from './avatar-url.js';
import type { AssetOrigin, AssetRequest, AssetResolver } from './resolver.js';

/** Longest uid this route will look up. Firebase uids are 128 chars at most;
 *  256 leaves room for a mirror that mints longer ones without letting an
 *  arbitrarily long path segment reach the cache directory. */
const MAX_UID_LENGTH = 256;

const CACHEABLE_MAX_AGE_SECONDS = 3_600;

/**
 * The uid a request names, or `null` when the path is not exactly one segment
 * under the avatar prefix or that segment cannot be a uid.
 *
 * A uid becomes a cache filename, so a segment that decodes to a path
 * fragment is rejected outright rather than sanitised: `.`, `..`, and any
 * separator (including their percent-encoded spellings, which decode here).
 */
export function avatarUidFromPath(pathname: string): string | null {
  if (!pathname.startsWith(AVATAR_ROUTE_PREFIX)) return null;
  const segment = pathname.slice(AVATAR_ROUTE_PREFIX.length);
  if (segment.length === 0 || segment.includes('/')) return null;

  let uid: string;
  try {
    uid = decodeURIComponent(segment);
  } catch {
    return null; // malformed percent-encoding
  }
  if (uid.length === 0 || uid.length > MAX_UID_LENGTH) return null;
  if (uid === '.' || uid === '..') return null;
  if (uid.includes('/') || uid.includes('\\')) return null;
  return uid;
}

/** The seed the resolver picks a pool image with. An explicit `d` wins; a
 *  request that carries none is seeded from the uid exactly the way the
 *  in-page generator seeds itself. */
function seedFor(uid: string, requested: string | null): string {
  if (requested !== null && requested.length > 0) return requested;
  return avatarSeed(uid);
}

/** Write-once per key, and neither a failure nor a placeholder ever becomes
 *  the answer: see this file's header for why `fallback` and `interim` are
 *  the uncacheable origins. */
function cacheControlFor(origin: AssetOrigin): string {
  if (origin === 'fallback' || origin === 'interim') return 'no-store';
  return `public, max-age=${CACHEABLE_MAX_AGE_SECONDS}`;
}

/**
 * Handle a request under {@link ASSETS_ROUTE_PREFIX}. Always responds; the
 * caller treats the route as handled.
 */
export async function handleAvatar(
  resolver: AssetResolver,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const uid = avatarUidFromPath(url.pathname);
  if (uid === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' })
      .end('method not allowed');
    return;
  }

  const assetRequest: AssetRequest = {
    key: uid,
    seed: seedFor(uid, url.searchParams.get('d')),
    context: {
      uid,
      displayName: url.searchParams.get('n'),
      email: url.searchParams.get('e'),
      providerId: url.searchParams.get('p'),
    },
  };

  let asset;
  try {
    asset = await resolver.resolve(assetRequest);
  } catch {
    // Unreachable by design — the resolver contains its own failures and
    // degrades to the fallback. Fail safe rather than crash the dev server.
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('avatar resolution failed');
    return;
  }

  res.writeHead(200, {
    'content-type': asset.contentType,
    'content-length': String(asset.data.byteLength),
    'cache-control': cacheControlFor(asset.origin),
  });
  res.end(Buffer.from(asset.data));
}
