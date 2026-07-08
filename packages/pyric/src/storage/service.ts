/**
 * Service module — handles, factories, and target-discriminated
 * routing. Mirrors `pyric/firestore`'s dual-target shape so the same
 * playground (or any consumer) can switch from a `pyric/sandbox`-
 * backed IDB store to a real Firebase Storage bucket by swapping the
 * factory call.
 *
 * The public `FirebaseStorage` handle is opaque — it carries a
 * `TARGET_SYMBOL` field pointing to an internal `Target` discriminator
 * that every operation reads to decide between the sandbox path
 * (IDB + rules-eval) and the prod path (delegate to `firebase/storage`).
 *
 * Caching:
 *
 * - **Per `Sandbox`** — the IDB-backed `StorageService` is shared.
 *   Two `getStorageSandbox` calls on the same sandbox hit the same
 *   backend.
 * - **Per `SandboxContext`** — the sandbox `FirebaseStorage` handle
 *   is identity-stable. `getStorageSandbox(ctx)` twice returns the
 *   same object.
 * - **Prod** — each `getStorageProd(app)` returns a fresh handle.
 *   `firebase/storage` itself caches per-app under the hood, so this
 *   is cheap; we don't add a layer.
 *
 * Internal access:
 *
 * `getStorageService(storage)` returns the backing
 * `Promise<StorageService>` for sandbox handles. Throws on prod
 * handles — prod ops never need it.
 */
import { SandboxContextImpl } from 'pyric/sandbox';
import type { Sandbox, SandboxContext } from 'pyric/sandbox';
import type { FirebaseApp } from 'firebase/app';
import * as fb from 'firebase/storage';
import { openStorageBackend, type StorageBackend } from './persistence.js';
import { parseStorageRules, type StorageRules } from './rules.js';

/**
 * Default sandbox bucket identifier. v1 has a single implicit
 * bucket; the field is recorded on every uploaded metadata record
 * so consumer code can round-trip it.
 */
const DEFAULT_BUCKET = 'pyric-default';

/**
 * Hidden property on every {@link FirebaseStorage} handle. Carries
 * the target discriminator so free functions can route between
 * sandbox + prod backends without consumer-visible API differences.
 */
export const TARGET_SYMBOL: unique symbol = Symbol('pyric/storage/target');

/**
 * Sandbox target — IDB-backed, identity from `SandboxContext`, rules
 * enforced in-process via `enforce.ts`.
 */
export interface SandboxTarget {
  readonly kind: 'sandbox';
  readonly sandbox: Sandbox;
  readonly context: SandboxContext;
  readonly bucket: string;
  readonly servicePromise: Promise<StorageService>;
}

/**
 * Prod target — delegates to `firebase/storage`. The user's Firebase
 * Auth identity flows naturally through the underlying SDK; we don't
 * touch rules (they're enforced server-side).
 */
export interface ProdTarget {
  readonly kind: 'prod';
  readonly app: FirebaseApp;
  readonly fbStorage: fb.FirebaseStorage;
  readonly bucket: string;
}

export type Target = SandboxTarget | ProdTarget;

/**
 * Public opaque handle. Carries a {@link Target} via
 * {@link TARGET_SYMBOL}; never inspected by consumer code, which
 * interacts with storage only through {@link ref} and the operation
 * free functions.
 */
export interface FirebaseStorage {
  readonly [TARGET_SYMBOL]: Target;
}

/**
 * Internal sandbox service — owns the IDB connection + parsed rules.
 * Only constructed inside the sandbox `getStorageSandbox` path.
 */
export class StorageService {
  constructor(
    readonly backend: StorageBackend,
    readonly rules: StorageRules | null = null,
  ) {}
}

/** Options for {@link getStorageSandbox}. */
export interface StorageOptions {
  /**
   * Bucket identifier recorded on uploaded metadata. v1 has a
   * single implicit bucket and does not enforce cross-bucket
   * isolation — passing different values per call is accepted and
   * round-trips in metadata, but the data store is shared.
   */
  bucket?: string;
  /**
   * Override the IndexedDB database name. Production callers do
   * NOT pass this; they inherit the default `pyric-storage`. Tests
   * pass per-case unique names so state doesn't leak between runs.
   * Only takes effect on the FIRST call per `Sandbox`.
   */
  dbName?: string;
  /**
   * Storage rules source. Parsed eagerly so a malformed string
   * throws at config time. Only honored on the FIRST call per
   * `Sandbox`.
   */
  rules?: string;
}

/** Options for {@link getStorageProd}. */
export interface ProdStorageOptions {
  /**
   * Override the gs:// bucket the handle binds to. Defaults to the
   * project's primary bucket (whatever `app.options.storageBucket`
   * names). Pass a custom bucket name (`gs://my-extra-bucket`) to
   * target a non-default bucket.
   */
  bucket?: string;
}

// ─── Caches (sandbox-only — prod relies on firebase/storage's caching) ─

/** One `StorageService` per `Sandbox`. */
const SERVICES = new WeakMap<Sandbox, Promise<StorageService>>();

/** One sandbox `FirebaseStorage` handle per `SandboxContext`. */
const SANDBOX_HANDLES = new WeakMap<SandboxContext, FirebaseStorage>();

