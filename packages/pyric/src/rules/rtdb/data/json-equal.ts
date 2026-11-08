/** Structural equality over plain JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const aIsUint8 = a instanceof Uint8Array;
  const bIsUint8 = b instanceof Uint8Array;
  if (aIsUint8 !== bIsUint8) return false;
  if (aIsUint8 && bIsUint8) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!jsonEqual(a[index], b[index])) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const aObject = a as Record<string, unknown>;
  const bObject = b as Record<string, unknown>;
  const aKeys = Object.keys(aObject);
  if (aKeys.length !== Object.keys(bObject).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObject, key)) return false;
    if (!jsonEqual(aObject[key], bObject[key])) return false;
  }
  return true;
}
