/**
 * Exact, trusted snapshots for Firestore scalar objects constructed by Pyric.
 *
 * Query equality must compare the value, not object identity, but it must also
 * avoid invoking getters or reflection on an arbitrary caller-owned object.
 * Pyric-owned scalar constructors therefore register their exact immutable
 * representation here. The global key keeps src/dist copies interoperable.
 */
const REGISTRY_KEY = Symbol.for('pyric.firestore.query-value-registry');
const globalStore = globalThis as { [REGISTRY_KEY]?: WeakMap<object, unknown> };
const values: WeakMap<object, unknown> =
  globalStore[REGISTRY_KEY] ?? (globalStore[REGISTRY_KEY] = new WeakMap());

export function registerQueryValue(value: object, snapshot: unknown): void {
  values.set(value, snapshot);
}

export function registeredQueryValue(value: object): unknown | undefined {
  return values.get(value);
}
