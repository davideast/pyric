import { randomBytes } from 'node:crypto';
import { createRateCaptureStore } from './rate-capture-store.js';
import { createThresholdConfigStore } from './threshold-config-store.js';
import { createFlowTreatmentHost } from './flow-treatment-host.js';
import { createIndexConfigStore } from './index-config-store.js';
import type { FlowConfig } from './flow-config.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { defaultAvatarSvg } from 'pyric/auth/internal';
import type { FirebaseJson } from '../cli/firebase-json.js';
import { createCaptureStore, type CaptureStore } from './capture-store.js';
import type { InitPayload } from './init-payload.js';
import {
  loadProjectDatabaseRules,
  loadProjectRules,
  loadProjectStorageRules,
  prepareRulesSource,
  rulesHashOf,
} from './rules.js';
import { createEventHub, createPyricNamespace } from './namespace.js';
import type { BeaconReport } from '../register/beacon.js';
import { diskProjectStore, diskWorkspace } from './studio/index.js';
import type { ServeLogger } from './server.js';
import { createAssetResolver, type AssetRequest, type AssetResolver } from './assets/resolver.js';
import type { ResolvedAvatarsConfig } from './avatars-config.js';
import {
  createStateStore,
  type StateStore,
} from './state-store.js';
import { restoredStateCounts } from './state-summary.js';
import { parseStateFile } from './state-file.js';
import { createHostedPersistence, type HostedPersistence } from './hosted/persistence.js';

export interface SandboxSessionOptions {
  boundHost?: string;
  allowedHosts?: string[];
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
  deployHostedRules?: (service: 'firestore' | 'database', source: string) => void;
  ai?: InitPayload['ai'];
  aiProxyUpstream?: string;
  /** Resolved `avatars` option (already reduced by `avatars-config.ts` from
   *  whatever the caller — the Vite plugin or `pyric sandbox` — accepted).
   *  Absent behaves like `{ enabled: false }`: no avatar route is mounted. */
  avatars?: ResolvedAvatarsConfig;
  permissive?: boolean;
  logger?: ServeLogger;
  activity?: (incident: ActivityIncident) => void;
  /** Receives one handshake beacon per pyric-launched child, the dev
   *  server's only positive proof that the register module reached it. */
  beacon?: (report: BeaconReport) => void;
  /** The per-launch secret a beacon must present, also placed in the child's
   *  `PYRIC_BEACON_TOKEN`. */
  beaconToken?: string;
}

export interface SandboxSessionSummary {
  rules: {
    firestore: { sourcePath: string | null; hash: string | null };
    database: { sourcePath: string | null; hash: string | null };
    storage: { sourcePath: string | null; hash: string | null };
  };
  persistence: null | {
    path: string;
    backupPath: string;
    restoredDocs: number;
    restoredUsers: number;
    restored: boolean;
  };
  capturePath: string | null;
  seedLabel: string | null;
  seedStaged: boolean;
  studioMounted: boolean;
}

export interface SandboxSession {
  readonly hostedPersistence?: HostedPersistence;
  readonly summary: SandboxSessionSummary;
  payload(): InitPayload;
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean | Promise<boolean>;
  reloadFirestoreRules(): Promise<RulesReloadResult>;
  reloadDatabaseRules(): Promise<RulesReloadResult>;
  close(): Promise<void>;
}

export class SandboxSeedError extends Error {
  constructor(
    readonly kind: 'read' | 'shape',
    readonly path: string,
    readonly detail: string,
  ) {
    super(kind === 'read' ? `failed to read seed ${path}: ${detail}` : `seed must be a JSON object (${detail})`);
    this.name = 'SandboxSeedError';
  }
}

export type RulesReloadResult =
  | { kind: 'not-configured' }
  | { kind: 'reloaded'; rulesHash: string; clients: number }
  | { kind: 'rejected'; error: Error };

