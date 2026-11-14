/**
 * The reads a live page answers for its host. On a live host, an agent's
 * Firestore, Realtime Database or Cloud Storage read goes to a connected tab of the app
 * (`bridge/server/tab-tools.ts` in `@pyric/cli`); the tab runs it here, on
 * the app's own instances, as the app's signed-in user, through the live
 * row's own exports, so each read shows in Traffic like the app's own.
 *
 * The live Firestore, Database and Storage rows hand this file their wrapped module
 * (`noteReadModule`), and this file notes each instance their factories
 * hand the app. A service the app has not opened yet answers nothing, so
 * its tools are not announced and the host keeps refusing them.
 *
 * The page hub (`Symbol.for('pyric.live.reads')`) is shared with the cli
 * page runtime (`serve/worker/client/tab-reads.ts` in `@pyric/cli`), which
 * loads as a separate bundle and announces these tools on the page's own
 * host connection. Each answer is the shape the sandbox gives the same tool.
 *
 * Loaded in the page, so it imports only types.
 */
import type { LiveModuleKey } from './modules.js';

/** One read's answer, the `ToolResult` shape the host's tools return. */
export interface TabReadResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
}

/** What the page hub holds: the reader once a live row loaded, and who to tell when its tools change. */
export interface LiveReadHub {
  reader?: {
    tools(): string[];
    call(name: string, args: Record<string, unknown>): Promise<TabReadResult> | undefined;
  };
  readonly listeners: Set<() => void>;
}

type Fn = (...args: unknown[]) => unknown;
type Fields = Record<string, unknown>;
type Read = (sdk: Fields, instance: unknown, args: Fields) => Promise<TabReadResult>;

const READ_HUB_KEY = Symbol.for('pyric.live.reads');

function readHub(): LiveReadHub {
  const scope = globalThis as { [READ_HUB_KEY]?: LiveReadHub };
  return scope[READ_HUB_KEY] ??= { listeners: new Set() };
}

/** Each service's wrapped module, its default handle, and handles indexed by normalized resource name. */
interface Service {
  sdk?: Fields;
  instance?: unknown;
  defaultInstance?: unknown;
  defaultApp?: unknown;
  readonly byResource: Map<string, unknown>;
}

const firestore: Service = { byResource: new Map() };
const database: Service = { byResource: new Map() };
const storage: Service = { byResource: new Map() };

