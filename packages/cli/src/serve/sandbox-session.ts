import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative } from 'node:path';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { defaultAvatarSvg } from 'pyric/auth/internal';
import type { FirebaseJson } from '../cli/firebase-json.js';
import type { FirebaseProjectResolution } from '../cli/firebase-project.js';
import type { BeaconReport } from '../register/beacon.js';
import type { AppPorts } from './app-ports.js';
import { createAssetResolver, type AssetRequest, type AssetResolver } from './assets/resolver.js';
import type { ResolvedAvatarsConfig } from './avatars-config.js';
import { createCaptureStore, type CaptureStore } from './capture-store.js';
import type { FlowConfig } from './flow-config.js';
import { createFlowTreatmentHost } from './flow-treatment-host.js';
import type { GeminiProxyConfig } from './gemini-proxy.js';
import { createHostedPersistence, formatStorageRepairs, type HostedPersistence } from './hosted/persistence.js';
import { createIndexConfigStore } from './index-config-store.js';
import type { DatabaseInstancesRules, InitPayload, RtdbRulesJson, RulesDestination } from './init-payload.js';
import { createEventHub, createPyricNamespace } from './namespace.js';
import { createRateCaptureStore } from './rate-capture-store.js';
import {
  formatUnresolvedDatabaseTargets,
  formatUnresolvedStorageTargets,
  loadPendingStorageTarget,
  loadProjectDatabaseRules,
  loadProjectRules,
  loadProjectStorageRules,
} from './rules.js';
import { loadSandboxSeedOption, SandboxSeedError } from './sandbox-seed-loader.js';
import {
  createSessionRulesReloaders,
  type DatabaseRulesReloadResult,
  type RulesReloadResult,
  type StorageRulesReloadResult,
} from './sandbox-session-rules-reload.js';
import type { ServeLogger } from './server.js';
import { createStateStore, type StateStore } from './state-store.js';
import { restoredStateCounts } from './state-summary.js';
import { diskProjectStore, diskWorkspace } from './studio/index.js';
import { createThresholdConfigStore } from './threshold-config-store.js';

export { SandboxSeedError };
export type { DatabaseRulesReloadResult, RulesReloadResult, StorageRulesReloadResult };

export interface SandboxSessionOptions {
  boundHost?: string;
  allowedHosts?: string[];
  /** The app's ports under `pyric sandbox` (see `NamespaceOptions.appPorts`). */
  appPorts?: AppPorts;
  flow?: FlowConfig;
  projectDir: string;
  firebaseConfig: FirebaseJson | null;
  sdk: { dir: string; workerVersion?: string };
  seedFile?: string;
  capture?: boolean;
  persistence?: { fresh?: boolean };
  studio?: false | { siteUiDir?: string };
  bridgeUrl?: () => string | null;
  hosted?: boolean;
  /** The Node host's boot identity, served in `init.json` for Node processes to present. */
  hostInstanceId?: () => string | undefined;
  /** Deploys file rules to the Node sandbox. A null database or Storage source
   *  clears the rules, so the sandbox's default policy applies. */
  deployHostedRules?: (service: 'firestore' | 'database' | 'storage', source: string | null, destination?: RulesDestination) => Promise<void>;
  ai?: InitPayload['ai'];
  aiProxyUpstream?: string;
  /** The gemini engine the dev server's gemini proxy sends for a browser engine. */
  aiGemini?: GeminiProxyConfig;
  /** Resolved `avatars` option (already reduced by `avatars-config.ts`). */
  avatars?: ResolvedAvatarsConfig;
  permissive?: boolean;
  /** The project `resolveFirebaseProject` resolved. */
  project?: FirebaseProjectResolution;
  logger?: ServeLogger;
  activity?: (incident: ActivityIncident) => void;
  /** Receives one handshake beacon per pyric-launched child. */
  beacon?: (report: BeaconReport) => void;
  /** The per-launch secret a beacon must present, also placed in `PYRIC_BEACON_TOKEN`. */
  beaconToken?: string;
  /** Shared per-boot session capability token across namespace, bridge, and served HTML. */
  sessionToken?: string;
  /** Require `sessionToken` on every namespace route instead of only workspace/project and AI proxy routes. */
  requireSessionToken?: boolean;
}

