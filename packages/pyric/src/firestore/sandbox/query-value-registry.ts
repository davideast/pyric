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
const OWNER_REGISTRY_KEY = Symbol.for('pyric.firestore.query-value-owner-registry');
const ownerGlobalStore = globalThis as { [OWNER_REGISTRY_KEY]?: WeakMap<object, object> };
const owners: WeakMap<object, object> = ownerGlobalStore[OWNER_REGISTRY_KEY]
  ?? (ownerGlobalStore[OWNER_REGISTRY_KEY] = new WeakMap());

export function registerQueryValue(value: object, snapshot: unknown): void {
  values.set(value, snapshot);
}

export function registeredQueryValue(value: object): unknown | undefined {
  return values.get(value);
}

export function registeredQueryValueOwner(value: object): object | undefined {
  return owners.get(value);
}

class ReferenceQueryValue {
  constructor(
    private readonly path: string,
    private readonly owner: object,
  ) {}

  isEqual(other: unknown): boolean {
    return other instanceof ReferenceQueryValue
      && this.path === other.path
      && this.owner === other.owner;
  }
}

export function registerReferenceQueryValue(
  value: object,
  path: string,
  owner: object,
): void {
  registerQueryValue(value, new ReferenceQueryValue(path, owner));
  owners.set(value, owner);
}
