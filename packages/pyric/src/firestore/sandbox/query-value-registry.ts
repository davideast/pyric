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
const EXECUTION_REGISTRY_KEY = Symbol.for('pyric.firestore.query-value-execution-registry');
const executionGlobalStore = globalThis as {
  [EXECUTION_REGISTRY_KEY]?: WeakMap<object, () => unknown>;
};
const executionValues: WeakMap<object, () => unknown> =
  executionGlobalStore[EXECUTION_REGISTRY_KEY]
  ?? (executionGlobalStore[EXECUTION_REGISTRY_KEY] = new WeakMap());
const OWNER_REGISTRY_KEY = Symbol.for('pyric.firestore.query-value-owner-registry');
const ownerGlobalStore = globalThis as { [OWNER_REGISTRY_KEY]?: WeakMap<object, object> };
const owners: WeakMap<object, object> = ownerGlobalStore[OWNER_REGISTRY_KEY]
  ?? (ownerGlobalStore[OWNER_REGISTRY_KEY] = new WeakMap());

export function registerQueryValue(
  value: object,
  snapshot: unknown,
  executionValue: () => unknown = () => value,
): void {
  values.set(value, snapshot);
  executionValues.set(value, executionValue);
}

export function registeredQueryValue(value: object): unknown | undefined {
  return values.get(value);
}

export function registeredQueryValueOwner(value: object): object | undefined {
  return owners.get(value);
}

export function registeredQueryExecutionValue(value: object): unknown {
  return executionValues.get(value)?.() ?? value;
}

export function copyQueryValueRegistration(source: object, target: object): void {
  const snapshot = values.get(source);
  const executionValue = executionValues.get(source);
  if (snapshot !== undefined) values.set(target, snapshot);
  if (executionValue !== undefined) executionValues.set(target, executionValue);
  const owner = owners.get(source);
  if (owner !== undefined) owners.set(target, owner);
}

const REFERENCE_QUERY_VALUE_KEY = Symbol.for('pyric.firestore.reference-query-value');

class ReferenceQueryValue {
  readonly [REFERENCE_QUERY_VALUE_KEY] = true;

  constructor(readonly path: string) {}

  isEqual(other: unknown): boolean {
    return typeof other === 'object'
      && other !== null
      && REFERENCE_QUERY_VALUE_KEY in other
      && (other as { path?: unknown }).path === this.path;
  }
}

export function registeredReferenceQueryValuePath(value: object): string | undefined {
  const registered = values.get(value);
  if (typeof registered !== 'object'
    || registered === null
    || !(REFERENCE_QUERY_VALUE_KEY in registered)) return undefined;
  const path = (registered as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

export function registerReferenceQueryValue(
  value: object,
  path: string,
  owner: object,
  executionValue: object = value,
): void {
  registerQueryValue(value, new ReferenceQueryValue(path), () => executionValue);
  owners.set(value, owner);
}
