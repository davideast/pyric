/**
 * Build an `IDBKeyRange` matching every UTF-16 string key `k` with
 * `k.startsWith(prefix)`, including keys containing `U+FFFD`..`U+FFFF`.
 *
 * IndexedDB orders string keys lexicographically by 16-bit UTF-16 code units
 * (`0x0000`..`0xFFFF`). Stripping any trailing `0xFFFF` code units and
 * incrementing the last remaining code unit yields the least UTF-16 string
 * strictly greater than all extensions of `prefix`.
 */
export function prefixKeyRange(prefix: string): IDBKeyRange | undefined {
  if (prefix.length === 0) {
    return undefined;
  }
  let index = prefix.length - 1;
  while (index >= 0 && prefix.charCodeAt(index) === 0xffff) {
    index -= 1;
  }
  if (index < 0) {
    return IDBKeyRange.lowerBound(prefix, false);
  }
  const nextCodeUnit = prefix.charCodeAt(index) + 1;
  const upper = prefix.slice(0, index) + String.fromCharCode(nextCodeUnit);
  return IDBKeyRange.bound(prefix, upper, false, true);
}
