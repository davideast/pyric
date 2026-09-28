/**
 * `Map.keys()`, shared by the Firestore simulator and the Storage evaluator:
 * the map's own keys in ascending Unicode code point order, whatever order
 * the map was written in. Production sorts keys this way in both services
 * (corpus scenarios `required-fields-and-mapdiff` and
 * `upload-primitives-boundaries`): `'1' < '10' < '2' < 'A' < '_' < 'a'`, a
 * key sorts after its own prefix, and `'ｚ'` (U+FF5A) sorts before `'😀'`
 * (U+1F600), where UTF-16 code unit order and JavaScript's own key order
 * (integer-like keys first) differ.
 */
export function mapKeys(map: Record<string, unknown>): string[] {
  return Object.keys(map).sort(compareCodePoints);
}

function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a.charCodeAt(index) !== b.charCodeAt(index)) {
      // At the first differing code unit, the code points starting there
      // order the strings; a surrogate pair reads as its full code point.
      return a.codePointAt(index)! - b.codePointAt(index)!;
    }
  }
  return a.length - b.length;
}
