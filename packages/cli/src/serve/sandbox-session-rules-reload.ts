import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FirebaseJson } from '../cli/firebase-json.js';
import type { FirebaseProjectResolution } from '../cli/firebase-project.js';
import type { RtdbRulesJson, RulesDestination } from './init-payload.js';
import {
  firestoreRulesPath,
  loadDatabaseInstanceRules,
  loadPendingDatabaseTargetRules,
  loadPendingStorageTarget,
  loadStorageRulesTarget,
  prepareProjectRules,
  RulesPrepareError,
  rulesHashOf,
  type DatabaseRulesTarget,
  type LoadedPendingDatabaseTarget,
  type PendingStorageRulesTarget,
  type StorageRulesTarget,
} from './rules.js';
import {
  runProjectFixturesOnRulesReload,
  type RulesFixtureCheckSummary,
} from './rules-fixture-check.js';

export type RulesReloadResult =
  | { kind: 'not-configured' }
  | { kind: 'reloaded'; rulesHash: string; clients: number; fixtureCheck?: RulesFixtureCheckSummary }
  | { kind: 'rejected'; error: Error }
  /** The rules file was deleted. The service is back to the state it starts
   *  in without a rules file: no rules, and `policy` for every read and write. */
  | { kind: 'removed'; policy: 'allow' | 'deny'; clients: number };

/** One bucket's, or one pending deploy target's, reload after its rules file changed. */
export interface StorageRulesReloadResult {
  /** The bucket by name, or null for the app's default bucket or a pending target. */
  bucket: string | null;
  /** The deploy target no project resolved at startup, when the reload is a pending target's. */
  target?: string;
  file: string;
  result: RulesReloadResult;
}

/** One database instance's reload after its rules file changed. */
export interface DatabaseRulesReloadResult {
  /** The instance name, or `deploy target "<name>"` for an unresolved target. */
  instance: string;
  file: string;
  result: RulesReloadResult;
}

interface SessionRulesEventHub {
  broadcast(event: string, data: unknown): void;
  clientCount(): number;
}

