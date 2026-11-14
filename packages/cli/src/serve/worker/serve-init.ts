import { getMessagingBroker } from 'pyric/messaging/internal';
import { doc } from 'pyric/firestore';
import { seedDocuments, setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import { sandbox as rtdbSandbox } from 'pyric/database';
import { sandbox as authOps, type SeedUser } from 'pyric/auth';
import {
  applyStorageRulesUpdate,
  installServedStorageRules,
  storageRulesUpdateNotice,
  type StorageRulesUpdate,
} from '../storage-rules-install.js';
import { decodeSnapshotMap } from 'pyric/sandbox/internal';
import type { InitPayload } from '../namespace.js';
import { avatarMintForPayload } from '../assets/avatar-url.js';
import { ensureAuth, type HostCtx } from './host.js';
import { defaultInstanceNameOf, rtdbInstance } from './host/rtdb-instances.js';
import { liveCallValues } from './host/observe.js';
import {
  databaseInstanceRulesHost,
  deployFirestoreRulesToHost,
  firestoreRuleMessages,
  resolvePendingDatabaseTargets,
  setDatabaseRules,
  setDatabaseTargetRules,
} from './host/rules.js';
import { connectDatabaseInstanceRules, createPendingDatabaseTargets } from '../database-instance-rules-host.js';
import { buildVerifyFixture } from '../../verify/fixture.js';
import { captureRtdbInstances, defaultInstanceUrl } from '../../verify/rtdb-instance-capture.js';

export {
  buildWorkerCtx,
  hydrateEventHistory,
  MAX_PRIMED_EVENTS,
  WORKER_PERSISTENCE_KEY,
  workerPersistenceKey,
  type WorkerBootEnv,
} from './worker-boot.js';

const CAPTURE_MAX_DELAY_MS = 2_000;

/** Injected environment — `fetch` is the only ambient the worker init needs. */
export interface ServeInitEnv {
  fetch: typeof fetch;
  /** Capture coalescing window (ms), measured from the first pending event. Default 400. */
  captureDebounceMs?: number;
}

/** Minimal EventSource surface the worker hot-reload needs. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

/**
 * Re-deploy rules to the worker's sandbox when `pyric dev` hot-reloads rules.
 */
export function setupWorkerHotReload(
  ctx: HostCtx,
  makeEventSource: (url: string) => EventSourceLike,
): () => void {
  const events = makeEventSource('/__pyric/events');
  events.addEventListener('rules-changed', (ev) => {
    try {
      const { rules } = JSON.parse(ev.data) as { rules: string; rulesHash?: string };
      const deployed = deployFirestoreRulesToHost(ctx, rules);
      if (deployed.rejectionMessage !== null) throw new Error(deployed.rejectionMessage);
    } catch (err) {
      let reason = String(err);
      if (err instanceof Error) reason = err.message;
      // eslint-disable-next-line no-console
      console.error('[pyric worker] rules hot-reload failed:', reason);
    }
  });
  events.addEventListener('rtdb-rules-update', (ev) => {
    try {
      const { instance: name, target, rules, policy } = JSON.parse(ev.data) as {
        instance?: string;
        target?: string;
        rules: { rules: Record<string, unknown> } | null;
        rulesHash?: string | null;
        policy?: 'allow' | 'deny';
      };
      if (target !== undefined) {
        const deployed = setDatabaseTargetRules(ctx, target, rules);
        if (!deployed.ok) throw new Error(`Realtime Database rules not loaded: ${deployed.messages.map((message) => message.text).join('; ')}`);
        const verb = rules === null ? 'removed' : 'hot-reloaded';
        // eslint-disable-next-line no-console
        console.info(`[pyric worker] Realtime Database rules of deploy target "${target}" ${verb}`);
        return;
      }
      const label = name === undefined ? 'the default instance' : `instance "${name}"`;
      if (rules === null) {
        const instance = rtdbInstance(ctx, name);
        const resolvedPolicy = policy ?? 'deny';
        rtdbSandbox.setDefaultPolicy(instance.live, resolvedPolicy);
        rtdbSandbox.setRules(instance.live, null);
        delete instance.rules;
        // eslint-disable-next-line no-console
        console.info(`[pyric worker] Realtime Database rules of ${label} removed; reads/writes default to ${resolvedPolicy}`);
        return;
      }
      const deployed = setDatabaseRules(ctx, name, rules);
      if (!deployed.ok) {
        throw new Error(`Realtime Database rules not loaded: ${deployed.messages.map((message) => message.text).join('; ')}`);
      }
      // eslint-disable-next-line no-console
      console.info(`[pyric worker] Realtime Database rules of ${label} hot-reloaded`);
    } catch (err) {
      let errorMessage = String(err);
      if (err instanceof Error) errorMessage = err.message;
      // eslint-disable-next-line no-console
      console.error('[pyric worker] database rules hot-reload failed:', errorMessage);
    }
  });
  events.addEventListener('storage-rules-update', (ev) => {
    void (async () => {
      const update = JSON.parse(ev.data) as StorageRulesUpdate;
      await applyStorageRulesUpdate(ctx.sandbox, update);
      // eslint-disable-next-line no-console
      console.info(`[pyric worker] ${storageRulesUpdateNotice(update)}`);
    })().catch((err: unknown) => {
      let errorMessage = String(err);
      if (err instanceof Error) errorMessage = err.message;
      // eslint-disable-next-line no-console
      console.error('[pyric worker] storage rules hot-reload failed:', errorMessage);
    });
  });
  return () => events.close();
}

/** What `applyServeInit` did — surfaced for diagnostics + tests. */
export interface ServeInitResult {
  rulesDeployed: boolean;
  storageRulesDeployed: boolean;
  seededDocs: number;
  seededUsers: number;
  captureEnabled: boolean;
  messagingEnabled: boolean;
  rulesParseError: string | null;
  seedSkipped: 'existing-data' | null;
  dispose(): void;
}

function sandboxHasExistingData(ctx: HostCtx): boolean {
  const docs = snapshotDocuments(ctx.sandbox);
  if (Object.keys(docs).length > 0) return true;
  const auth = ensureAuth(ctx);
  return authOps.exportUsers(auth).length > 0;
}

const SANDBOX_SEED_SECTION_KEYS: ReadonlySet<string> = new Set([
  'firestore',
  'database',
  'users',
  'storage',
  'firestoreRules',
  'databaseRules',
  'storageRules',
]);

function isPlainSeedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeedableDatabaseRoot(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return true;
  return isPlainSeedObject(value);
}

function isSandboxSeedEnvelope(seed: Record<string, unknown>): boolean {
  const keys = Object.keys(seed);
  return !('version' in seed) && keys.length > 0 && keys.every((key) => SANDBOX_SEED_SECTION_KEYS.has(key));
}

function decodeSeedDocuments(
  ctx: HostCtx,
  rawDocs: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const referenceDecoder = { create: (refPath: string) => doc(ctx.db, refPath) };
  const decoded: Record<string, Record<string, unknown>> = {};
  for (const [docPath, rawDoc] of Object.entries(rawDocs)) {
    if (!isPlainSeedObject(rawDoc)) continue;
    Object.defineProperty(decoded, docPath, {
      value: decodeSnapshotMap(rawDoc, referenceDecoder),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return decoded;
}

/**
 * Apply the init payload to the worker's sandbox.
 */
export function applyServeInit(
  ctx: HostCtx,
  payload: InitPayload,
  env: ServeInitEnv = { fetch: globalThis.fetch },
): ServeInitResult {
  const result: ServeInitResult = {
    rulesDeployed: false,
    storageRulesDeployed: false,
    seededDocs: 0,
    seededUsers: 0,
    captureEnabled: false,
    messagingEnabled: false,
    rulesParseError: null,
    seedSkipped: null,
    dispose: () => {},
  };

  if (payload.messaging === true) {
    getMessagingBroker(ctx.sandbox);
    ctx.messagingEnabled = true;
    result.messagingEnabled = true;
  }

  const avatarMint = avatarMintForPayload(payload.avatars);
  if (avatarMint) {
    authOps.setAvatarMint(ensureAuth(ctx), avatarMint);
  }

  if (payload.rules) {
    const rejection = rulesSourceRejection(payload.rules);
    if (rejection !== null) {
      result.rulesParseError = `Firestore ${rejection.message}`;
      console.error(
        '[pyric worker] firestore.rules not loaded, running WITHOUT your rules:',
        result.rulesParseError,
      );
    } else {
      const lint = setRules(ctx.sandbox, payload.rules);
      result.rulesDeployed = true;
      ctx.activeRules ??= {};
      ctx.activeRules.firestore = {
        source: payload.rules,
        lastKnownGood: payload.rules,
        updatedAt: Date.now(),
        status: 'active',
        messages: firestoreRuleMessages(lint),
      };
    }
  }

  ctx.rtdbDefaultPolicy = payload.permissive ? 'allow' : 'deny';
  const instances = payload.databaseInstances;
  if (instances) ctx.defaultRtdbInstance = instances.defaultInstance;
  if (instances?.projectId) ctx.rtdbProjectId = instances.projectId;
  if (instances?.rulesFiles) ctx.rtdbRulesFiles = instances.rulesFiles;
  const rtdb = rtdbInstance(ctx);
  rtdbSandbox.setDefaultPolicy(rtdb.live, ctx.rtdbDefaultPolicy);
  if (instances) {
    ctx.pendingDatabaseTargets = createPendingDatabaseTargets(instances.pendingTargets);
    try {
      connectDatabaseInstanceRules(databaseInstanceRulesHost(ctx), instances);
    } catch (error) {
      let detail: string;
      if (error instanceof Error) {
        detail = error.message;
      } else {
        detail = String(error);
      }
      throw new Error(`database rules not loaded in the sandbox: ${detail}`);
    }
    resolvePendingDatabaseTargets(ctx);
  } else if (payload.databaseRules) {
    const refusal = rtdbRulesSourceRejection(payload.databaseRules);
    if (refusal !== null) throw new Error(`database.rules.json not loaded in the sandbox: ${refusal.message}`);
    rtdbSandbox.setRules(rtdb.live, payload.databaseRules);
    rtdb.rules = {
      source: payload.databaseRules,
      updatedAt: Date.now(),
      status: 'active',
      messages: [],
    };
  }

  for (const notice of installServedStorageRules(ctx.sandbox, payload)) console.info(`[pyric] ${notice}`);
  const deploysBucketRules = Object.keys(payload.storageBucketRules ?? {}).length > 0;
  if (payload.storageRules || deploysBucketRules) {
    result.storageRulesDeployed = true;
  }

  const hasSeedDocuments = payload.seed !== null && Object.keys(payload.seed).length > 0;
  const hasAuthUsers = Boolean(payload.authUsers?.length);
  const hasFixtureData = hasSeedDocuments || hasAuthUsers;
  const hasExistingData = hasFixtureData && sandboxHasExistingData(ctx);
  const restoresAuthUsers = payload.persist || Boolean(payload.seedState);
  const skipsFixture = hasExistingData && (hasSeedDocuments || !restoresAuthUsers);
  if (skipsFixture) {
    result.seedSkipped = 'existing-data';
    console.info(
      '[pyric worker] --seed skipped: the sandbox already has restored data (persisted state or ' +
        'an earlier session in this browser) — the fixture would have overwritten it. Use ' +
        '`--persist --fresh` to discard existing state and re-seed from scratch.',
    );
  }

  const mayRestoreUsers = !hasExistingData || restoresAuthUsers;
  if (hasAuthUsers && mayRestoreUsers) {
    const auth = ensureAuth(ctx);
    const existing = authOps.exportUsers(auth);
    const users = (payload.authUsers as unknown as ReadonlyArray<SeedUser>).filter(user =>
      !existing.some(record => record.tenantId === user.tenantId && (
        record.uid === user.uid || (user.email && record.email?.toLowerCase() === user.email.toLowerCase())
      )),
    );
    authOps.seedUsers(auth, users);
    result.seededUsers = users.length;
  }

  if (!hasExistingData && payload.seed && Object.keys(payload.seed).length > 0) {
    const rawSeed = payload.seed as Record<string, unknown>;
    if (isSandboxSeedEnvelope(rawSeed)) {
      let firestoreSection: Record<string, Record<string, unknown>> = {};
      if (isPlainSeedObject(rawSeed.firestore)) {
        firestoreSection = rawSeed.firestore as Record<string, Record<string, unknown>>;
      }
      const decodedDocs = decodeSeedDocuments(ctx, firestoreSection);
      if (Object.keys(decodedDocs).length > 0) {
        seedDocuments(ctx.sandbox, decodedDocs);
        result.seededDocs = Object.keys(decodedDocs).length;
      }
      if (isPlainSeedObject(rawSeed.database)) {
        rtdbSandbox.setData(rtdb.live, rawSeed.database);
      } else if (isSeedableDatabaseRoot(rawSeed.database)) {
        rtdbSandbox.setData(rtdb.live, { '/': rawSeed.database });
      }
    } else {
      const decodedDocs = decodeSeedDocuments(ctx, payload.seed);
      seedDocuments(ctx.sandbox, decodedDocs);
      result.seededDocs = Object.keys(decodedDocs).length;
    }
  }

  if (payload.capture) {
    const captureIntervalMs = env.captureDebounceMs ?? 400;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let dirty = false;
    let dirtySince: number | undefined;
    let disposed = false;

    const postCapture = async (): Promise<void> => {
      const defaultLive = rtdbInstance(ctx).live;
      const shouldSnapshotRtdb =
        Boolean(payload.databaseRules) || ctx.sandbox.history().some((event) => event.service === 'rtdb');
      let rtdbState: ReturnType<typeof rtdbSandbox.snapshotState> | undefined;
      if (shouldSnapshotRtdb) {
        rtdbState = rtdbSandbox.snapshotState(defaultLive, { includePriorities: true });
      }
      const defaultInstance = defaultInstanceNameOf(ctx);
      const auth = ensureAuth(ctx);
      const body = JSON.stringify(buildVerifyFixture({
        sandbox: ctx.sandbox,
        firestoreRules: payload.rules,
        rtdbRules: payload.databaseRules ?? null,
        rtdbState,
        rtdbDatabaseUrl: defaultInstanceUrl(defaultInstance),
        rtdbInstances: captureRtdbInstances(ctx.sandbox, defaultInstance),
        authState: {
          users: authOps.exportUsers(auth),
          currentUser: ctx.sandbox.currentUser,
        },
        capturedBy: ctx.instanceId,
        observedCalls: Object.fromEntries(liveCallValues(ctx.sandbox)),
      }));
      const captureHeaders: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (payload.sessionToken) {
        captureHeaders['x-pyric-session-token'] = payload.sessionToken;
      }
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), CAPTURE_MAX_DELAY_MS);
      try {
        await env.fetch('/__pyric/capture', {
          method: 'POST',
          headers: captureHeaders,
          body,
          signal: controller.signal,
        }).catch(() => {});
      } finally {
        clearTimeout(deadline);
      }
    };

    const schedule = (): void => {
      if (disposed || timer !== null || inFlight !== null) return;
      const startedAt = dirtySince ?? performance.now();
      const remaining = startedAt + CAPTURE_MAX_DELAY_MS - performance.now();
      const delay = Math.max(0, Math.min(captureIntervalMs, remaining));
      timer = setTimeout(() => { timer = null; void flush().catch(() => {}); }, delay);
    };

    const flush = async (): Promise<void> => {
      while (inFlight) await inFlight;
      if (disposed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;
      dirtySince = undefined;
      inFlight = postCapture();
      try { await inFlight; }
      finally {
        inFlight = null;
        if (dirty) schedule();
      }
    };

    const unsub = ctx.sandbox.onEvent(() => {
      dirty = true;
      dirtySince ??= performance.now();
      schedule();
    });

    result.captureEnabled = true;
    ctx.captureFlush = flush;
    result.dispose = (): void => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsub();
      ctx.captureFlush = undefined;
    };
  }

  return result;
}
