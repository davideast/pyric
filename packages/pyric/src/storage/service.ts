/**
 * Service module -- sandbox handles and factories.
 *
 * The public `FirebaseStorage` handle carries a `TARGET_SYMBOL` field pointing
 * to the sandbox state every operation needs (IDB service, rules, identity,
 * bucket, and admin lens). The IDB-backed `StorageService` is shared per
 * `Sandbox`, while `getStorageSandbox(ctx)` is identity-stable per context.
 */
import { SandboxContextImpl } from 'pyric/sandbox';
import type { Sandbox, SandboxContext } from 'pyric/sandbox';
import { bindOperationContext } from 'pyric/sandbox/internal';
import {
  compileStorageRules,
  rulesBucketName,
  type StorageRules,
  type StorageRulesResolution,
} from '@pyric/rules/internal/storage';
import { createStorageRetryHandle } from './handle-retry-times.js';
import { openStorageBackend, storageDbName, type StorageBackend } from './persistence.js';
import { deployStorageBucketRules } from './sandbox/bucket-rules.js';
import { StorageService, type CrossServiceIam } from './sandbox/running-service.js';
import {
  DEFAULT_STORAGE_BUCKET,
  serviceCaches,
  TARGET_SYMBOL,
  type FirebaseStorage,
  type SandboxTarget,
  type StorageOptions,
} from './sandbox/service-caches.js';

export { StorageService, type CrossServiceIam } from './sandbox/running-service.js';
export {
  getStorageService,
  TARGET_SYMBOL,
  targetOf,
  type AppFirebaseStorage,
  type FirebaseStorage,
  type SandboxTarget,
  type StorageOptions,
  type Target,
} from './sandbox/service-caches.js';
export {
  compiledStorageRulesForBucket,
  deployStorageBucketRules,
  getStorageRulesResolution,
  lockUndeployedStorageBuckets,
  storageBucketsWithRules,
  storageRulesInForce,
  type StorageRulesInForce,
} from './sandbox/bucket-rules.js';
export {
  bindStorageOperationContext,
  nameStorageBucket,
  storageAuth,
  storageOperationProvenance,
} from './sandbox/handle-provenance.js';

const OPEN_SERVICES = serviceCaches.openServices;
const HOST_BACKENDS = serviceCaches.hostBackends;
const SCOPED_SERVICES = serviceCaches.scopedServices;
const SANDBOX_HANDLES = serviceCaches.sandboxHandles;
const BARE_SANDBOX_HANDLES = serviceCaches.bareSandboxHandles;
const ADMIN_CONTEXT_HANDLES = serviceCaches.adminContextHandles;
const BARE_ADMIN_HANDLES = serviceCaches.bareAdminHandles;

/** Hosts install their durable backend before any Storage service is created. */
export function installStorageBackend(sandbox: Sandbox, backend: StorageBackend): void {
  const alreadyOpened = OPEN_SERVICES.has(sandbox) || HOST_BACKENDS.has(sandbox);
  if (alreadyOpened) {
    throw new Error('Storage backend must be installed once, before Storage initializes.');
  }
  HOST_BACKENDS.set(sandbox, backend);
}

function getOrCreateScopedService(
  sandbox: Sandbox,
  bucket: string,
  rootServicePromise: Promise<StorageService>,
): Promise<StorageService> {
  let bucketMap = SCOPED_SERVICES.get(sandbox);
  if (!bucketMap) {
    bucketMap = new Map();
    SCOPED_SERVICES.set(sandbox, bucketMap);
  }
  let existing = bucketMap.get(bucket);
  if (!existing) {
    existing = rootServicePromise.then((rootService) => {
      let backend = rootService.backend;
      if (rootService.backend.scoped !== undefined) {
        backend = rootService.backend.scoped(bucket);
      }
      return new StorageService(backend, rootService.rules, rootService.crossServiceIam);
    });
    bucketMap.set(bucket, existing);
  }
  return existing;
}

/**
 * Reject a late option that differs from the one the service is already open
 * with. Both `rules` and `crossServiceIam` are honored only on the FIRST
 * storage call per `Sandbox`.
 */