export interface SessionRulesReloadDeps {
  projectDir: string;
  firebaseConfig: FirebaseJson | null;
  project: FirebaseProjectResolution | undefined;
  permissive: boolean;
  deployHostedRules?: (
    service: 'firestore' | 'database' | 'storage',
    source: string | null,
    destination?: RulesDestination,
  ) => Promise<void>;
  events: SessionRulesEventHub;
  live: {
    rules: string | null;
    rulesHash: string | null;
    storageRules: string | null;
    storageRulesHash: string | null;
  };
  firestore: {
    sourcePath: string | null;
    moduleFiles: readonly string[];
  };
  database: {
    defaultInstance: string;
    targets: readonly DatabaseRulesTarget[];
    pending: readonly LoadedPendingDatabaseTarget[];
  };
  storage: {
    moduleFiles: readonly string[];
    buckets: ReadonlyMap<string, { moduleFiles: readonly string[] }>;
    targets: readonly StorageRulesTarget[];
    pending: readonly PendingStorageRulesTarget[];
  };
  liveDatabase: Map<string, { rules: RtdbRulesJson; rulesHash: string } | null>;
  livePending: Map<string, { rules: RtdbRulesJson; rulesHash: string } | null>;
  liveStorageBuckets: Map<string, { rules: string; rulesHash: string } | null>;
  livePendingStorage: Map<string, { rules: string; rulesHash: string; moduleFiles?: string[] } | null>;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function createSessionRulesReloaders(deps: SessionRulesReloadDeps) {
  const {
    projectDir,
    firebaseConfig,
    project,
    permissive,
    deployHostedRules,
    events,
    live,
    firestore,
    database,
    storage,
    liveDatabase,
    livePending,
    liveStorageBuckets,
    livePendingStorage,
  } = deps;

  let attemptedModuleFiles: readonly string[] = [];
  const firestoreSourcePath = firestoreRulesPath(projectDir, firebaseConfig, project);

  const reloadFirestoreRules = async (): Promise<RulesReloadResult> => {
    const sourcePath = firestoreSourcePath;
    if (sourcePath === null) return { kind: 'not-configured' };
    const isSourceMissing = !existsSync(sourcePath);
    const hasLoadedRules = live.rules !== null;
    if (isSourceMissing && !hasLoadedRules) return { kind: 'not-configured' };
    if (isSourceMissing) {
      return { kind: 'rejected', error: new Error(`pyric sandbox: ${sourcePath} does not exist.`) };
    }
    try {
      const raw = await readFile(sourcePath, 'utf8');
      const { rules, moduleFiles } = prepareProjectRules(raw, sourcePath);
      firestore.sourcePath = sourcePath;
      firestore.moduleFiles = moduleFiles;
      attemptedModuleFiles = [];
      const rulesHash = rulesHashOf(rules);
      await deployHostedRules?.('firestore', rules);
      live.rules = rules;
      live.rulesHash = rulesHash;
      events.broadcast('rules-changed', { rules, rulesHash });
      const fixtureCheck = await runProjectFixturesOnRulesReload({
        projectDir,
        service: 'firestore',
        firestoreRules: rules,
      });
      return { kind: 'reloaded', rulesHash, clients: events.clientCount(), fixtureCheck };
    } catch (error) {
      attemptedModuleFiles = error instanceof RulesPrepareError ? error.moduleFiles : [];
      return { kind: 'rejected', error: toError(error) };
    }
  };

  const firestoreRulesFiles = (): readonly string[] => {
    const sourceFiles = firestoreSourcePath === null ? [] : [firestoreSourcePath];
    return [...new Set([...sourceFiles, ...firestore.moduleFiles, ...attemptedModuleFiles])];
  };

  const databaseRulesFiles = (): readonly string[] => [
    ...new Set([...database.targets, ...database.pending].map((target) => target.path)),
  ];

  const deployHostedDatabaseRules = async (instance: string, rules: RtdbRulesJson | null): Promise<void> => {
    let serialized: string | null = null;
    if (rules !== null) serialized = JSON.stringify(rules);
    await deployHostedRules?.('database', serialized, instance);
  };

  const policy: 'allow' | 'deny' = permissive ? 'allow' : 'deny';

  const removeDatabaseInstanceRules = async (instance: string): Promise<RulesReloadResult> => {
    if ((liveDatabase.get(instance) ?? null) === null) return { kind: 'not-configured' };
    await deployHostedDatabaseRules(instance, null);
    liveDatabase.set(instance, null);
    events.broadcast('rtdb-rules-update', { instance, rules: null, rulesHash: null, policy });
    return { kind: 'removed', policy, clients: events.clientCount() };
  };

  const reloadDatabaseInstanceRules = async (target: DatabaseRulesTarget): Promise<RulesReloadResult> => {
    if (!existsSync(target.path)) return removeDatabaseInstanceRules(target.instance);
    try {
      const updated = await loadDatabaseInstanceRules(target);
      if (updated === null) return removeDatabaseInstanceRules(target.instance);
      await deployHostedDatabaseRules(target.instance, updated.rules);
      liveDatabase.set(target.instance, { rules: updated.rules, rulesHash: updated.rulesHash });
      events.broadcast('rtdb-rules-update', {
        instance: target.instance,
        rules: updated.rules,
        rulesHash: updated.rulesHash,
      });
      const rtdbInstance = target.instance === database.defaultInstance ? undefined : target.instance;
      const fixtureCheck = await runProjectFixturesOnRulesReload({
        projectDir,
        service: 'rtdb',
        rtdbRules: updated.rules,
        rtdbInstance,
      });
      return { kind: 'reloaded', rulesHash: updated.rulesHash, clients: events.clientCount(), fixtureCheck };
    } catch (error) {
      return { kind: 'rejected', error: toError(error) };
    }
  };

  const reloadPendingTargetRules = async (target: LoadedPendingDatabaseTarget): Promise<RulesReloadResult> => {
    const destination = { target: target.target };
    if (!existsSync(target.path)) {
      if ((livePending.get(target.target) ?? null) === null) return { kind: 'not-configured' };
      await deployHostedRules?.('database', null, destination);
      livePending.set(target.target, null);
      events.broadcast('rtdb-rules-update', { target: target.target, rules: null, rulesHash: null, policy });
      return { kind: 'removed', policy, clients: events.clientCount() };
    }
    try {
      const updated = await loadPendingDatabaseTargetRules(target);
      await deployHostedRules?.('database', JSON.stringify(updated.rules), destination);
      livePending.set(target.target, updated);
      events.broadcast('rtdb-rules-update', { target: target.target, rules: updated.rules, rulesHash: updated.rulesHash });
      return { kind: 'reloaded', rulesHash: updated.rulesHash, clients: events.clientCount() };
    } catch (error) {
      return { kind: 'rejected', error: toError(error) };
    }
  };

  const reloadDatabaseRules = async (file: string): Promise<DatabaseRulesReloadResult[]> => {
    const results: DatabaseRulesReloadResult[] = [];
    for (const target of database.targets.filter((candidate) => candidate.path === file)) {
      results.push({ instance: target.instance, file, result: await reloadDatabaseInstanceRules(target) });
    }
    for (const target of database.pending.filter((pending) => pending.path === file)) {
      results.push({ instance: `deploy target "${target.target}"`, file, result: await reloadPendingTargetRules(target) });
    }
    return results;
  };

  const storageModuleFilesByTarget = new Map<StorageRulesTarget | PendingStorageRulesTarget, readonly string[]>();
  const storageAttemptedModuleFilesByTarget = new Map<StorageRulesTarget | PendingStorageRulesTarget, readonly string[]>();
  for (const target of storage.targets) {
    let moduleFiles: readonly string[];
    if (target.bucket === null) {
      moduleFiles = storage.moduleFiles;
    } else {
      moduleFiles = storage.buckets.get(target.bucket)?.moduleFiles ?? [];
    }
    storageModuleFilesByTarget.set(target, moduleFiles);
  }
  for (const target of storage.pending) {
    storageModuleFilesByTarget.set(target, livePendingStorage.get(target.target)?.moduleFiles ?? []);
  }

  const storageSourceFiles = (): readonly string[] => [
    ...new Set([...storage.targets.map((target) => target.path), ...storage.pending.map((target) => target.path)]),
  ];

  const storageRulesFiles = (): readonly string[] => {
    const files: string[] = [];
    for (const target of [...storage.targets, ...storage.pending]) {
      files.push(target.path);
      files.push(...(storageModuleFilesByTarget.get(target) ?? []));
      files.push(...(storageAttemptedModuleFilesByTarget.get(target) ?? []));
    }
    return [...new Set(files)];
  };

  const loadedStorageRules = (bucket: string | null): string | null => {
    if (bucket === null) return live.storageRules;
    return liveStorageBuckets.get(bucket)?.rules ?? null;
  };

  const setLiveStorageRules = (bucket: string | null, loaded: { rules: string; rulesHash: string } | null): void => {
    if (bucket !== null) {
      liveStorageBuckets.set(bucket, loaded);
      return;
    }
    live.storageRules = loaded?.rules ?? null;
    live.storageRulesHash = loaded?.rulesHash ?? null;
  };

  const reloadStorageBucketRules = async (target: StorageRulesTarget): Promise<RulesReloadResult> => {
    const destination = target.bucket === null ? undefined : { bucket: target.bucket };
    if (!existsSync(target.path)) {
      storageModuleFilesByTarget.set(target, []);
      storageAttemptedModuleFilesByTarget.set(target, []);
      if (loadedStorageRules(target.bucket) === null) return { kind: 'not-configured' };
      await deployHostedRules?.('storage', null, destination);
      setLiveStorageRules(target.bucket, null);
      const removedEvent: Record<string, unknown> = { rules: null, rulesHash: null, policy };
      if (target.bucket !== null) removedEvent.bucket = target.bucket;
      events.broadcast('storage-rules-update', removedEvent);
      return { kind: 'removed', policy, clients: events.clientCount() };
    }
    try {
      const loaded = await loadStorageRulesTarget({ ...target, configured: true });
      if (loaded === null) return { kind: 'not-configured' };
      storageModuleFilesByTarget.set(target, loaded.moduleFiles);
      storageAttemptedModuleFilesByTarget.set(target, []);
      await deployHostedRules?.('storage', loaded.rules, destination);
      setLiveStorageRules(target.bucket, loaded);
      const updatedEvent: Record<string, unknown> = { rules: loaded.rules, rulesHash: loaded.rulesHash };
      if (target.bucket !== null) updatedEvent.bucket = target.bucket;
      events.broadcast('storage-rules-update', updatedEvent);
      return { kind: 'reloaded', rulesHash: loaded.rulesHash, clients: events.clientCount() };
    } catch (error) {
      let attempted: readonly string[] = [];
      if (error instanceof RulesPrepareError) attempted = error.moduleFiles;
      storageAttemptedModuleFilesByTarget.set(target, attempted);
      return { kind: 'rejected', error: toError(error) };
    }
  };

  const reloadPendingStorageTarget = async (target: PendingStorageRulesTarget): Promise<RulesReloadResult> => {
    const destination = { target: target.target };
    try {
      const loaded = await loadPendingStorageTarget(target);
      const hadRules = livePendingStorage.get(target.target) != null;
      storageModuleFilesByTarget.set(target, loaded?.moduleFiles ?? []);
      storageAttemptedModuleFilesByTarget.set(target, []);
      if (loaded === null && !hadRules) return { kind: 'not-configured' };
      await deployHostedRules?.('storage', loaded?.rules ?? null, destination);
      livePendingStorage.set(target.target, loaded);
      events.broadcast('storage-rules-update', {
        rules: loaded?.rules ?? null,
        rulesHash: loaded?.rulesHash ?? null,
        policy,
        target: target.target,
      });
      if (loaded === null) return { kind: 'removed', policy, clients: events.clientCount() };
      return { kind: 'reloaded', rulesHash: loaded.rulesHash, clients: events.clientCount() };
    } catch (error) {
      let attempted: readonly string[] = [];
      if (error instanceof RulesPrepareError) attempted = error.moduleFiles;
      storageAttemptedModuleFilesByTarget.set(target, attempted);
      return { kind: 'rejected', error: toError(error) };
    }
  };

  const matchesStorageTargetFile = (
    candidate: StorageRulesTarget | PendingStorageRulesTarget,
    resolvedFile: string,
  ): boolean => {
    if (resolve(candidate.path) === resolvedFile) return true;
    if ((storageModuleFilesByTarget.get(candidate) ?? []).some((m) => resolve(m) === resolvedFile)) return true;
    if ((storageAttemptedModuleFilesByTarget.get(candidate) ?? []).some((m) => resolve(m) === resolvedFile)) return true;
    return false;
  };

  const reloadStorageRules = async (file: string): Promise<StorageRulesReloadResult[]> => {
    const resolvedFile = resolve(file);
    const results: StorageRulesReloadResult[] = [];
    for (const target of storage.targets.filter((candidate) => matchesStorageTargetFile(candidate, resolvedFile))) {
      results.push({ bucket: target.bucket, file: target.path, result: await reloadStorageBucketRules(target) });
    }
    for (const target of storage.pending.filter((candidate) => matchesStorageTargetFile(candidate, resolvedFile))) {
      results.push({ bucket: null, target: target.target, file: target.path, result: await reloadPendingStorageTarget(target) });
    }
    return results;
  };

  return {
    reloadFirestoreRules,
    reloadDatabaseRules,
    reloadStorageRules,
    firestoreRulesFiles,
    databaseRulesFiles,
    storageRulesFiles,
    storageSourceFiles,
  };
}
