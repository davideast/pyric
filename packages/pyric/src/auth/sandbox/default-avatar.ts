/**
 * Deterministic default-avatar generation: seed hashing + inline SVG data URI,
 * plus the mint hook the sandbox backend calls when it creates a
 * provider-identity record with no photo of its own.
 */

const FNV_OFFSET_BASIS_A = 0x811c9dc5;
const FNV_OFFSET_BASIS_B = 0x9e3779b9;
const FNV_PRIME = 0x01000193;

function fnv1a32(bytes: Uint8Array, offsetBasis: number): number {
  let hash = offsetBasis;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function toHex8(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/**
 * Deterministic 64-bit seed for a uid, returned as 16 lowercase hex chars.
 * FNV-1a 32-bit is run twice with different offset baskets (forward and
 * reversed uid bytes) to spread the uid's entropy across both halves.
 */
export function avatarSeed(uid: string): string {
  const forwardBytes = new TextEncoder().encode(uid);
  const reversedBytes = new TextEncoder().encode([...uid].reverse().join(''));
  const highHalf = fnv1a32(forwardBytes, FNV_OFFSET_BASIS_A);
  const lowHalf = fnv1a32(reversedBytes, FNV_OFFSET_BASIS_B);
  return toHex8(highHalf) + toHex8(lowHalf);
}

interface DefaultAvatarInput {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  /** Render the generating state: the same deterministic artwork plus a
   *  spinning ring, with the initial dimmed. A configured source producing
   *  this user's real image is still running, so the plain avatar would
   *  otherwise be indistinguishable from a finished one and read as a
   *  silent failure. Declarative SVG animation, so it runs inside an
   *  `<img>` element with no script and nothing for an application to
   *  style. */
  pending?: boolean;
}

interface GradientHues {
  hueStart: number;
  hueEnd: number;
  saturation: number;
  lightness: number;
}

function gradientHuesFromSeed(seed: string): GradientHues {
  const highHalf = Number.parseInt(seed.slice(0, 8), 16);
  const lowHalf = Number.parseInt(seed.slice(8, 16), 16);
  const hueStart = highHalf % 360;
  const hueSpread = 40 + (lowHalf % 80);
  const hueEnd = (hueStart + hueSpread) % 360;
  const saturation = 60 + (highHalf % 16); // 60-75
  const lightness = 45 + (lowHalf % 16); // 45-60
  return { hueStart, hueEnd, saturation, lightness };
}

/** First Unicode code point of a string, safe for surrogate pairs (emoji, CJK). */
function firstCodePoint(value: string): string | undefined {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const first = segmenter.segment(value)[Symbol.iterator]().next();
  if (first.done) return undefined;
  return first.value.segment;
}

function glyphFromInput(input: DefaultAvatarInput): string | undefined {
  const displayNameFirst = input.displayName?.trim();
  if (displayNameFirst) {
    const glyph = firstCodePoint(displayNameFirst);
    if (glyph) return glyph.toUpperCase();
  }
  const emailLocalPart = input.email?.split('@')[0]?.trim();
  if (emailLocalPart) {
    const glyph = firstCodePoint(emailLocalPart);
    if (glyph) return glyph.toUpperCase();
  }
  return undefined;
}

/** Encode SVG markup for embedding as a `data:image/svg+xml,` URI. */
function encodeSvgForDataUri(svg: string): string {
  return encodeURIComponent(svg)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * Deterministic default avatar for a user: a two-hue linear gradient plus a
 * centred initial glyph, as raw SVG markup. `defaultAvatarDataUri` encodes
 * this for the in-page fallback; the served dev server encodes it as UTF-8
 * bytes and serves it directly as `image/svg+xml` (the asset resolver's
 * built-in fallback — see `pyric/auth/internal` and
 * `@pyric/cli`'s `serve/sandbox-session.ts`).
 */
export function defaultAvatarSvg(input: DefaultAvatarInput): string {
  const seed = avatarSeed(input.uid);
  const { hueStart, hueEnd, saturation, lightness } = gradientHuesFromSeed(seed);
  const gradientId = `g${seed}`;
  const glyph = glyphFromInput(input);

  const pending = input.pending === true;

  const glyphMarkup =
    glyph === undefined
      ? ''
      : `<text x="64" y="64" font-family="system-ui, -apple-system, sans-serif" ` +
        `font-size="56" fill="#fff" fill-opacity="${pending ? '0.55' : '0.9'}" text-anchor="middle" ` +
        `dominant-baseline="central">${glyph}</text>`;

  // r=56 with a 6-wide stroke stays inside the 64 radius a circular crop
  // cuts at, so the ring survives `border-radius: 50%`. The dash pattern
  // sums to the circumference (2*pi*56), leaving one visible arc.
  const pendingMarkup = pending
    ? `<circle cx="64" cy="64" r="56" fill="none" stroke="#fff" stroke-opacity="0.25" stroke-width="6"/>` +
      `<circle cx="64" cy="64" r="56" fill="none" stroke="#fff" stroke-opacity="0.95" stroke-width="6" ` +
      `stroke-linecap="round" stroke-dasharray="44 308">` +
      `<animateTransform attributeName="transform" type="rotate" from="0 64 64" to="360 64 64" ` +
      `dur="1s" repeatCount="indefinite"/></circle>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
    `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="hsl(${hueStart},${saturation}%,${lightness}%)"/>` +
    `<stop offset="100%" stop-color="hsl(${hueEnd},${saturation}%,${lightness}%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="128" height="128" fill="url(#${gradientId})"/>` +
    `${glyphMarkup}${pendingMarkup}</svg>`
  );
}

/**
 * Deterministic default avatar for a user, encoded as a `data:image/svg+xml,`
 * URI — the in-page fallback used when no dev server is present.
 */
export function defaultAvatarDataUri(input: DefaultAvatarInput): string {
  return `data:image/svg+xml,${encodeSvgForDataUri(defaultAvatarSvg(input))}`;
}

/** Everything a mint knows about the record being created. The provider id is
 *  the one the record is created under, so a mint can vary the image by
 *  provider or refuse a provider outright. */
export interface AvatarMintInput {
  uid: string;
  displayName: string | null;
  email: string | null;
  providerId: string;
}

/**
 * Assigns the `photoURL` a provider-created sandbox user is born with, or
 * `null` for none. The backend calls it once, at record creation, and stores
 * whatever it returns — the value is persisted, exported, and captured, so a
 * mint must be deterministic in its input.
 *
 * Three mints exist. {@link defaultAvatarMint} is the built-in and needs no
 * server. A served host replaces it with one that returns its
 * `/__pyric/assets/avatar/<uid>` route, and a host with avatars disabled
 * replaces it with one that returns `null` (Firebase's own behaviour when a
 * provider supplies no photo).
 */
export type AvatarMint = (input: AvatarMintInput) => string | null;

/** The no-server mint: a deterministic SVG data URI, resolvable anywhere. */
export const defaultAvatarMint: AvatarMint = (input) => defaultAvatarDataUri(input);
