/**
 * How a rules document lookup reads its path, shared by the Firestore engine
 * (`get()`, `exists()`, `getAfter()`, `existsAfter()`) and the Storage engine
 * (`firestore.get()`, `firestore.exists()`).
 *
 * Production builds a lookup path from its segments, so an interpolated
 * string is one segment whatever it holds. A segment holding a `/` names no
 * document: it is never read as the deeper document the joined string would
 * spell. Captures: `c7a-interp-lookups` (Firestore, #1888) and
 * `rules-storage-h1-lookup-interpolated-slash` (Storage).
 *
 * Both engines error on such a lookup, `exists` included. The captures show a
 * deny, which an error and a false answer both give; erroring is the
 * fail-closed reading, so `!exists(...)` denies too.
 */

/** The first segment that holds a `/`, which makes the lookup name no document. */
export function slashedSegment(segments: readonly string[]): string | undefined {
  return segments.find((segment) => segment.includes('/'));
}

/** Why a lookup with {@link slashedSegment} names no document. */
export function slashedSegmentReason(segment: string): string {
  return `the path segment "${segment}" holds a "/", and an interpolated string is one segment, so no document has this path`;
}

/**
 * The key a lookup counts toward its engine's document access limit under.
 * A segment holding a `/` is percent-encoded, as production's own argument
 * rendering shows (`users/alice%2Fprivate%2Fx`), so it never counts as the
 * deeper document.
 */
export function lookupAccessKey(segments: readonly string[]): string {
  return segments.map((segment) => segment.replaceAll('%', '%25').replaceAll('/', '%2F')).join('/');
}
