/**
 * UTF-8 byte-order comparator over JavaScript UTF-16 strings.
 *
 * Mirrors `@firebase/firestore` `compareUtf8Strings`:
 * - When two differing UTF-16 code units are both non-surrogates (`<= 0xFFFF`)
 *   or both surrogates (`0xD800..0xDFFF`), UTF-16 code-unit order matches
 *   lexicographical UTF-8 byte order directly.
 * - When one code unit is a surrogate (representing a supplementary code point
 *   `> U+FFFF` with a 4-byte `0xF0..0xF4` UTF-8 encoding) and the other is a
 *   non-surrogate (1- to 3-byte `0x00..0xEF` UTF-8 encoding, including
 *   `U+E000..U+FFFF`), the surrogate sorts AFTER the non-surrogate.
 */

const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

function isSurrogateCodeUnit(codeUnit: number): boolean {
  return codeUnit >= SURROGATE_MIN && codeUnit <= SURROGATE_MAX;
}

export function compareUtf8Strings(left: string, right: string): number {
  const minLength = Math.min(left.length, right.length);
  for (let index = 0; index < minLength; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    if (leftCode !== rightCode) {
      const leftIsSurrogate = isSurrogateCodeUnit(leftCode);
      const rightIsSurrogate = isSurrogateCodeUnit(rightCode);
      if (leftIsSurrogate === rightIsSurrogate) {
        if (leftCode < rightCode) return -1;
        return 1;
      }
      if (leftIsSurrogate) return 1;
      return -1;
    }
  }
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  return 0;
}
