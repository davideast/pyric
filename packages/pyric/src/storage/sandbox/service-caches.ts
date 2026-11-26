/**
 * Shared handle contracts and process-wide WeakMap caches for `pyric/storage`.
 *
 * Keyed by `Symbol.for` on `globalThis` so `src` and `dist` copies share one
 * `StorageService` and per-bucket rules state per `Sandbox`.
 */
import type {
  AuthState,
  EventCaller,
  Sandbox,
  SandboxContext,
} from 'pyric/sandbox';
import type {
  StorageRules,
  StorageRulesResolution,
} from '@pyric/rules/internal/storage';
import type { FirebaseApp } from '../../app/types.js';
import type { StorageBackend } from '../persistence.js';
import type {
  CrossServiceIam,
  StorageDefaultPolicy,
  StorageService,
} from './running-service.js';

export type { StorageDefaultPolicy } from './running-service.js';

/** Default sandbox bucket key when no explicit bucket store is selected. */
export const DEFAULT_STORAGE_BUCKET = 'pyric-default';

/**
 * Hidden property on every {@link FirebaseStorage} handle carrying the sandbox
 * target state. Registered via `Symbol.for` so `src` and `dist` module copies
 * recognize handles across package boundaries.
 */
export const TARGET_SYMBOL: unique symbol = Symbol.for('pyric/storage/target') as never;

/** Sandbox target: IDB-backed, identity from `SandboxContext`, rules enforced in-process. */
export interface SandboxTarget {
  readonly kind: 'sandbox';
  readonly sandbox: Sandbox;
  readonly context: SandboxContext;
  /** App handles resolve auth at operation time; explicit contexts stay frozen. */
  readonly currentAuth?: () => AuthState;
  readonly bucket: string;
  /**
   * The name the caller knows this bucket by, which Storage rules see in place
   * of the store key `bucket`. Absent when the caller named none.
   */
  readonly bucketName?: string;
  readonly servicePromise: Promise<StorageService>;
  /** Rules-bypass admin plane (`getAdminStorageSandbox` via `pyric/storage/internal` only). */
  readonly admin?: boolean;
  /** The connection an operation-scoped handle serves; see `EventCaller`. */
  readonly caller?: EventCaller;
}

export type Target = SandboxTarget;

/** Public opaque handle carrying a {@link Target} via {@link TARGET_SYMBOL}. */
export interface FirebaseStorage {
  readonly [TARGET_SYMBOL]: Target;
  readonly app?: FirebaseApp;
  maxOperationRetryTime: number;
  maxUploadRetryTime: number;
}

/** Storage handle returned by Firebase-shaped app overloads. */
export type AppFirebaseStorage = FirebaseStorage & { readonly app: FirebaseApp };

/** Options for `getStorageSandbox`. */
export interface StorageOptions {
  /** Bucket identifier used to isolate storage persistence across multiple buckets. */
  bucket?: string;
  /** Override the IndexedDB database name (honored on the first call per `Sandbox`). */
  dbName?: string;
  /** Project identity used to derive the default IndexedDB database name. */
  projectId?: string;
  /** Storage rules source, parsed eagerly on the first call per `Sandbox`. */
  rules?: string;
  /** Production Storage-to-Firestore IAM posture, defaults to `'granted'`. */
  crossServiceIam?: CrossServiceIam;
  /** Default policy when no rules are configured: `'deny'` by default, `'allow'` in permissive mode. */
  defaultPolicy?: StorageDefaultPolicy;
}

/** Everything one `Sandbox` opened its storage service with. */
interface OpenStorageService {
  readonly service: Promise<StorageService>;
  readonly rulesSource: string | null;
  readonly compiledRules: StorageRules | null;
  readonly rulesResolution: StorageRulesResolution | null;
  readonly crossServiceIam: CrossServiceIam;
  readonly defaultPolicy: StorageDefaultPolicy;
  readonly rulesLocked: boolean;
  readonly crossServiceIamLocked: boolean;
  readonly defaultPolicyLocked: boolean;
}

/** The rules deployed to one bucket, by name. */
export interface BucketRules {
  readonly source: string;
  readonly rules: StorageRules;
  readonly resolution: StorageRulesResolution;
}