function defineOwn<T extends Record<string, unknown>>(target: T, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isObjectLike(value: unknown): value is Fields {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function nestedStringAt(value: unknown, keys: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isObjectLike(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current !== '' ? current : undefined;
}

function normalizeRtdbSelector(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      const ns = parsed.searchParams.get('ns');
      if (ns && ns.trim() !== '') return ns.trim().toLowerCase();
      const host = parsed.hostname.toLowerCase();
      if (host.endsWith('.firebaseio.com') || host.endsWith('.firebasedatabase.app')) {
        const firstLabel = host.split('.')[0];
        if (firstLabel) return firstLabel;
      }
      return host;
    } catch {
      return undefined;
    }
  }
  return trimmed.replace(/\/+$/, '').toLowerCase();
}

function normalizeStorageBucketSelector(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let cleaned = raw.trim();
  if (cleaned === '') return undefined;
  if (/^gs:\/\//i.test(cleaned)) cleaned = cleaned.slice(5);
  cleaned = cleaned.replace(/\/+$/, '').toLowerCase();
  if (cleaned === '' || cleaned.includes('/')) return undefined;
  return cleaned;
}

function databaseKeysOf(instance: unknown, factoryArgs: readonly unknown[]): { keys: string[]; isDefault: boolean } {
  const explicitArg = typeof factoryArgs[1] === 'string' && factoryArgs[1].trim() !== '' ? factoryArgs[1] : undefined;
  const isDefault = explicitArg === undefined;
  const keys = new Set<string>();
  const repoNamespace =
    nestedStringAt(instance, ['_repoInternal', 'repoInfo_', 'namespace']) ??
    nestedStringAt(instance, ['_repo', 'repoInfo_', 'namespace']) ??
    nestedStringAt(instance, ['_delegate', '_repoInternal', 'repoInfo_', 'namespace']) ??
    nestedStringAt(instance, ['instance']);
  const normalizedRepo = normalizeRtdbSelector(repoNamespace);
  if (normalizedRepo) keys.add(normalizedRepo);
  const normalizedExplicit = normalizeRtdbSelector(explicitArg);
  if (normalizedExplicit) keys.add(normalizedExplicit);
  if (isDefault) {
    keys.add('default');
    const configuredUrl = nestedStringAt(instance, ['app', 'options', 'databaseURL']);
    const normalizedConfigured = normalizeRtdbSelector(configuredUrl);
    if (normalizedConfigured) keys.add(normalizedConfigured);
    const projectId = nestedStringAt(instance, ['app', 'options', 'projectId']);
    if (projectId) {
      keys.add(`${projectId.toLowerCase()}-default-rtdb`);
      if (normalizedConfigured === undefined && normalizedRepo === undefined) {
        keys.add(projectId.toLowerCase());
      }
    }
  }
  return { keys: [...keys], isDefault };
}

function storageKeysOf(sdk: Fields, instance: unknown, factoryArgs: readonly unknown[]): { keys: string[]; isDefault: boolean } {
  const explicitArg = typeof factoryArgs[1] === 'string' && factoryArgs[1].trim() !== '' ? factoryArgs[1] : undefined;
  const isDefault = explicitArg === undefined;
  const keys = new Set<string>();
  const normalizedExplicit = normalizeStorageBucketSelector(explicitArg);
  if (normalizedExplicit) keys.add(normalizedExplicit);
  const internalBucket =
    nestedStringAt(instance, ['_bucket', 'bucket']) ??
    nestedStringAt(instance, ['_delegate', '_bucket', 'bucket']) ??
    nestedStringAt(instance, ['bucket']);
  const normalizedInternal = normalizeStorageBucketSelector(internalBucket);
  if (normalizedInternal) keys.add(normalizedInternal);
  if (keys.size === 0 && typeof sdk.ref === 'function') {
    try {
      const rootRef = (sdk.ref as Fn)(instance, '');
      const refBucket = normalizeStorageBucketSelector(nestedStringAt(rootRef, ['bucket']));
      if (refBucket && refBucket !== 'bucket-not-read-from-the-sdk-reference') keys.add(refBucket);
    } catch {
      // Ignore synthetic mocks whose `ref` requires extra arguments.
    }
  }
  if (isDefault) {
    keys.add('default');
    const configuredBucket = normalizeStorageBucketSelector(nestedStringAt(instance, ['app', 'options', 'storageBucket']));
    if (configuredBucket) keys.add(configuredBucket);
  }
  return { keys: [...keys], isDefault };
}

function resolveServiceInstance(
  key: LiveModuleKey | undefined,
  service: Service,
  args: Fields,
): { ok: true; instance: unknown } | { ok: false; result: TabReadResult } {
  if (key === 'live-database' && typeof args.instance === 'string' && args.instance.trim() !== '') {
    const target = normalizeRtdbSelector(args.instance);
    const matched = target === undefined ? undefined : service.byResource.get(target);
    if (matched === undefined) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: `Live mode refused database read: Realtime Database instance '${args.instance}' is not open in the app's tab.`,
          data: { code: 'PYRIC_LIVE_REFUSED' },
        },
      };
    }
    return { ok: true, instance: matched };
  }
  if (key === 'live-storage' && typeof args.bucket === 'string' && args.bucket.trim() !== '') {
    const target = normalizeStorageBucketSelector(args.bucket);
    const matched = target === undefined ? undefined : service.byResource.get(target);
    if (matched === undefined) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: `Live mode refused storage read: Storage bucket '${args.bucket}' is not open in the app's tab.`,
          data: { code: 'PYRIC_LIVE_REFUSED' },
        },
      };
    }
    return { ok: true, instance: matched };
  }
  return { ok: true, instance: service.defaultInstance ?? service.instance };
}