export interface SandboxSessionSummary {
  rules: {
    firestore: { sourcePath: string | null; hash: string | null };
    /** Each Realtime Database instance whose rules loaded at startup. */
    database: Array<{ instance: string; sourcePath: string; hash: string }>;
    storage: { sourcePath: string | null; hash: string | null };
    /** Each Storage bucket `firebase.json` names, with the rules it loaded at startup. */
    storageBuckets: Array<{ bucket: string; sourcePath: string; hash: string }>;
  };
  persistence: null | {
    path: string;
    backupPath: string;
    restoredDocs: number;
    restoredUsers: number;
    restored: boolean;
    seedApplied: boolean;
  };
  capturePath: string | null;
  seedLabel: string | null;
  seedStaged: boolean;
  studioMounted: boolean;
}

export interface SandboxSession {
  readonly sessionToken: string;
  readonly hostedPersistence?: HostedPersistence;
  readonly summary: SandboxSessionSummary;
  payload(): InitPayload;
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean | Promise<boolean>;
  reloadFirestoreRules(): Promise<RulesReloadResult>;
  /** Reload the rules of each database instance that deploys `file`. */
  reloadDatabaseRules(file: string): Promise<DatabaseRulesReloadResult[]>;
  /** Reload the Storage rules of each bucket that deploys `file`. */
  reloadStorageRules(file: string): Promise<StorageRulesReloadResult[]>;
  firestoreRulesFiles(): readonly string[];
  databaseRulesFiles(): readonly string[];
  storageRulesFiles(): readonly string[];
  storageSourceFiles(): readonly string[];
  close(): Promise<void>;
}

function defaultAvatarFallback(
  req: AssetRequest,
  kind: 'fallback' | 'interim',
): { data: Uint8Array; contentType: string } {
  const displayName = typeof req.context.displayName === 'string' ? req.context.displayName : null;
  const email = typeof req.context.email === 'string' ? req.context.email : null;
  const svg = defaultAvatarSvg({ uid: req.key, displayName, email, pending: kind === 'interim' });
  return { data: new TextEncoder().encode(svg), contentType: 'image/svg+xml' };
}

function createAvatarsResolver(
  config: ResolvedAvatarsConfig | undefined,
  projectDir: string,
  onMaterialised: (key: string) => void,
): AssetResolver | undefined {
  if (!config?.enabled) return undefined;
  const dir = config.setDir ?? join(projectDir, '.pyric', 'assets', 'avatars');
  return createAssetResolver({
    dir,
    source: config.source,
    fallback: defaultAvatarFallback,
    onMaterialised,
    onSourceLimit: (limit) => {
      console.error(
        `[pyric] avatar source stopped after ${limit} generations this session; ` +
          'later users get the built-in avatar. Restart to resume.',
      );
    },
  });
}

