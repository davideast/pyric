/**
 * The `/__pyric/assets/avatar/<uid>` URL: the shape the sandbox mints and the
 * shape the route parses.
 *
 * Kept apart from `avatar-route.ts` because both sides of that contract need
 * it and only one of them runs on a server: the mint is installed in the page
 * and in the SharedWorker, so this module must stay free of Node imports.
 *
 * The URL is written into persisted sandbox state, snapshots, and captured
 * sessions (`docs/auth-avatars-design.md`, one-way doors), which is why every
 * input the resolver could want travels in the query string rather than in
 * server memory: a source configured tomorrow must be able to answer for a uid
 * minted today with nothing but the request.
 */
import { avatarSeed, type AvatarMint, type AvatarMintInput } from 'pyric/auth/internal';

/** Every asset consumer mounts one segment under this prefix. Avatars are the
 *  first; an unknown consumer segment is a 404, never a fall-through. */
export const ASSETS_ROUTE_PREFIX = '/__pyric/assets/';

/** The avatar consumer's prefix. `<uid>` is the one segment that follows. */
export const AVATAR_ROUTE_PREFIX = `${ASSETS_ROUTE_PREFIX}avatar/`;

/**
 * The avatar URL for one user: the uid as the path segment, the resolution
 * seed as `d`, and the display name (`n`), email (`e`), and provider id (`p`)
 * as hints for a configured source. A hint the record does not carry is
 * omitted rather than sent empty.
 *
 * Relative, so it is same-origin by construction — an `img` element can fetch
 * it with no token, which is the whole reason the route is public.
 */
export function avatarAssetUrl(input: AvatarMintInput): string {
  const params = new URLSearchParams({ d: avatarSeed(input.uid) });
  if (input.displayName !== null) params.set('n', input.displayName);
  if (input.email !== null) params.set('e', input.email);
  params.set('p', input.providerId);
  return `${AVATAR_ROUTE_PREFIX}${encodeURIComponent(input.uid)}?${params.toString()}`;
}

/** The mint a served host installs: provider users get this server's avatar
 *  route, whose bytes resolve lazily on first fetch. */
export const servedAvatarMint: AvatarMint = avatarAssetUrl;

/** The mint a host with `avatars: false` installs — Firebase's own behaviour
 *  for a provider that supplies no photo. */
export const nullAvatarMint: AvatarMint = () => null;

/**
 * The mint an init payload asks for, or `null` when the payload expresses no
 * opinion and the sandbox's built-in data-URI mint should stand.
 *
 * `avatars` absent is NOT `avatars: false`: a payload from a server too old to
 * carry the flag, or a page with no dev server behind it at all, leaves the
 * built-in mint in place, because a data URI resolves without a route. Only an
 * explicit `false` turns default photos off.
 */
export function avatarMintForPayload(avatars: boolean | undefined): AvatarMint | null {
  if (avatars === true) return servedAvatarMint;
  if (avatars === false) return nullAvatarMint;
  return null;
}
