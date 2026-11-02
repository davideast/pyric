/** `{ [key]: value }` when there is a value, `{}` when there isn't: for optional fields in an object literal. */
export function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  if (value === undefined) return {};
  return { [key]: value } as Partial<Record<K, V>>;
}
