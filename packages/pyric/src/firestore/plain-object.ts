/** Objects whose own fields form a document map, without a custom prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  const isNotObject = value === null || typeof value !== 'object';
  if (isNotObject) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