/** The factories whose result is the service's instance. */
const FACTORIES: Partial<Record<LiveModuleKey, { service: Service; names: readonly string[] }>> = {
  'live-firestore': { service: firestore, names: ['getFirestore', 'initializeFirestore'] },
  'live-database': { service: database, names: ['getDatabase'] },
  'live-storage': { service: storage, names: ['getStorage'] },
};

/**
 * The factories a row's module must export as its own wrapper so the app's
 * call reaches `noteReadModule`'s note: a row module re-exports the SDK's own
 * binding for any name its row does not replace (`row-source.ts`).
 */
export function readFactoryNames(key: LiveModuleKey): readonly string[] {
  return FACTORIES[key]?.names ?? [];
}

function sdkFn(sdk: Fields, name: string): Fn {
  return sdk[name] as Fn;
}

function call(sdk: Fields, name: string, ...args: unknown[]): unknown {
  return sdkFn(sdk, name)(...args);
}

// ─── Firestore ────────────────────────────────────────────────────────────

interface QuerySnapshot {
  size: number;
  docs: { id: string; data(): unknown }[];
}

async function getDocument(sdk: Fields, db: unknown, args: Fields): Promise<TabReadResult> {
  const path = String(args.path);
  const snap = await call(sdk, 'getDoc', call(sdk, 'doc', db, path)) as { exists(): boolean; data(): unknown };
  const exists = snap.exists();
  return { ok: true, summary: exists ? `Got ${path}` : `No document at ${path}`, data: { exists, data: exists ? snap.data() : null } };
}

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

/** A collection read in the forwarded tools' form: the collection, its where clauses, one ordering and a limit. */
interface CollectionRead {
  collection: string;
  where: WhereClause[];
  orderBy?: string;
  direction?: string;
  limit?: number;
}

async function readCollection(sdk: Fields, db: unknown, read: CollectionRead): Promise<TabReadResult> {
  const constraints = read.where.map((clause) => call(sdk, 'where', clause.field, clause.op, clause.value));
  if (read.orderBy) constraints.push(call(sdk, 'orderBy', read.orderBy, read.direction ?? 'asc'));
  if (read.limit) constraints.push(call(sdk, 'limit', read.limit));
  const target = call(sdk, 'query', call(sdk, 'collection', db, read.collection), ...constraints);
  const snap = await call(sdk, 'getDocs', target) as QuerySnapshot;
  const counted = read.where.length > 0 ? `${snap.size} matches in` : `${snap.size} docs in`;
  return { ok: true, summary: `${counted} ${read.collection}`, data: { docs: snap.docs.map((d) => ({ id: d.id, data: d.data() })) } };
}

/** `firestore_list_documents` and `firestore_query_where`: `{ collection, where?, orderBy?, limit? }`. */
function forwardedCollection(sdk: Fields, db: unknown, args: Fields): Promise<TabReadResult> {
  const where = Array.isArray(args.where) ? (args.where as WhereClause[]) : [];
  const read: CollectionRead = { collection: String(args.collection), where };
  if (typeof args.orderBy === 'string') read.orderBy = args.orderBy;
  if (typeof args.limit === 'number') read.limit = args.limit;
  return readCollection(sdk, db, read);
}

interface Constraint {
  type?: string;
  field?: string;
  op?: string;
  value?: unknown;
  direction?: string;
}

