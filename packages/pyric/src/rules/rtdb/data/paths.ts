/** Path segments that must never be walked or written: because the tree
 *  is backed by plain JS objects, a segment named `__proto__` (or, as
 *  defence-in-depth, `constructor`/`prototype`) would reach the shared
 *  `Object.prototype` and let a rule-permitted write pollute it
 *  process-wide. Real RTDB stores a server-side tree with no such
 *  reserved keys, so rejecting them is a sandbox-only safety constraint,
 *  not a parity regression. */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Normalise a path to an array of non-empty segments. `'/'` → [].
 *  Throws if any segment is a prototype-pollution vector. */
export function pathSegments(path: string): string[] {
  if (path === '' || path === '/') return [];
  // Strip leading + trailing slashes, then split on `/` and drop empties.
  const segs = path.split('/').filter((s) => s.length > 0);
  for (const seg of segs) {
    if (UNSAFE_SEGMENTS.has(seg)) {
      throw new Error(
        `Invalid RTDB path segment '${seg}': the keys __proto__, prototype, ` +
          'and constructor are reserved and cannot appear in a path.',
      );
    }
  }
  return segs;
}