function rejectDifferingLateConfig(
  option: string,
  descriptor: string,
  supplied: string | undefined,
  openedWith: string | null,
  caller: string,
): void {
  if (supplied === undefined || supplied === openedWith) return;
  let openedDescription = `with a different ${descriptor}`;
  if (openedWith === null) {
    openedDescription = `without ${option}`;
  }
  throw new Error(
    `pyric/storage: ${caller} received a ${descriptor}, but this sandbox's storage service ` +
      `is already open ${openedDescription}. ${option} is honored only on the FIRST storage ` +
      'call per Sandbox, so this value would be silently discarded. Configure it on the first ' +
      'storage call for this sandbox.',
  );
}

/**
 * Install a new ruleset into a sandbox's storage service, replacing whatever
 * it is enforcing. When `options.bucket` is provided, deploys to that bucket.
 */
export async function replaceStorageRules(
  sandbox: Sandbox,
  source: string | null,
  options: { bucket?: string } = {},
): Promise<void> {
  if (options.bucket !== undefined) {
    deployStorageBucketRules(sandbox, options.bucket, source);
    return;
  }
  let compiled: { rules: StorageRules | null; resolution: StorageRulesResolution | null } = {
    rules: null,
    resolution: null,
  };
  if (source !== null) {
    compiled = compileStorageRules(source);
  }
  const open = OPEN_SERVICES.get(sandbox);
  if (open === undefined) {
    if (source === null) return;
    await ensureService(sandbox, { rules: source }, 'replaceStorageRules');
    return;
  }
  OPEN_SERVICES.set(sandbox, {
    service: open.service,
    rulesSource: source,
    compiledRules: compiled.rules,
    rulesResolution: compiled.resolution,
    crossServiceIam: open.crossServiceIam,
    rulesLocked: true,
    crossServiceIamLocked: open.crossServiceIamLocked,
  });
  const root = await open.service;
  root.rules = compiled.rules;
  for (const scopedPromise of SCOPED_SERVICES.get(sandbox)?.values() ?? []) {
    const scoped = await scopedPromise;
    scoped.rules = compiled.rules;
  }
}

/** The cross-service IAM posture a sandbox's storage service is running under. */
export function getStorageCrossServiceIam(sandbox: Sandbox): CrossServiceIam {
  return OPEN_SERVICES.get(sandbox)?.crossServiceIam ?? 'granted';
}

/** Move a sandbox's storage service between granted and denied cross-service IAM states. */
export async function replaceCrossServiceIam(
  sandbox: Sandbox,
  mode: CrossServiceIam,
): Promise<void> {
  const open = OPEN_SERVICES.get(sandbox);
  if (open === undefined) {
    await ensureService(sandbox, { crossServiceIam: mode }, 'replaceCrossServiceIam');
    return;
  }
  OPEN_SERVICES.set(sandbox, {
    service: open.service,
    rulesSource: open.rulesSource,
    compiledRules: open.compiledRules,
    rulesResolution: open.rulesResolution,
    crossServiceIam: mode,
    rulesLocked: open.rulesLocked,
    crossServiceIamLocked: true,
  });
  const root = await open.service;
  root.crossServiceIam = mode;
  for (const scopedPromise of SCOPED_SERVICES.get(sandbox)?.values() ?? []) {
    const scoped = await scopedPromise;
    scoped.crossServiceIam = mode;
  }
}

