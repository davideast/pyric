/**
 * Service module — sandbox handles and factories.
 *
 * The public `FirebaseStorage` handle is opaque — it carries a
 * `TARGET_SYMBOL` field pointing to the sandbox state every operation
 * needs (IDB service, rules, identity, bucket, and admin lens).
 *
 * Caching:
 *
 * - **Per `Sandbox`** — the IDB-backed `StorageService` is shared.
 *   Two `getStorageSandbox` calls on the same sandbox hit the same
 *   backend.
 * - **Per `SandboxContext`** — the sandbox `FirebaseStorage` handle
 *   is identity-stable. `getStorageSandbox(ctx)` twice returns the
 *   same object.
 * Internal access:
 *
 * `getStorageService(storage)` returns the backing
 * `Promise<StorageService>` for sandbox handles.
 */
import { SandboxContextImpl } from 'pyric/sandbox';
import type { AuthState, EventProvenance, Sandbox, SandboxContext } from 'pyric/sandbox';
import type { FirebaseApp } from '../app/types.js';
import {
  bindOperationContext,
  provenanceForOperationContext,
  resolveOperationContext,
} from 'pyric/sandbox/internal';
import { openStorageBackend, storageDbName, type StorageBackend } from './persistence.js';
import { parseStorageRules, type StorageRules } from './sandbox/rules.js';
import { resolveModulesBrowser } from '../rules/modules/resolver-browser.js';
import {
  createStorageRulesResolution,
  type StorageRulesResolution,
} from './rules-resolution.js';

/**
 * Default sandbox bucket identifier. v1 has a single implicit
 * bucket; the field is recorded on every uploaded metadata record
 * so consumer code can round-trip it.
 */
const DEFAULT_BUCKET = 'pyric-default';

/**
 * Hidden property on every {@link FirebaseStorage} handle. Carries
 * the sandbox state free functions share without exposing it publicly.
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
  /** App handles resolve auth at operation time; explicit contexts stay frozen. */
  readonly currentAuth?: () => AuthState;
  readonly bucket: string;
  readonly servicePromise: Promise<StorageService>;
  /**
   * Rules-bypass admin plane. `true` only on handles minted by the
   * INTERNAL {@link getAdminStorageSandbox} factory (exported via
   * `pyric/storage/internal`, never the public surface): operations
   * on an admin handle skip rule evaluation entirely — the storage
   * mirror of `getAdminFirestore` / `getAdminDatabase`. The public
   * modular surface stays rules-honest; this exists so hosts (the
   * SharedWorker's `actAs: { mode: 'admin' }` lens) can serve
   * firebase-admin semantics against the same shared store.
   */
  readonly admin?: boolean;
}

export type Target = SandboxTarget;

export function storageAuth(target: SandboxTarget): AuthState {
  return target.currentAuth?.() ?? target.context.auth;
}

/**
 * Public opaque handle. Carries a {@link Target} via
 * {@link TARGET_SYMBOL}; never inspected by consumer code, which
 * interacts with storage only through {@link ref} and the operation
 * free functions.
 */
export interface FirebaseStorage {
  readonly [TARGET_SYMBOL]: Target;
  readonly app?: FirebaseApp;
}

/** Storage handle returned by Firebase-shaped app overloads. */
export type AppFirebaseStorage = FirebaseStorage & { readonly app: FirebaseApp };

/**
 * Cross-service IAM posture for `firestore.get()/exists()` in Storage rules.
 *
 * Production Storage rules can read Firestore ONLY when the project's
 * Storage service agent holds `roles/firebaserules.firestoreServiceAgent`.
 * `'granted'` (the default — the common configured-project state) serves
 * lookups from the same-sandbox Firestore store; `'denied'` makes every
 * EXECUTED lookup fail exactly like production without the role (error →
 * rule denies), while short-circuited lookups are never executed and stay
 * unaffected. Captured boundary: conformance observation
 * `stdlib-realstorage-p3-lookup-budget` (registry row storage-rules#134).
 */
export type CrossServiceIam = 'granted' | 'denied';

/**
 * Internal sandbox service — owns the IDB connection + parsed rules.
 * Only constructed inside the sandbox `getStorageSandbox` path.
 */