export async function createSandboxSession(
  options: SandboxSessionOptions,
): Promise<SandboxSession> {
  // Preserve the established fail-fast order: Firestore, then RTDB, then Storage.
  const firestore = await loadProjectRules(options.projectDir, options.firebaseConfig, options.project);
  for (const warning of firestore.warnings) options.logger?.note(`  ⚠ ${warning}`);
  const database = await loadProjectDatabaseRules(options.projectDir, options.firebaseConfig, options.project);
  const storage = await loadProjectStorageRules(options.projectDir, options.firebaseConfig, options.project);
  const defaultPolicy: 'allow' | 'deny' = options.permissive ? 'allow' : 'deny';
  if (storage.pending.length > 0) {
    options.logger?.note(formatUnresolvedStorageTargets(storage.pending, defaultPolicy));
  }

  const liveStorageBuckets = new Map<string, { rules: string; rulesHash: string } | null>(
    storage.targets
      .filter((target) => target.bucket !== null)
      .map((target) => [target.bucket as string, storage.buckets.get(target.bucket as string) ?? null]),
  );
  const livePendingStorage = new Map<string, { rules: string; rulesHash: string; moduleFiles?: string[] } | null>();
  for (const target of storage.pending) livePendingStorage.set(target.target, await loadPendingStorageTarget(target));

  const liveDatabase = new Map<string, { rules: RtdbRulesJson; rulesHash: string } | null>(
    database.targets.map((target) => [target.instance, database.instances.get(target.instance) ?? null]),
  );
  const livePending = new Map<string, { rules: RtdbRulesJson; rulesHash: string } | null>(
    database.pending.map((target) => [target.target, { rules: target.rules, rulesHash: target.rulesHash }]),
  );
  const hasUnresolvedTargets = database.pending.length > 0;
  if (hasUnresolvedTargets) {
    options.logger?.note(formatUnresolvedDatabaseTargets(database.pending, defaultPolicy));
  }
  const live = {
    rules: firestore.rules,
    rulesHash: firestore.rulesHash,
    storageRules: storage.rules,
    storageRulesHash: storage.rulesHash,
  };
  const hasNoDatabaseRules = database.instances.size === 0 && !hasUnresolvedTargets;
  if (hasNoDatabaseRules) {
    if (options.permissive) {
      options.logger?.note('  ⓘ RTDB permissive mode active — client reads/writes are open by default.');
    } else {
      options.logger?.note('  ⚠ no database.rules.json found — client RTDB reads/writes default to DENY (matching production Firebase). Use --permissive for open prototyping.');
    }
  }

  const flowTreatments = await createFlowTreatmentHost(options.projectDir, options.flow, {
    boundHost: options.boundHost,
    allowedHosts: options.allowedHosts,
    appPorts: options.appPorts,
  });
  const events = createEventHub();
  const sessionToken = options.sessionToken ?? randomBytes(24).toString('base64url');
  const avatarsResolver = createAvatarsResolver(options.avatars, options.projectDir, (key) => {
    events.broadcast('avatar-ready', { key });
  });
  const avatarUpgrades = Boolean(avatarsResolver) && options.avatars?.source !== undefined;
  const capturesSession = options.capture ?? true;
  let capture: CaptureStore | undefined;
  if (capturesSession) {
    capture = createCaptureStore(options.projectDir);
  }
  const persistsSession = Boolean(options.persistence || options.hosted);
  let hostedPersistence: HostedPersistence | undefined;
  if (options.hosted === true) {
    hostedPersistence = await createHostedPersistence(options.projectDir, { fresh: options.persistence?.fresh });
    for (const line of formatStorageRepairs(hostedPersistence.repairedObjects)) options.logger?.note(line);
  }

  try {
    let initialState: StateStore | undefined = hostedPersistence?.state;
    if (initialState === undefined && persistsSession) {
      initialState = createStateStore(options.projectDir);
    }
    const state = initialState;
    const hasStateStore = state !== undefined;
    const resetsState = hasStateStore && !options.hosted && Boolean(options.persistence?.fresh);
    if (resetsState) {
      for (const file of [state.path, state.backupPath]) {
        if (existsSync(file)) rmSync(file);
      }
    }

    const loadedSeed = await loadSandboxSeedOption({
      projectDir: options.projectDir,
      seedFile: options.seedFile,
      state,
      hostedPersistence,
      hosted: options.hosted === true,
    });
    const { persisted, seed, seedState, seedUsers, seedLabel, seedApplied } = loadedSeed;

    const databaseInstances = (): DatabaseInstancesRules => {
      const result: DatabaseInstancesRules = {
        defaultInstance: database.defaultInstance,
        rules: Object.fromEntries([...liveDatabase].map(([instance, loaded]) => [instance, loaded?.rules ?? null])),
      };
      if (database.projectId !== undefined) {
        result.projectId = database.projectId;
      }
      if (database.targets.length > 0) {
        result.rulesFiles = Object.fromEntries(
          database.targets.map((target) => [target.instance, relative(options.projectDir, target.path)]),
        );
      }
      if (livePending.size > 0) {
        result.pendingTargets = database.pending.map((target) => ({
          target: target.target,
          rules: livePending.get(target.target)?.rules ?? null,
          instancesByProject: target.instancesByProject,
        }));
      }
      return result;
    };

    const storageBucketRules = (): Record<string, { rules: string; rulesHash: string }> => {
      const record: Record<string, { rules: string; rulesHash: string }> = {};
      for (const [bucket, loaded] of liveStorageBuckets) {
        if (loaded !== null) record[bucket] = { rules: loaded.rules, rulesHash: loaded.rulesHash };
      }
      return record;
    };

    const payload = (): InitPayload => {
      const hasPersistedState = state?.exists() === true;
      const defaultDatabase = liveDatabase.get(database.defaultInstance) ?? null;
      let instanceId: string | undefined;
      if (options.hosted === true) {
        instanceId = options.hostInstanceId?.();
      }
      let authUsers: Record<string, unknown>[] | null = seedUsers;
      if (hasStateStore) {
        const storedAuth = state.readSection('auth') as { users?: Record<string, unknown>[] } | null;
        authUsers = storedAuth?.users ?? null;
      }
      return {
        rules: live.rules,
        rulesHash: live.rulesHash,
        databaseRules: defaultDatabase?.rules ?? null,
        databaseRulesHash: defaultDatabase?.rulesHash ?? null,
        databaseInstances: databaseInstances(),
        storageRules: live.storageRules,
        storageRulesHash: live.storageRulesHash,
        storageBucketRules: storageBucketRules(),
        storagePendingTargets: storage.pending.map((target) => ({
          target: target.target,
          rules: livePendingStorage.get(target.target)?.rules ?? null,
          bucketsByProject: target.bucketsByProject,
        })),
        projectKey: options.projectDir,
        bridgeUrl: options.bridgeUrl?.() ?? null,
        hosted: options.hosted,
        instanceId,
        persistenceUnhealthy: hostedPersistence?.status().state === 'unhealthy',
        seed: hasPersistedState ? null : seed,
        seedState,
        persist: Boolean(state),
        capture: Boolean(capture),
        sessionToken,
        authUsers,
        messaging: true,
        ai: options.ai ?? null,
        avatars: Boolean(avatarsResolver),
        avatarUpgrades,
        permissive: Boolean(options.permissive),
      };
    };

    const restoredCounts = restoredStateCounts(persisted);
    let persistenceSummary: SandboxSessionSummary['persistence'] = null;
    if (hasStateStore) {
      persistenceSummary = {
        path: state.path,
        backupPath: state.backupPath,
        ...restoredCounts,
        restored: persisted !== null,
        seedApplied,
      };
    }
    const summary: SandboxSessionSummary = {
      rules: {
        firestore: { sourcePath: firestore.sourcePath, hash: firestore.rulesHash },
        database: [...database.instances.values()].map((loaded) => ({
          instance: loaded.instance,
          sourcePath: loaded.sourcePath,
          hash: loaded.rulesHash,
        })),
        storage: { sourcePath: storage.sourcePath, hash: storage.rulesHash },
        storageBuckets: [...storage.buckets.values()].map((loaded) => ({
          bucket: loaded.bucket as string,
          sourcePath: loaded.sourcePath,
          hash: loaded.rulesHash,
        })),
      },
      persistence: persistenceSummary,
      capturePath: capture?.path ?? null,
      seedLabel,
      seedStaged: Boolean((seed && !state?.exists()) || seedState || seedUsers),
      studioMounted: Boolean(options.studio),
    };

    const studio = options.studio;
    const mountsStudio = Boolean(studio);
    let studioConfig: { workspace: ReturnType<typeof diskWorkspace>; projects: ReturnType<typeof diskProjectStore> } | undefined;
    let siteUiDir: string | undefined;
    if (mountsStudio && studio) {
      studioConfig = {
        workspace: diskWorkspace(options.projectDir),
        projects: diskProjectStore(join(options.projectDir, '.pyric', 'projects')),
      };
      siteUiDir = studio.siteUiDir;
    }
    const stateOwner: 'host' | 'browser' = options.hosted === true ? 'host' : 'browser';
    const namespace = createPyricNamespace({
      boundHost: options.boundHost,
      allowedHosts: options.allowedHosts,
      appPorts: options.appPorts,
      indexes: createIndexConfigStore(options.projectDir),
      thresholds: createThresholdConfigStore(options.projectDir),
      rateCaptures: createRateCaptureStore(options.projectDir),
      sdkDir: options.sdk.dir,
      initPayload: payload,
      events,
      state,
      stateOwner,
      persistenceStatus: hostedPersistence?.status,
      capture,
      sessionToken,
      requireSessionToken: options.requireSessionToken,
      studio: studioConfig,
      siteUiDir,
      workerVersion: options.sdk.workerVersion,
      avatars: avatarsResolver,
      aiProxyUpstream: options.aiProxyUpstream,
      aiGemini: options.aiGemini,
      activity: options.activity,
      beacon: options.beacon,
      beaconToken: options.beaconToken,
      logger: options.logger,
    });

    const reloaders = createSessionRulesReloaders({
      projectDir: options.projectDir,
      firebaseConfig: options.firebaseConfig,
      project: options.project,
      permissive: Boolean(options.permissive),
      deployHostedRules: options.deployHostedRules,
      events,
      live,
      firestore,
      database,
      storage,
      liveDatabase,
      livePending,
      liveStorageBuckets,
      livePendingStorage,
    });

    let closePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      closePromise ??= Promise.resolve().then(() => {
        events.close();
        hostedPersistence?.close();
      });
      return closePromise;
    };

    return {
      sessionToken,
      hostedPersistence,
      summary,
      payload,
      async handle(req, res, url) {
        return (await flowTreatments.handle(req, res, url)) || namespace(req, res, url);
      },
      ...reloaders,
      close,
    };
  } catch (error) {
    hostedPersistence?.close();
    throw error;
  }
}