/** The generated fallback every avatars configuration falls back to when a
 *  cache entry, pool, or configured source doesn't answer for a key: the
 *  same deterministic SVG the in-page, no-server mode encodes as a data URI
 *  (`pyric/auth/internal`'s `defaultAvatarDataUri`), so served and in-page
 *  modes agree on a face for the same uid. */
function defaultAvatarFallback(
  req: AssetRequest,
  kind: 'fallback' | 'interim',
): { data: Uint8Array; contentType: string } {
  const displayName = typeof req.context.displayName === 'string' ? req.context.displayName : null;
  const email = typeof req.context.email === 'string' ? req.context.email : null;
  // An interim response stands in for an image a source is still producing,
  // so it renders the generating state rather than an image that looks final.
  const svg = defaultAvatarSvg({ uid: req.key, displayName, email, pending: kind === 'interim' });
  return { data: new TextEncoder().encode(svg), contentType: 'image/svg+xml' };
}

/** Build the avatar asset resolver from a resolved `avatars` config, or
 *  `undefined` when avatars are disabled (or unconfigured) — `undefined`
 *  means the `/__pyric/assets/avatar/*` route 404s entirely (namespace.ts).
 *  The union in `ResolvedAvatarsConfig` guarantees `setDir` XOR `source`, so
 *  a read-only set directory never receives cache writes: `createAssetResolver`
 *  only writes when a `source` produced bytes it needs to cache.
 *
 *  `onMaterialised` is the session's push channel, passed in rather than
 *  reached for: the resolver announces a key whose placeholder has just been
 *  superseded, and the session turns that into an SSE event the page acts on. */
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
  // Preserve the established fail-fast order: Firestore, then RTDB, then
  // Storage. Callers historically surfaced the first error in this sequence.
  const firestore = await loadProjectRules(options.projectDir, options.firebaseConfig);
  const database = await loadProjectDatabaseRules(options.projectDir, options.firebaseConfig);
  const storage = await loadProjectStorageRules(options.projectDir, options.firebaseConfig);
  const live = {
    rules: firestore.rules,
    rulesHash: firestore.rulesHash,
    databaseRules: database.rules,
    databaseRulesHash: database.rulesHash,
  };
  const hasNoDatabaseRules = !database.sourcePath;
  if (hasNoDatabaseRules) {
    const isPermissive = Boolean(options.permissive);
    if (isPermissive) {
      options.logger?.note('  ⓘ RTDB permissive mode active — client reads/writes are open by default.');
    } else {
      options.logger?.note('  ⚠ no database.rules.json found — client RTDB reads/writes default to DENY (matching production Firebase). Use --permissive for open prototyping.');
    }
  }
  const flowTreatments = await createFlowTreatmentHost(options.projectDir, options.flow);
  const events = createEventHub();
  const sessionToken = randomBytes(24).toString('base64url');
  // A background generation that lands in the cache is broadcast on the same
  // hub the rules watchers use. The page, not the application, listens: it
  // re-requests that uid's avatar so the finished image replaces the
  // placeholder the browser is already showing.
  const avatarsResolver = createAvatarsResolver(options.avatars, options.projectDir, (key) => {
    events.broadcast('avatar-ready', { key });
  });
  // Only a configured source can produce an image that supersedes a
  // placeholder, so only that case asks the page to open a connection.
  const avatarUpgrades = Boolean(avatarsResolver) && options.avatars?.source !== undefined;
  const capturesSession = options.capture ?? true;
  const capture: CaptureStore | undefined = capturesSession
    ? createCaptureStore(options.projectDir)
    : undefined;
  const persistsSession = Boolean(options.persistence || options.hosted);
  let hostedPersistence: HostedPersistence | undefined;
  const usesHostedPersistence = options.hosted === true;
  if (usesHostedPersistence) hostedPersistence = await createHostedPersistence(options.projectDir, { fresh: options.persistence?.fresh });
  try {
    const state: StateStore | undefined = hostedPersistence?.state ?? (persistsSession ? createStateStore(options.projectDir) : undefined);
    const hasStateStore = state !== undefined;
    const resetsState = hasStateStore && !options.hosted && !!options.persistence?.fresh;
    if (resetsState) {
      for (const file of [state.path, state.backupPath]) {
        const hasFile = existsSync(file);
        if (hasFile) rmSync(file);
      }
    }
    let persisted = state?.load() ?? null;
    let seed: Record<string, Record<string, unknown>> | null = null;
    let seedState: unknown | null = null;
    let seedUsers: Record<string, unknown>[] | null = null;
    let seedLabel: string | null = null;
    const seedFile = options.seedFile;
    const hasSeedFile = !!seedFile;
    if (hasSeedFile) {
      const seedPath = resolve(options.projectDir, seedFile);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;
      } catch (error) {
        const isError = error instanceof Error;
        const message = isError ? error.message : String(error);
        throw new SandboxSeedError('read', seedPath, message);
      }
      const isArray = Array.isArray(parsed);
      const isNotObject = !parsed || typeof parsed !== 'object';
      const isInvalidSeed = isNotObject || isArray;
      if (isInvalidSeed) {
        const kind = isArray ? 'array' : typeof parsed;
        throw new SandboxSeedError('shape', seedPath, `got ${kind}`);
      }
      const record = parsed as Record<string, unknown>;
      const hasStateVersion = 'version' in record;
      const hasStateSections = 'firestore' in record || 'auth' in record || 'storage' in record;
      const isStateFixture = hasStateVersion && hasStateSections;
      if (isStateFixture) {
        const fixture = parseStateFile(record, seedPath);
        const { restoredDocs, restoredUsers } = restoredStateCounts(fixture);
        seedLabel = `${restoredDocs} doc(s) + ${restoredUsers} user(s) from state fixture`;
        const initializesStateStore = hasStateStore && !state.exists();
        if (initializesStateStore) {
          const seedOwner = hostedPersistence;
          const hasHostedPersistence = seedOwner !== undefined;
          if (hasHostedPersistence) seedOwner.seed(fixture);
          else {
            const hasFirestoreState = fixture.firestore != null;
            if (hasFirestoreState) state.writeSection('firestore', fixture.firestore);
            const hasAuthState = fixture.auth != null;
            if (hasAuthState) state.writeSection('auth', fixture.auth);
            const hasStorageState = fixture.storage !== undefined;
            if (hasStorageState) state.writeSection('storage', fixture.storage);
          }
          persisted = state.load();
        } else {
          const hasNoStateStore = !hasStateStore;
          if (hasNoStateStore) {
            seedState = fixture.firestore ?? null;
            seedUsers = fixture.auth?.users.map((user) => ({ ...user })) ?? null;
          }
        }
      } else {
        seed = record as Record<string, Record<string, unknown>>;
        seedLabel = `${Object.keys(seed).length} document(s)`;
      }
    }

    const payload = (): InitPayload => {
      const hasPersistedState = state?.exists() === true;
      return {
        rules: live.rules,
        rulesHash: live.rulesHash,
        databaseRules: live.databaseRules,
        databaseRulesHash: live.databaseRulesHash,
        databaseUrl: database.databaseUrl,
        storageRules: storage.rules,
        storageRulesHash: storage.rulesHash,
        projectKey: options.projectDir,
        bridgeUrl: options.bridgeUrl?.() ?? null,
        hosted: options.hosted,
        persistenceUnhealthy: hostedPersistence?.status().state === 'unhealthy',
        seed: hasPersistedState ? null : seed,
        seedState,
        persist: Boolean(state),
        capture: Boolean(capture),
        sessionToken,
        authUsers: hasStateStore
          ? ((state.readSection('auth') as { users?: Record<string, unknown>[] } | null)?.users ?? null)
          : seedUsers,
        messaging: true,
        ai: options.ai ?? null,
        avatars: Boolean(avatarsResolver),
        avatarUpgrades,
        permissive: Boolean(options.permissive),
      };
    };

    const restoredCounts = restoredStateCounts(persisted);
    const summary: SandboxSessionSummary = {
      rules: {
        firestore: { sourcePath: firestore.sourcePath, hash: firestore.rulesHash },
        database: { sourcePath: database.sourcePath, hash: database.rulesHash },
        storage: { sourcePath: storage.sourcePath, hash: storage.rulesHash },
      },
      persistence: hasStateStore
        ? {
            path: state.path,
            backupPath: state.backupPath,
            ...restoredCounts,
            restored: persisted !== null,
          }
        : null,
      capturePath: capture?.path ?? null,
      seedLabel,
      seedStaged: Boolean((seed && !state?.exists()) || seedState || seedUsers),
      studioMounted: Boolean(options.studio),
    };

    const studio = options.studio;
    const mountsStudio = !!studio;
    const hostOwnsState = options.hosted === true;
    const stateOwner = hostOwnsState ? 'host' : 'browser';
    const namespace = createPyricNamespace({
      boundHost: options.boundHost,
      allowedHosts: options.allowedHosts,
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
      studio: mountsStudio
        ? {
            workspace: diskWorkspace(options.projectDir),
            projects: diskProjectStore(join(options.projectDir, '.pyric', 'projects')),
          }
        : undefined,
      siteUiDir: mountsStudio ? studio.siteUiDir : undefined,
      workerVersion: options.sdk.workerVersion,
      avatars: avatarsResolver,
      aiProxyUpstream: options.aiProxyUpstream,
      activity: options.activity,
      beacon: options.beacon,
      beaconToken: options.beaconToken,
      logger: options.logger,
    });

    const reloadFirestoreRules = async (): Promise<RulesReloadResult> => {
      const sourcePath = firestore.sourcePath;
      const hasNoSource = !sourcePath;
      if (hasNoSource) return { kind: 'not-configured' };
      try {
        const raw = await readFile(sourcePath, 'utf8');
        const rules = prepareRulesSource(raw, sourcePath);
        const rulesHash = rulesHashOf(rules);
        options.deployHostedRules?.('firestore', rules);
        live.rules = rules;
        live.rulesHash = rulesHash;
        events.broadcast('rules-changed', { rules, rulesHash });
        return { kind: 'reloaded', rulesHash, clients: events.clientCount() };
      } catch (error) {
        const isError = error instanceof Error;
        const failure = isError ? error : new Error(String(error));
        return { kind: 'rejected', error: failure };
      }
    };
    const reloadDatabaseRules = async (): Promise<RulesReloadResult> => {
      try {
        const updated = await loadProjectDatabaseRules(options.projectDir, options.firebaseConfig);
        const isMissingUpdatedRules = updated.rules === null || updated.rulesHash === null;
        if (isMissingUpdatedRules) {
          return { kind: 'not-configured' };
        }
        options.deployHostedRules?.('database', JSON.stringify(updated.rules));
        database.sourcePath = updated.sourcePath;
        live.databaseRules = updated.rules;
        live.databaseRulesHash = updated.rulesHash;
        events.broadcast('rtdb-rules-update', { rules: updated.rules, rulesHash: updated.rulesHash });
        return { kind: 'reloaded', rulesHash: updated.rulesHash as string, clients: events.clientCount() };
      } catch (error) {
        const isErrorInstance = error instanceof Error;
        let errorResult: Error = new Error(String(error));
        if (isErrorInstance) {
          errorResult = error as Error;
        }
        return { kind: 'rejected', error: errorResult };
      }
    };

    let closePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      closePromise ??= Promise.resolve().then(() => {
        events.close();
        hostedPersistence?.close();
      });
      return closePromise;
    };

    return {
      hostedPersistence,
      summary,
      payload,
      async handle(req, res, url) {
        return await flowTreatments.handle(req, res, url) || namespace(req, res, url);
      },
      reloadFirestoreRules,
      reloadDatabaseRules,
      close,
    };
  } catch (error) {
    hostedPersistence?.close();
    throw error;
  }
}