export interface StorageServiceCaches {
  readonly openServices: WeakMap<Sandbox, OpenStorageService>;
  readonly hostBackends: WeakMap<Sandbox, StorageBackend>;
  readonly scopedServices: WeakMap<Sandbox, Map<string, Promise<StorageService>>>;
  readonly sandboxHandles: WeakMap<SandboxContext, Map<string, FirebaseStorage>>;
  readonly bareSandboxHandles: WeakMap<Sandbox, Map<string, FirebaseStorage>>;
  readonly adminContextHandles: WeakMap<SandboxContext, Map<string, FirebaseStorage>>;
  readonly bareAdminHandles: WeakMap<Sandbox, Map<string, FirebaseStorage>>;
  bucketRules?: WeakMap<Sandbox, Map<string, BucketRules>>;
  defaultStoreNames?: WeakMap<Sandbox, string>;
  claimedDefaultNames?: WeakMap<Sandbox, Set<string>>;
  undeployedPolicies?: WeakMap<Sandbox, StorageDefaultPolicy>;
  noticedUndeployedBuckets?: WeakMap<Sandbox, Set<string>>;
}

const SERVICE_CACHES_KEY = Symbol.for('pyric.storage.service-caches');
const globalServiceCaches = globalThis as { [SERVICE_CACHES_KEY]?: StorageServiceCaches };

if (globalServiceCaches[SERVICE_CACHES_KEY] === undefined) {
  globalServiceCaches[SERVICE_CACHES_KEY] = {
    openServices: new WeakMap(),
    hostBackends: new WeakMap(),
    scopedServices: new WeakMap(),
    sandboxHandles: new WeakMap(),
    bareSandboxHandles: new WeakMap(),
    adminContextHandles: new WeakMap(),
    bareAdminHandles: new WeakMap(),
  };
}

export const serviceCaches: StorageServiceCaches = globalServiceCaches[SERVICE_CACHES_KEY] as StorageServiceCaches;

if (serviceCaches.bucketRules === undefined) {
  serviceCaches.bucketRules = new WeakMap();
}
if (serviceCaches.defaultStoreNames === undefined) {
  serviceCaches.defaultStoreNames = new WeakMap();
}
if (serviceCaches.claimedDefaultNames === undefined) {
  serviceCaches.claimedDefaultNames = new WeakMap();
}
if (serviceCaches.undeployedPolicies === undefined) {
  serviceCaches.undeployedPolicies = new WeakMap();
}
if (serviceCaches.noticedUndeployedBuckets === undefined) {
  serviceCaches.noticedUndeployedBuckets = new WeakMap();
}

export const BUCKET_RULES = serviceCaches.bucketRules as WeakMap<Sandbox, Map<string, BucketRules>>;
export const DEFAULT_STORE_NAMES = serviceCaches.defaultStoreNames as WeakMap<Sandbox, string>;
export const CLAIMED_DEFAULT_NAMES = serviceCaches.claimedDefaultNames as WeakMap<Sandbox, Set<string>>;
export const UNDEPLOYED_POLICIES = serviceCaches.undeployedPolicies as WeakMap<Sandbox, StorageDefaultPolicy>;
export const NOTICED_UNDEPLOYED_BUCKETS = serviceCaches.noticedUndeployedBuckets as WeakMap<Sandbox, Set<string>>;

/** Whether a handle addresses the app's default bucket store. */
export function addressesDefaultBucket(target: SandboxTarget): boolean {
  return target.bucket === DEFAULT_STORAGE_BUCKET;
}

/** Extract the {@link Target} from a handle; throws TypeError on unrecognized objects. */
export function targetOf(storage: FirebaseStorage): Target {
  const candidate = (storage as { [TARGET_SYMBOL]?: Target })[TARGET_SYMBOL];
  if (!candidate) {
    throw new TypeError(
      'pyric/storage: not a FirebaseStorage handle -- was it produced by getStorageSandbox?',
    );
  }
  return candidate;
}

/** Fetch the backing `StorageService` promise for a sandbox handle. */
export function getStorageService(storage: FirebaseStorage): Promise<StorageService> {
  return targetOf(storage).servicePromise;
}