/**
 * One anonymous handle per bare `Sandbox`. `Sandbox.withAuth(null)`
 * mints a FRESH `SandboxContext` on every call, so the per-context
 * cache above would miss for the bare-`Sandbox` convenience path —
 * `getStorageSandbox(sandbox)` twice returned two different handles
 * (ST-B3). Caching on the `Sandbox` keeps that path identity-stable,
 * matching the documented "handle is identity-stable per Sandbox".
 */
const BARE_SANDBOX_HANDLES = new WeakMap<Sandbox, FirebaseStorage>();

/**
 * Type predicate distinguishing `SandboxContext` from `Sandbox`. We
 * use the class-identity test (every real `SandboxContext` is a
 * `SandboxContextImpl`) so the TS narrowing works downstream.
 */
function isContext(target: Sandbox | SandboxContext): target is SandboxContext {
  return target instanceof SandboxContextImpl;
}

/**
 * Construct (or return cached) a sandbox-backed `FirebaseStorage`
 * handle. Accepts either a bare `Sandbox` (anonymous identity wired
 * up via `sandbox.withAuth(null)`) or an explicit `SandboxContext`.
 * Idempotent on `SandboxContext` identity.
 */
export function getStorageSandbox(
  target: Sandbox | SandboxContext,
  options: StorageOptions = {},
): FirebaseStorage {
  const fromBareSandbox = !isContext(target);
  const sandbox: Sandbox = isContext(target) ? target.sandbox : target;

  // Fast path: a repeat bare-`Sandbox` call returns the cached
  // anonymous handle (the per-context cache below can't catch it
  // because `withAuth(null)` mints a fresh context each time). Like
  // the per-context path, bucket/dbName/rules options are honored
  // only on the FIRST call per Sandbox.
  if (fromBareSandbox) {
    const cachedBare = BARE_SANDBOX_HANDLES.get(sandbox);
    if (cachedBare) return cachedBare;
  }

  const ctx = isContext(target) ? target : target.withAuth(null);
  const bucket = options.bucket ?? DEFAULT_BUCKET;

  let servicePromise = SERVICES.get(sandbox);
  if (!servicePromise) {
    const rules = options.rules ? parseStorageRules(options.rules) : null;
    servicePromise = openStorageBackend(options.dbName).then(
      (backend) => new StorageService(backend, rules),
    );
    SERVICES.set(sandbox, servicePromise);
  }

  const cached = SANDBOX_HANDLES.get(ctx);
  if (cached) return cached;

  const sandboxTarget: SandboxTarget = {
    kind: 'sandbox',
    sandbox,
    context: ctx,
    bucket,
    servicePromise,
  };
  const handle: FirebaseStorage = Object.freeze({ [TARGET_SYMBOL]: sandboxTarget });
  SANDBOX_HANDLES.set(ctx, handle);
  if (fromBareSandbox) BARE_SANDBOX_HANDLES.set(sandbox, handle);
  return handle;
}

/**
 * Construct a `FirebaseStorage` handle backed by a real Firebase
 * project. The user's Firebase Auth identity flows naturally into
 * rule evaluation via the SDK's standard auth-state subscription —
 * Pyric doesn't manage the auth handshake, mirroring how
 * `firebase/storage`'s own `getStorage(app)` works.
 */
export function getStorageProd(
  app: FirebaseApp,
  options: ProdStorageOptions = {},
): FirebaseStorage {
  const fbStorage = options.bucket ? fb.getStorage(app, options.bucket) : fb.getStorage(app);
  // The bucket field is sourced from the SDK's resolved bucket, not
  // the option, so `gs://` prefixes / overrides round-trip correctly
  // in metadata.
  const bucket = fbRefBucket(fbStorage);
  const prodTarget: ProdTarget = { kind: 'prod', app, fbStorage, bucket };
  return Object.freeze({ [TARGET_SYMBOL]: prodTarget });
}

/**
 * The bucket name from a `firebase/storage` handle, read off the
 * root reference. `fb.ref(storage)` returns the root ref whose
 * `bucket` field is the canonical bucket name.
 */
function fbRefBucket(fbStorage: fb.FirebaseStorage): string {
  return fb.ref(fbStorage).bucket;
}

/**
 * Internal — extract the {@link Target} from a handle. Throws on
 * objects that weren't produced by a factory in this module.
 */
export function targetOf(storage: FirebaseStorage): Target {
  const t = (storage as { [TARGET_SYMBOL]?: Target })[TARGET_SYMBOL];
  if (!t) {
    throw new TypeError(
      'pyric/storage: not a FirebaseStorage handle — was it produced by getStorageSandbox or getStorageProd?',
    );
  }
  return t;
}

/**
 * Internal — fetch the backing `StorageService` promise for a
 * sandbox handle. Throws when called on a prod handle (prod ops
 * never need a service; this helper is sandbox-only).
 */
export function getStorageService(storage: FirebaseStorage): Promise<StorageService> {
  const target = targetOf(storage);
  if (target.kind !== 'sandbox') {
    throw new Error('getStorageService called on a prod-target handle — sandbox-only API');
  }
  return target.servicePromise;
}