export class StorageService {
  constructor(
    readonly backend: StorageBackend,
    readonly rules: StorageRules | null = null,
    readonly crossServiceIam: CrossServiceIam = 'granted',
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
   * Override the IndexedDB database name. Tests pass per-case unique
   * names so state doesn't leak between runs.
   * Only takes effect on the FIRST call per `Sandbox`.
   */
  dbName?: string;
  /**
   * Project identity used to derive the default IndexedDB database name
   * (`pyric-storage:<projectId>` — see {@link storageDbName}). IndexedDB is
   * origin-scoped, so without this every project served on the same
   * localhost port shared one storage database (issue #359). Ignored when
   * an explicit `dbName` is given; only honored on the FIRST call per
   * `Sandbox`. Hosts pass their project identity here (`pyric sandbox` passes
   * the served project's key; app handles pass `options.projectId`).
   */
  projectId?: string;
  /**
   * Storage rules source. Parsed eagerly so a malformed string
   * throws at config time. Only honored on the FIRST call per
   * `Sandbox`.
   */
  rules?: string;
  /**
   * Model the production Storage→Firestore IAM dependency (see
   * {@link CrossServiceIam}). Defaults to `'granted'`. Like `rules`,
   * only honored on the FIRST storage call per `Sandbox`; a LATER,
   * DIFFERING value throws instead of silently flipping the mode.
   */
  crossServiceIam?: CrossServiceIam;
}

// ─── Caches ─────────────────────────────────────────────────────────

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
 * The rules SOURCE each sandbox's service was opened with (`null` when
 * opened without rules). Late-config detection: rules are honored only on
 * the FIRST storage call per `Sandbox`, so silently discarding a LATER,
 * DIFFERENT `rules` option would be a silent rules wipe — {@link
 * ensureService} throws instead. Re-supplying the IDENTICAL source stays
 * fine (idempotent multi-handle construction, e.g. per-user contexts).
 */
const SERVICE_RULES_SOURCE = new WeakMap<Sandbox, string | null>();
const SERVICE_RULES_RESOLUTION = new WeakMap<Sandbox, StorageRulesResolution | null>();

/**
 * The cross-service IAM mode each sandbox's service was opened with. Same
 * late-config hazard as rules: the mode is honored only on the FIRST storage
 * call per `Sandbox`, and silently discarding a LATER, DIFFERENT
 * `crossServiceIam` would silently re-open (or close) the false-ALLOW
 * surface the option models — {@link ensureService} throws instead.
 */
const SERVICE_CROSS_SERVICE_IAM = new WeakMap<Sandbox, CrossServiceIam>();

/**
 * Get (or open) the ONE per-sandbox `StorageService`. Loud on the
 * silent-rules-wipe hazard: when the service is already open and the
 * caller supplies a `rules` source differing from the one it was opened
 * with (including "opened without rules"), this throws — configure rules
 * on the first storage call for the sandbox instead.
 */
