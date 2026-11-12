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
const DEFAULT_DATABASE_ID = '(default)';

function extractRefDatabaseId(rawPath: string): string {
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  const match = /^(?:projects\/[^/]+\/)?databases\/([^/]+)\/documents(?:\/|$)/.exec(trimmed);
  return match ? match[1]! : DEFAULT_DATABASE_ID;
}

function normalizeRelativeRefPath(rawPath: string): string {
  const marker = '/documents/';
  const idx = rawPath.indexOf(marker);
  const sliced = idx === -1 ? rawPath : rawPath.slice(idx + marker.length);
  return sliced.replace(/^\/+|\/+$/g, '');
}

class ReferenceQueryValue {
  readonly [REFERENCE_QUERY_VALUE_KEY] = true;

  constructor(
    readonly path: string,
    readonly databaseId: string = DEFAULT_DATABASE_ID,
  ) {}

  isEqual(other: unknown): boolean {
    if (
      typeof other !== 'object' ||
      other === null ||
      !(REFERENCE_QUERY_VALUE_KEY in other)
    ) {
      return false;
    }
    const otherDb = (other as { databaseId?: unknown }).databaseId;
    const normalizedOtherDb = typeof otherDb === 'string' && otherDb.length > 0
      ? otherDb
      : DEFAULT_DATABASE_ID;
    return normalizedOtherDb === this.databaseId
      && (other as { path?: unknown }).path === this.path;
  }
}

export function registeredReferenceQueryValue(
  value: object,
): { readonly path: string; readonly databaseId: string } | undefined {
  const registered = values.get(value);
  if (
    typeof registered !== 'object' ||
    registered === null ||
    !(REFERENCE_QUERY_VALUE_KEY in registered)
  ) {
    return undefined;
  }
  const path = (registered as { path?: unknown }).path;
  if (typeof path !== 'string') return undefined;
  const rawDb = (registered as { databaseId?: unknown }).databaseId;
  const databaseId = typeof rawDb === 'string' && rawDb.length > 0 ? rawDb : DEFAULT_DATABASE_ID;
  return { path, databaseId };
}

export function registeredReferenceQueryValuePath(value: object): string | undefined {
  const registered = registeredReferenceQueryValue(value);
  if (registered === undefined) return undefined;
  if (registered.databaseId !== DEFAULT_DATABASE_ID) {
    return registered.path.length > 0
      ? `databases/${registered.databaseId}/documents/${registered.path}`
      : `databases/${registered.databaseId}/documents`;
  }
  return registered.path;
}

export function registerReferenceQueryValue(
  value: object,
  path: string,
  owner?: object,
  executionValue: object = value,
  databaseId?: string,
): void {
  const ownerDb = owner !== undefined && typeof (owner as { databaseId?: unknown }).databaseId === 'string'
    ? (owner as { databaseId: string }).databaseId
    : undefined;
  const resolvedDb =
    (typeof databaseId === 'string' && databaseId.length > 0 ? databaseId : undefined) ??
    (ownerDb !== undefined && ownerDb.length > 0 ? ownerDb : undefined) ??
    extractRefDatabaseId(path);
  const relPath = normalizeRelativeRefPath(path);
  registerQueryValue(value, new ReferenceQueryValue(relPath, resolvedDb), () => executionValue);
  const hasOwner = owner !== undefined;
  if (hasOwner) owners.set(value, owner);
}