/** `firestore.getDocs`: `{ path, constraints? }`, constraints spelled as the SDK names them. */
function methodCollection(sdk: Fields, db: unknown, args: Fields): Promise<TabReadResult> {
  const entries = Array.isArray(args.constraints) ? (args.constraints as Constraint[]) : [];
  const where = entries.filter((entry) => entry.type === 'where').map((entry) => ({ field: String(entry.field), op: String(entry.op), value: entry.value }));
  const order = entries.find((entry) => entry.type === 'orderBy');
  const limit = entries.find((entry) => entry.type === 'limit');
  const read: CollectionRead = { collection: String(args.path), where };
  if (order !== undefined) {
    read.orderBy = String(order.field);
    read.direction = order.direction;
  }
  if (limit !== undefined) read.limit = Number(limit.value);
  return readCollection(sdk, db, read);
}

// ─── Realtime Database ───────────────────────────────────────────────────

async function valueAt(sdk: Fields, db: unknown, path: string): Promise<unknown> {
  const snap = await call(sdk, 'get', call(sdk, 'ref', db, path)) as { val(): unknown };
  return snap.val();
}

/** `database.get`: `{ path }`. */
async function getValue(sdk: Fields, db: unknown, args: Fields): Promise<TabReadResult> {
  const path = String(args.path);
  const value = await valueAt(sdk, db, path);
  return { ok: true, summary: value === null ? `No value at ${path}` : `Read ${path}`, data: { exists: value !== null, value } };
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function isBranch(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function childPath(parent: string, key: string): string {
  return parent === '/' ? `/${key}` : `${parent}/${key}`;
}

/**
 * One node of the sandbox crawl's shape, with no leaf values, to `maxDepth`
 * object levels below the crawl's root: the walk of `crawlSnapshot` in
 * `@pyric/cli` (`rtdb/crawl-snapshot.ts`), copied since the page bundle
 * imports no cli code.
 */
function crawlNode(value: unknown, path: string, depth: number, maxDepth: number, maxChildren: number): Fields {
  if (!isBranch(value)) return { path, childCount: 0, truncated: false, children: [], schema: {}, valueType: valueType(value) };
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const schema: Record<string, string> = {};
  const branches: [string, Fields][] = [];
  for (const [key, child] of entries) {
    if (isBranch(child)) branches.push([key, child]);
    else defineOwn(schema, key, valueType(child));
  }
  const atDepth = depth >= maxDepth;
  const children = atDepth ? [] : branches.slice(0, maxChildren).map(([key, child]) => crawlNode(child, childPath(path, key), depth + 1, maxDepth, maxChildren));
  const truncated = (atDepth && branches.length > 0) || entries.length > maxChildren;
  return { path, childCount: entries.length, truncated, children, schema };
}

/** The object paths below a crawled node, as the sandbox crawl counts them. */
function descendantObjects(node: Fields): number {
  return (node.children as Fields[]).reduce((total, child) => total + 1 + descendantObjects(child), 0);
}

/** `rtdb_crawl_structure`: `{ path?, maxDepth?, maxChildren? }`, described from one `get`. */
async function crawlStructure(sdk: Fields, db: unknown, args: Fields): Promise<TabReadResult> {
  const segments = String(args.path ?? '/').split('/').filter(Boolean);
  const path = segments.length === 0 ? '/' : `/${segments.join('/')}`;
  const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 10;
  const maxChildren = typeof args.maxChildren === 'number' ? args.maxChildren : 100;
  const root = crawlNode(await valueAt(sdk, db, path), path, 0, maxDepth, maxChildren);
  return { ok: true, summary: `Crawled ${descendantObjects(root)} object paths from ${path}`, data: root };
}

// ─── Cloud Storage ───────────────────────────────────────────────────────

/** `storage.listAll`: `{ prefix? }`, the objects and folders under it as full paths. */
async function listObjects(sdk: Fields, storage: unknown, args: Fields): Promise<TabReadResult> {
  const prefix = args.prefix === undefined ? undefined : String(args.prefix);
  const listing = await call(sdk, 'listAll', call(sdk, 'ref', storage, prefix ?? '')) as { items: { fullPath: string }[]; prefixes: { fullPath: string }[] };
  const items = listing.items.map((item) => item.fullPath);
  const prefixes = listing.prefixes.map((item) => item.fullPath);
  return { ok: true, summary: `${items.length} objects under ${prefix ?? '/'}`, data: { items, prefixes } };
}

/** `storage.getMetadata`: `{ path }`, the object's metadata without the SDK's reference to it. */
async function objectMetadata(sdk: Fields, storage: unknown, args: Fields): Promise<TabReadResult> {
  const path = String(args.path);
  const { ref: _reference, ...metadata } = await call(sdk, 'getMetadata', call(sdk, 'ref', storage, path)) as Fields;
  return { ok: true, summary: `Read metadata for ${path}`, data: { metadata } };
}

// ─── The reader ──────────────────────────────────────────────────────────

const READS: ReadonlyMap<string, { key: LiveModuleKey; service: Service; read: Read }> = new Map([
  ['firestore.getDoc', { key: 'live-firestore', service: firestore, read: getDocument }],
  ['firestore_get_document', { key: 'live-firestore', service: firestore, read: getDocument }],
  ['firestore.getDocs', { key: 'live-firestore', service: firestore, read: methodCollection }],
  ['firestore_list_documents', { key: 'live-firestore', service: firestore, read: forwardedCollection }],
  ['firestore_query_where', { key: 'live-firestore', service: firestore, read: forwardedCollection }],
  ['database.get', { key: 'live-database', service: database, read: getValue }],
  ['rtdb_crawl_structure', { key: 'live-database', service: database, read: crawlStructure }],
  ['storage.listAll', { key: 'live-storage', service: storage, read: listObjects }],
  ['storage.getMetadata', { key: 'live-storage', service: storage, read: objectMetadata }],
]);

function isOpen(service: Service): boolean {
  return service.sdk !== undefined && service.instance !== undefined;
}

function errorSummary(name: string, error: unknown): TabReadResult {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const detail = typeof code === 'string' ? `${code}: ${message}` : message;
  return { ok: false, summary: `${name} failed in the app's tab: ${detail}`, data: { code: typeof code === 'string' ? code : 'unknown' } };
}

const reader: NonNullable<LiveReadHub['reader']> = {
  tools() {
    return [...READS].filter(([, entry]) => isOpen(entry.service)).map(([name]) => name);
  },
  call(name, args) {
    const entry = READS.get(name);
    const answers = entry !== undefined && isOpen(entry.service);
    if (!answers) return undefined;
    const resolved = resolveServiceInstance(entry.key, entry.service, args);
    if (!resolved.ok) return Promise.resolve(resolved.result);
    return entry.read(entry.service.sdk!, resolved.instance, args).catch((error: unknown) => errorSummary(name, error));
  },
};

const DEFAULT_APP_NAME = '[DEFAULT]';
const DEFAULT_FIRESTORE_DB = '(default)';

function appHandleOf(instance: unknown, factoryArgs: readonly unknown[]): unknown {
  if (isObjectLike(instance) && isObjectLike(instance.app)) return instance.app;
  const firstArg = factoryArgs[0];
  if (isObjectLike(firstArg)) return firstArg;
  return undefined;
}

function shouldAdoptDefaultInstance(service: Service, instance: unknown, factoryArgs: readonly unknown[]): boolean {
  const app = appHandleOf(instance, factoryArgs);
  const appName = nestedStringAt(app, ['name']);
  if (appName === DEFAULT_APP_NAME) return true;
  if (appName !== undefined) return false;
  if (factoryArgs.length === 0 || factoryArgs[0] === undefined) return true;
  if (service.defaultInstance === undefined) return true;
  return app !== undefined && app === service.defaultApp;
}

function isDefaultFirestoreDatabase(factoryName: string, instance: unknown, factoryArgs: readonly unknown[]): boolean {
  let explicitDb: string | undefined;
  if (factoryName === 'initializeFirestore') {
    if (typeof factoryArgs[2] === 'string') explicitDb = factoryArgs[2];
  } else if (typeof factoryArgs[0] === 'string') {
    explicitDb = factoryArgs[0];
  } else if (typeof factoryArgs[1] === 'string') {
    explicitDb = factoryArgs[1];
  }
  if (explicitDb !== undefined && explicitDb !== '' && explicitDb !== DEFAULT_FIRESTORE_DB) {
    return false;
  }
  const internalDb =
    nestedStringAt(instance, ['_databaseId', 'database']) ??
    nestedStringAt(instance, ['_databaseId']);
  if (internalDb !== undefined && internalDb !== '' && internalDb !== DEFAULT_FIRESTORE_DB) {
    return false;
  }
  return true;
}

function recordServiceInstance(
  service: Service,
  instance: unknown,
  factoryArgs: readonly unknown[],
  isDefaultResource: boolean,
  resourceKeys: readonly string[],
): boolean {
  const adoptsDefault = isDefaultResource && shouldAdoptDefaultInstance(service, instance, factoryArgs);
  let changed = false;
  for (const resourceKey of resourceKeys) {
    if (resourceKey === 'default' && !adoptsDefault && service.byResource.has('default')) {
      continue;
    }
    if (service.byResource.get(resourceKey) !== instance) {
      service.byResource.set(resourceKey, instance);
      changed = true;
    }
  }
  if (adoptsDefault) {
    if (service.defaultInstance !== instance) {
      service.defaultInstance = instance;
      changed = true;
    }
    service.defaultApp = appHandleOf(instance, factoryArgs);
  }
  const nextPrimary = service.defaultInstance ?? service.instance ?? instance;
  if (service.instance !== nextPrimary) {
    service.instance = nextPrimary;
    changed = true;
  }
  return changed;
}

function noteInstance(
  key: LiveModuleKey,
  factoryName: string,
  sdk: Fields,
  service: Service,
  instance: unknown,
  factoryArgs: readonly unknown[],
): void {
  if (instance === undefined || instance === null) return;
  const wasOpen = isOpen(service);
  let changed = false;
  if (key === 'live-database') {
    const { keys, isDefault } = databaseKeysOf(instance, factoryArgs);
    changed = recordServiceInstance(service, instance, factoryArgs, isDefault, keys);
  } else if (key === 'live-storage') {
    const { keys, isDefault } = storageKeysOf(sdk, instance, factoryArgs);
    changed = recordServiceInstance(service, instance, factoryArgs, isDefault, keys);
  } else if (key === 'live-firestore') {
    const isDefault = isDefaultFirestoreDatabase(factoryName, instance, factoryArgs);
    changed = recordServiceInstance(service, instance, factoryArgs, isDefault, []);
  } else if (instance !== service.instance) {
    service.instance = instance;
    service.defaultInstance = instance;
    changed = true;
  }
  if (changed || !wasOpen) {
    for (const listener of readHub().listeners) listener();
  }
}

/**
 * Takes a live row's wrapped module: Firestore's, Database's and Storage's are kept to
 * answer reads with, and their factories note each instance they hand the
 * app. Any other row is left as it is.
 */
export function noteReadModule(key: LiveModuleKey, wrapped: Fields): void {
  const factories = FACTORIES[key];
  if (factories === undefined) return;
  const { service, names } = factories;
  if (service.sdk !== undefined && service.sdk !== wrapped) {
    service.instance = undefined;
    service.defaultInstance = undefined;
    service.defaultApp = undefined;
    service.byResource.clear();
  }
  service.sdk = wrapped;
  for (const name of names) {
    const factory = wrapped[name];
    if (typeof factory !== 'function') continue;
    wrapped[name] = function noted(this: unknown, ...args: unknown[]): unknown {
      const instance = Reflect.apply(factory as Fn, this, args);
      noteInstance(key, name, wrapped, service, instance, args);
      return instance;
    };
  }
  readHub().reader = reader;
}