function ensureService(
  sandbox: Sandbox,
  options: StorageOptions,
  caller: string,
): Promise<StorageService> {
  const existing = SERVICES.get(sandbox);
  if (existing) {
    const openedWith = SERVICE_RULES_SOURCE.get(sandbox) ?? null;
    if (options.rules !== undefined && options.rules !== openedWith) {
      throw new Error(
        `pyric/storage: ${caller} received a rules source, but this sandbox's storage ` +
          `service is already open ${openedWith === null ? 'without rules' : 'with a different rules source'} ` +
          '— rules are honored only on the FIRST storage call per Sandbox, so these rules ' +
          'would be silently discarded. Configure rules on the first storage call for this sandbox.',
      );
    }
    const openedIam = SERVICE_CROSS_SERVICE_IAM.get(sandbox) ?? 'granted';
    if (options.crossServiceIam !== undefined && options.crossServiceIam !== openedIam) {
      throw new Error(
        `pyric/storage: ${caller} received crossServiceIam: '${options.crossServiceIam}', but this ` +
          `sandbox's storage service is already open with crossServiceIam: '${openedIam}' — the mode ` +
          'is honored only on the FIRST storage call per Sandbox, so this value would be silently ' +
          'discarded. Configure crossServiceIam on the first storage call for this sandbox.',
      );
    }
    return existing;
  }
  let rules: StorageRules | null = null;
  let resolution: StorageRulesResolution | null = null;
  if (options.rules) {
    let source = options.rules;
    let modules: readonly string[] = [];
    let bundledModules: readonly string[] = [];
    let moduleEvidenceIds: readonly string[] = [];
    rules = parseStorageRules(source);
    if (rules._version === '2+modules') {
      const resolved = resolveModulesBrowser(source);
      if (!resolved.success) {
        throw new SyntaxError(
          `Storage rules module resolution failed (${resolved.error.code}): ${resolved.error.message}`,
        );
      }
      source = resolved.data.resolved;
      modules = resolved.data.modules;
      bundledModules = resolved.data.bundledModules;
      moduleEvidenceIds = resolved.data.evidenceIds;
      rules = parseStorageRules(source);
    }
    resolution = createStorageRulesResolution(
      source,
      modules,
      bundledModules,
      moduleEvidenceIds,
      rules,
    );
  }
  // Explicit dbName wins; otherwise scope the default by project identity so
  // two projects on one origin never share a storage database (issue #359).
  const crossServiceIam = options.crossServiceIam ?? 'granted';
  const servicePromise = openStorageBackend(
    options.dbName ?? storageDbName(options.projectId),
  ).then(
    (backend) => new StorageService(backend, rules, crossServiceIam),
  );
  SERVICES.set(sandbox, servicePromise);
  SERVICE_RULES_SOURCE.set(sandbox, options.rules ?? null);
  SERVICE_RULES_RESOLUTION.set(sandbox, resolution);
  SERVICE_CROSS_SERVICE_IAM.set(sandbox, crossServiceIam);
  // Join the sandbox's persistable-service REGISTRY so `sandbox.resetAll()`
  // reaches storage (issue #359: Studio's reset cleared Firestore + auth but
  // never storage — storage was invisible to the sandbox). Storage does NOT
  // ride the persistence blob: it owns its durability (IndexedDB), and blobs
  // aren't JSON-serializable — so snapshot/restore are deliberate no-ops and
  // `reset` is the only live hook (clears both IDB object stores).
  sandbox.registerPersistableService('storage', {
    snapshot: () => null,
    restore: () => {},
    reset: async () => {
      const service = await servicePromise;
      await service.backend.reset();
    },
  });
  return servicePromise;
}

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

  // Open (or fetch) the ONE per-sandbox service FIRST — before any handle
  // cache fast-path — so a late, differing `rules` option throws instead of
  // being silently discarded (see ensureService).
  const servicePromise = ensureService(sandbox, options, 'getStorageSandbox');

  // Fast path: a repeat bare-`Sandbox` call returns the cached
  // anonymous handle (the per-context cache below can't catch it
  // because `withAuth(null)` mints a fresh context each time). Like
  // the per-context path, bucket/dbName options are honored only on
  // the FIRST call per Sandbox.
  if (fromBareSandbox) {
    const cachedBare = BARE_SANDBOX_HANDLES.get(sandbox);
    if (cachedBare) return cachedBare;
  }

  const ctx = isContext(target) ? target : target.withAuth(null);
  const bucket = options.bucket ?? DEFAULT_BUCKET;

  const cached = SANDBOX_HANDLES.get(ctx);
  if (cached) return cached;

  const sandboxTarget: SandboxTarget = {
    kind: 'sandbox',
    sandbox,
    context: ctx,
    currentAuth: fromBareSandbox ? () => sandbox.currentUser : undefined,
    bucket,
    servicePromise,
  };
  const handle: FirebaseStorage = Object.freeze({ [TARGET_SYMBOL]: sandboxTarget });
  SANDBOX_HANDLES.set(ctx, handle);
  if (fromBareSandbox) BARE_SANDBOX_HANDLES.set(sandbox, handle);
  return handle;
}

/** Admin handles are cached by bound context so Studio, agent, and
 * unattributed callers can share storage state without sharing provenance. */
const ADMIN_CONTEXT_HANDLES = new WeakMap<SandboxContext, FirebaseStorage>();
const BARE_ADMIN_HANDLES = new WeakMap<Sandbox, FirebaseStorage>();