function ensureService(
  sandbox: Sandbox,
  options: StorageOptions,
  caller: string,
): Promise<StorageService> {
  const isAdminCaller = caller === 'getAdminStorageSandbox';
  const existing = OPEN_SERVICES.get(sandbox);
  if (existing !== undefined) {
    if (existing.rulesLocked) {
      rejectDifferingLateConfig(
        'rules',
        'rules source',
        options.rules,
        existing.rulesSource,
        caller,
      );
    }
    if (existing.crossServiceIamLocked) {
      rejectDifferingLateConfig(
        'crossServiceIam',
        'crossServiceIam mode',
        options.crossServiceIam,
        existing.crossServiceIam,
        caller,
      );
    }

    const suppliedRules = options.rules;
    const suppliedIam = options.crossServiceIam;
    const adoptRules = !existing.rulesLocked && suppliedRules !== undefined;
    const adoptIam = !existing.crossServiceIamLocked && suppliedIam !== undefined;
    const nextRulesLocked = existing.rulesLocked || !isAdminCaller || suppliedRules !== undefined;
    const nextIamLocked =
      existing.crossServiceIamLocked || !isAdminCaller || suppliedIam !== undefined;

    if (
      !adoptRules &&
      !adoptIam &&
      nextRulesLocked === existing.rulesLocked &&
      nextIamLocked === existing.crossServiceIamLocked
    ) {
      return existing.service;
    }

    let nextRules = existing.compiledRules;
    let nextResolution = existing.rulesResolution;
    let nextRulesSource = existing.rulesSource;
    if (adoptRules && suppliedRules !== undefined) {
      if (suppliedRules.length > 0) {
        const compiled = compileStorageRules(suppliedRules);
        nextRules = compiled.rules;
        nextResolution = compiled.resolution;
      } else {
        nextRules = null;
        nextResolution = null;
      }
      nextRulesSource = suppliedRules;
    }
    let nextIam = existing.crossServiceIam;
    if (adoptIam && suppliedIam !== undefined) {
      nextIam = suppliedIam;
    }

    let nextService = existing.service;
    if (adoptRules || adoptIam) {
      nextService = existing.service.then((root) => {
        root.rules = nextRules;
        root.crossServiceIam = nextIam;
        return root;
      });
      const bucketMap = SCOPED_SERVICES.get(sandbox);
      if (bucketMap) {
        for (const [bucketKey, scopedPromise] of bucketMap.entries()) {
          bucketMap.set(
            bucketKey,
            Promise.all([nextService, scopedPromise]).then(([, scoped]) => {
              scoped.rules = nextRules;
              scoped.crossServiceIam = nextIam;
              return scoped;
            }),
          );
        }
      }
    }

    OPEN_SERVICES.set(sandbox, {
      service: nextService,
      rulesSource: nextRulesSource,
      compiledRules: nextRules,
      rulesResolution: nextResolution,
      crossServiceIam: nextIam,
      rulesLocked: nextRulesLocked,
      crossServiceIamLocked: nextIamLocked,
    });
    return nextService;
  }

  let rules: StorageRules | null = null;
  let resolution: StorageRulesResolution | null = null;
  const rulesSource = options.rules;
  if (typeof rulesSource === 'string' && rulesSource.length > 0) {
    const compiled = compileStorageRules(rulesSource);
    rules = compiled.rules;
    resolution = compiled.resolution;
  }

  const crossServiceIam = options.crossServiceIam ?? 'granted';
  const injectedBackend = HOST_BACKENDS.get(sandbox);
  let backendPromise: Promise<StorageBackend>;
  if (injectedBackend !== undefined) {
    backendPromise = Promise.resolve(injectedBackend);
  } else {
    let defaultBucket = DEFAULT_STORAGE_BUCKET;
    if (options.bucket !== undefined) {
      defaultBucket = rulesBucketName(options.bucket, options.bucket);
    }
    backendPromise = openStorageBackend(
      options.dbName ?? storageDbName(options.projectId),
      defaultBucket,
    );
  }
  const servicePromise = backendPromise.then(
    (backend) => new StorageService(backend, rules, crossServiceIam),
  );
  OPEN_SERVICES.set(sandbox, {
    service: servicePromise,
    rulesSource: options.rules ?? null,
    compiledRules: rules,
    rulesResolution: resolution,
    crossServiceIam,
    rulesLocked: !isAdminCaller || options.rules !== undefined,
    crossServiceIamLocked: !isAdminCaller || options.crossServiceIam !== undefined,
  });
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

function isContext(target: Sandbox | SandboxContext): target is SandboxContext {
  return (
    target instanceof SandboxContextImpl ||
    ('sandbox' in target && target.sandbox !== undefined)
  );
}

function resolveBucketOption(bucketOption: string | undefined): string {
  if (bucketOption !== undefined) {
    return rulesBucketName(bucketOption, bucketOption);
  }
  return DEFAULT_STORAGE_BUCKET;
}

/** Construct (or return cached) a sandbox-backed `FirebaseStorage` handle. */
export function getStorageSandbox(
  target: Sandbox | SandboxContext,
  options: StorageOptions = {},
): FirebaseStorage {
  const fromBareSandbox = !isContext(target);
  let sandbox: Sandbox;
  if (isContext(target)) {
    sandbox = target.sandbox;
  } else {
    sandbox = target;
  }

  const rootServicePromise = ensureService(sandbox, options, 'getStorageSandbox');
  const bucket = resolveBucketOption(options.bucket);

  if (fromBareSandbox) {
    const cachedBare = BARE_SANDBOX_HANDLES.get(sandbox)?.get(bucket);
    if (cachedBare) return cachedBare;
  }

  let ctx: SandboxContext;
  if (isContext(target)) {
    ctx = target;
  } else {
    ctx = target.withAuth(null);
  }
  const cached = SANDBOX_HANDLES.get(ctx)?.get(bucket);
  if (cached) return cached;

  const servicePromise = getOrCreateScopedService(sandbox, bucket, rootServicePromise);

  let currentAuth: SandboxTarget['currentAuth'];
  if (fromBareSandbox) {
    currentAuth = () => sandbox.currentUser;
  }
  const sandboxTarget: SandboxTarget = {
    kind: 'sandbox',
    sandbox,
    context: ctx,
    currentAuth,
    bucket,
    servicePromise,
  };
  const handle = createStorageRetryHandle<FirebaseStorage>({ [TARGET_SYMBOL]: sandboxTarget });

  let ctxMap = SANDBOX_HANDLES.get(ctx);
  if (!ctxMap) {
    ctxMap = new Map();
    SANDBOX_HANDLES.set(ctx, ctxMap);
  }
  ctxMap.set(bucket, handle);

  if (fromBareSandbox) {
    let bareMap = BARE_SANDBOX_HANDLES.get(sandbox);
    if (!bareMap) {
      bareMap = new Map();
      BARE_SANDBOX_HANDLES.set(sandbox, bareMap);
    }
    bareMap.set(bucket, handle);
  }
  return handle;
}

/** INTERNAL (`pyric/storage/internal` only) -- rules-bypass admin `FirebaseStorage` handle. */
export function getAdminStorageSandbox(
  target: Sandbox | SandboxContext,
  options: StorageOptions = {},
): FirebaseStorage {
  const fromBareSandbox = !isContext(target);
  let sandbox: Sandbox;
  if (isContext(target)) {
    sandbox = target.sandbox;
  } else {
    sandbox = target;
  }

  const rootServicePromise = ensureService(sandbox, options, 'getAdminStorageSandbox');
  const bucket = resolveBucketOption(options.bucket);

  if (fromBareSandbox) {
    const cachedBare = BARE_ADMIN_HANDLES.get(sandbox)?.get(bucket);
    if (cachedBare) return cachedBare;
  }

  let baseContext: SandboxContext;
  if (isContext(target)) {
    baseContext = target;
  } else {
    baseContext = sandbox.withAuth(null);
  }
  let context = baseContext;
  if (baseContext.operationContext.authLens.mode !== 'admin') {
    const planId = baseContext.operationContext.planId;
    if (planId === undefined) {
      context = bindOperationContext(baseContext, {
        source: baseContext.operationContext.source,
        authLens: { mode: 'admin' },
      });
    } else {
      context = bindOperationContext(baseContext, {
        source: baseContext.operationContext.source,
        authLens: { mode: 'admin' },
        planId,
      });
    }
  }
  const cached = ADMIN_CONTEXT_HANDLES.get(baseContext)?.get(bucket);
  if (cached) return cached;

  const servicePromise = getOrCreateScopedService(sandbox, bucket, rootServicePromise);

  const sandboxTarget: SandboxTarget = {
    kind: 'sandbox',
    sandbox,
    context,
    bucket,
    servicePromise,
    admin: true,
  };
  const handle = createStorageRetryHandle<FirebaseStorage>({ [TARGET_SYMBOL]: sandboxTarget });

  let ctxMap = ADMIN_CONTEXT_HANDLES.get(baseContext);
  if (!ctxMap) {
    ctxMap = new Map();
    ADMIN_CONTEXT_HANDLES.set(baseContext, ctxMap);
  }
  ctxMap.set(bucket, handle);

  if (fromBareSandbox) {
    let bareMap = BARE_ADMIN_HANDLES.get(sandbox);
    if (!bareMap) {
      bareMap = new Map();
      BARE_ADMIN_HANDLES.set(sandbox, bareMap);
    }
    bareMap.set(bucket, handle);
  }
  return handle;
}
