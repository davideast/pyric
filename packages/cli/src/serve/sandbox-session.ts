import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActivityIncident } from 'pyric/firestore/internal';
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
import {
  createStateStore,
  firestoreDocCount,
  STATE_FILE_VERSION,
  type PyricStateFile,
  type StateStore,
} from './state-store.js';

export interface SandboxSessionOptions {
  projectDir: string;
  firebaseConfig: FirebaseJson | null;
  sdk: { dir: string; workerVersion?: string };
  seedFile?: string;
  capture?: boolean;
  persistence?: { fresh?: boolean };
  studio?: false | { siteUiDir?: string };
  bridgeUrl?: () => string | null;
  ai?: InitPayload['ai'];
  aiProxyUpstream?: string;
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
  if (!database.sourcePath) {
    if (options.permissive) {
      options.logger?.note('  ⓘ RTDB permissive mode active — client reads/writes are open by default.');
    } else {
      options.logger?.note('  ⚠ no database.rules.json found — client RTDB reads/writes default to DENY (matching production Firebase). Use --permissive for open prototyping.');
    }
  }
  const events = createEventHub();
  const capture: CaptureStore | undefined = (options.capture ?? true)
    ? createCaptureStore(options.projectDir)
    : undefined;
  const state: StateStore | undefined = options.persistence
    ? createStateStore(options.projectDir)
    : undefined;
  if (state && options.persistence?.fresh) {
    for (const file of [state.path, state.backupPath]) {
      if (existsSync(file)) rmSync(file);
    }
  }
  let persisted = state?.load() ?? null;
  let seed: Record<string, Record<string, unknown>> | null = null;
  let seedState: unknown | null = null;
  let seedUsers: Record<string, unknown>[] | null = null;
  let seedLabel: string | null = null;
  if (options.seedFile) {
    const seedPath = resolve(options.projectDir, options.seedFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;
    } catch (error) {
      throw new SandboxSeedError('read', seedPath, error instanceof Error ? error.message : String(error));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SandboxSeedError('shape', seedPath, `got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }
    const record = parsed as Record<string, unknown>;
    if (record.version === STATE_FILE_VERSION && ('firestore' in record || 'auth' in record)) {
      const fixture = record as unknown as PyricStateFile;
      const restoredDocs = firestoreDocCount(fixture.firestore);
      const restoredUsers = fixture.auth?.users?.length ?? 0;
      seedLabel = `${restoredDocs} doc(s) + ${restoredUsers} user(s) from state fixture`;
      if (state && !state.exists()) {
        if (fixture.firestore != null) state.writeSection('firestore', fixture.firestore);
        if (fixture.auth != null) state.writeSection('auth', fixture.auth);
        persisted = state.load();
      } else if (!state) {
        seedState = fixture.firestore ?? null;
        seedUsers = (fixture.auth?.users as Record<string, unknown>[] | undefined) ?? null;
      }
    } else {
      seed = record as Record<string, Record<string, unknown>>;
      seedLabel = `${Object.keys(seed).length} document(s)`;
    }
  }

  const payload = (): InitPayload => ({
    rules: live.rules,
    rulesHash: live.rulesHash,
    databaseRules: live.databaseRules,
    databaseRulesHash: live.databaseRulesHash,
    databaseUrl: database.databaseUrl,
    storageRules: storage.rules,
    storageRulesHash: storage.rulesHash,
    projectKey: options.projectDir,
    bridgeUrl: options.bridgeUrl?.() ?? null,
    seed: state?.exists() ? null : seed,
    seedState,
    persist: Boolean(state),
    capture: Boolean(capture),
    authUsers: state
      ? ((state.readSection('auth') as { users?: Record<string, unknown>[] } | null)?.users ?? null)
      : seedUsers,
    messaging: true,
    ai: options.ai ?? null,
    permissive: Boolean(options.permissive),
  });

  const summary: SandboxSessionSummary = {
    rules: {
      firestore: { sourcePath: firestore.sourcePath, hash: firestore.rulesHash },
      database: { sourcePath: database.sourcePath, hash: database.rulesHash },
      storage: { sourcePath: storage.sourcePath, hash: storage.rulesHash },
    },
    persistence: state
      ? {
          path: state.path,
          backupPath: state.backupPath,
          restoredDocs: firestoreDocCount(persisted?.firestore),
          restoredUsers: persisted?.auth?.users?.length ?? 0,
          restored: persisted !== null,
        }
      : null,
    capturePath: capture?.path ?? null,
    seedLabel,
    seedStaged: Boolean((seed && !state?.exists()) || seedState || seedUsers),
    studioMounted: Boolean(options.studio),
  };

  const namespace = createPyricNamespace({
    sdkDir: options.sdk.dir,
    initPayload: payload,
    events,
    state,
    capture,
    studio: options.studio
      ? {
          workspace: diskWorkspace(options.projectDir),
          projects: diskProjectStore(join(options.projectDir, '.pyric', 'projects')),
        }
      : undefined,
    siteUiDir: options.studio ? options.studio.siteUiDir : undefined,
    workerVersion: options.sdk.workerVersion,
    aiProxyUpstream: options.aiProxyUpstream,
    activity: options.activity,
    beacon: options.beacon,
    beaconToken: options.beaconToken,
    logger: options.logger,
  });

  const reloadFirestoreRules = async (): Promise<RulesReloadResult> => {
    if (!firestore.sourcePath) return { kind: 'not-configured' };
    try {
      const raw = await readFile(firestore.sourcePath, 'utf8');
      const rules = prepareRulesSource(raw, firestore.sourcePath);
      const rulesHash = rulesHashOf(rules);
      live.rules = rules;
      live.rulesHash = rulesHash;
      events.broadcast('rules-changed', { rules, rulesHash });
      return { kind: 'reloaded', rulesHash, clients: events.clientCount() };
    } catch (error) {
      return { kind: 'rejected', error: error instanceof Error ? error : new Error(String(error)) };
    }
  };
  const reloadDatabaseRules = async (): Promise<RulesReloadResult> => {
    try {
      const updated = await loadProjectDatabaseRules(options.projectDir, options.firebaseConfig);
      const isMissingUpdatedRules = updated.rules === null || updated.rulesHash === null;
      if (isMissingUpdatedRules) {
        return { kind: 'not-configured' };
      }
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
    closePromise ??= Promise.resolve().then(() => events.close());
    return closePromise;
  };

  return {
    summary,
    payload,
    handle: namespace,
    reloadFirestoreRules,
    reloadDatabaseRules,
    close,
  };
}