/**
 * INTERNAL (exported via `pyric/storage/internal` only) — construct
 * (or return cached) the rules-BYPASS admin `FirebaseStorage` handle
 * for a sandbox or bound context. Shares the SAME `StorageService` (one IDB store, one
 * ruleset) as every rules-honest handle on that sandbox; only rule
 * evaluation is skipped (see {@link SandboxTarget.admin}). Bucket /
 * dbName / rules options follow the same first-call-per-`Sandbox`
 * semantics as {@link getStorageSandbox}.
 *
 * This is the storage mirror of `getAdminFirestore` /
 * `getAdminDatabase` — the handle the SharedWorker host resolves for
 * `actAs: { mode: 'admin' }` storage ops (firebase-admin semantics
 * over the bridge). Deliberately NOT on the public `pyric/storage`
 * surface so the modular API stays rules-honest.
 */
export function getAdminStorageSandbox(
  target: Sandbox | SandboxContext,
  options: StorageOptions = {},
): FirebaseStorage {
  const fromBareSandbox = !isContext(target);
  const sandbox = isContext(target) ? target.sandbox : target;
  // Service first (late differing `rules` must throw, even on a cache hit).
  const servicePromise = ensureService(sandbox, options, 'getAdminStorageSandbox');

  if (fromBareSandbox) {
    const cachedBare = BARE_ADMIN_HANDLES.get(sandbox);
    if (cachedBare) return cachedBare;
  }

  const baseContext = isContext(target) ? target : sandbox.withAuth(null);
  const context = baseContext.operationContext.authLens.mode === 'admin'
    ? baseContext
    : bindOperationContext(baseContext, {
        source: baseContext.operationContext.source,
        authLens: { mode: 'admin' },
        ...(baseContext.operationContext.planId === undefined
          ? {}
          : { planId: baseContext.operationContext.planId }),
      });
  const cached = ADMIN_CONTEXT_HANDLES.get(baseContext);
  if (cached) return cached;

  const sandboxTarget: SandboxTarget = {
    kind: 'sandbox',
    sandbox,
    context,
    bucket: options.bucket ?? DEFAULT_BUCKET,
    servicePromise,
    admin: true,
  };
  const handle: FirebaseStorage = Object.freeze({ [TARGET_SYMBOL]: sandboxTarget });
  ADMIN_CONTEXT_HANDLES.set(baseContext, handle);
  if (fromBareSandbox) BARE_ADMIN_HANDLES.set(sandbox, handle);
  return handle;
}

/** Merge a host override with the immutable provenance bound to a Storage
 * handle. The result is captured before awaits, so concurrent async
 * operations cannot exchange source or auth-lens identity. */
export function storageOperationProvenance(
  target: SandboxTarget,
  override?: EventProvenance,
): EventProvenance {
  const context = resolveOperationContext(
    override,
    provenanceForOperationContext(target.context.operationContext),
  );
  return {
    ...override,
    ...provenanceForOperationContext(context),
    service: 'storage',
  };
}

/** Return an operation-scoped view of a Storage handle. The backing service,
 * bucket, and admin/rules mode are shared; only immutable operation identity is
 * rebound. Worker hosts use this internal seam instead of extending Firebase's
 * public function signatures with host-only provenance arguments. */
export function bindStorageOperationContext(
  storage: FirebaseStorage,
  provenance: EventProvenance | undefined,
): FirebaseStorage {
  if (!provenance) return storage;
  const target = targetOf(storage);
  const context = resolveOperationContext(
    provenance,
    provenanceForOperationContext(target.context.operationContext),
  );
  const scopedTarget: SandboxTarget = {
    ...target,
    context: bindOperationContext(target.context, context),
  };
  return Object.freeze({ [TARGET_SYMBOL]: scopedTarget });
}

/**
 * Internal — extract the {@link Target} from a handle. Throws on
 * objects that weren't produced by a factory in this module.
 */
export function targetOf(storage: FirebaseStorage): Target {
  const t = (storage as { [TARGET_SYMBOL]?: Target })[TARGET_SYMBOL];
  if (!t) {
    throw new TypeError(
      'pyric/storage: not a FirebaseStorage handle — was it produced by getStorageSandbox?',
    );
  }
  return t;
}

/**
 * Internal — fetch the backing `StorageService` promise for a sandbox handle.
 */
export function getStorageService(storage: FirebaseStorage): Promise<StorageService> {
  return targetOf(storage).servicePromise;
}

/** Internal assurance seam for the exact rules source retained by Storage setup. */
export function getStorageRulesResolution(
  storage: FirebaseStorage,
): StorageRulesResolution | null {
  return SERVICE_RULES_RESOLUTION.get(targetOf(storage).sandbox) ?? null;
}
