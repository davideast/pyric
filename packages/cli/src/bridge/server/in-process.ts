/**
 * In-process stdio MCP server: serves the ten method-record service tools,
 * routing per call via `TargetRouter` to a live Node host or a local sandbox.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import {
  initializeSandbox,
  serializeToBuckets,
  bundleRecords,
  type LocalSandbox,
} from 'pyric/sandbox';
import { getAuth } from 'pyric/auth';
import { getAdminDatabase } from 'pyric/database';
import {
  deployStorageBucketRules,
  getAdminStorageSandbox,
  getStorageRulesResolution,
  nameStorageBucket,
  storageBucketsWithRules,
} from 'pyric/storage/internal';
import { rulesSourceRejection } from 'pyric/rules/internal';
import type { FirebaseStorage } from 'pyric/storage';
import {
  createInProcessPersistence,
  decodeInProcessSnapshot,
  type ProjectStateOwner,
} from './in-process-persistence.js';
import { type RejectedToolCall } from './mcp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRenderedSurface } from './surface-server.js';
import { renderSurface } from '../surface/index.js';
import { createSurfaceContext } from '../surface/context.js';
import {
  AGENT_IDENTITY_SERVICE_KEY,
  AI_LOGIC_SCRIPTS_SERVICE_KEY,
  APP_SESSION_SERVICE_KEY,
  CLOCK_STATE_SERVICE_KEY,
  captureAgentIdentity,
  captureAiLogicScripts,
  captureAppSession,
  captureClockState,
  restoreAgentIdentity,
  restoreAiLogicScripts,
  restoreAppSession,
  restoreClockState,
  syncHydratedAgentIdentity,
} from '../surface/methods/in-process-session-state.js';
import { rememberUnloadedStorageRules } from '../surface/storage-rules.js';
import {
  firestoreRulesInForce,
  loadFirestoreRules,
} from '../surface/firestore-rules-load.js';
import { loadInProcessFirestoreProjectRules } from '../../serve/firestore-project-rules.js';
import { createLocalBridge, type LocalBridgeOptions } from './local-bridge.js';
import {
  createEvalLogWriter,
  readEvalRunIdentity,
  EVAL_LOG_ENV_KEY,
  type AuditWriter,
} from './audit.js';
import type { BridgeToolEvent } from './bridge.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { claimProjectState } from '../../serve/hosted/project-ownership.js';
import {
  firestoreDatabases,
  MODULAR_SOURCE,
  prepareStorageRulesSource,
  resolveProjectModules,
  storageRulesTargets,
  type StorageRulesTarget,
} from '../../serve/rules.js';
import type { FirebaseJson } from '../../cli/firebase-json.js';
import { resolveFirebaseProject } from '../../cli/firebase-project.js';
import { defaultFirestoreDatabase } from 'pyric/sandbox/internal';
import { TargetRouter } from './target-router.js';
import { formatMcpInstructions, resolveProjectIdentity } from './project-identity.js';
import type { Discovered, discoverServe } from '../../serve/discovery.js';
import type { callHostedMethod } from '../../cli/hosted-method.js';

/** The stdio transport is a late import: the SDK is heavy and only needed here. */
async function openStdioTransport(): Promise<Transport> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  return new StdioServerTransport();
}

/** In-process sandbox snapshot path relative to the project directory. */
export const IN_PROCESS_STATE_RELATIVE = join('.pyric', 'state', 'in-process.json');

export interface InProcessMcpServerOptions extends LocalBridgeOptions {
  surface?: string;
  projectDir?: string;
  allowProduction?: boolean;
  onCallRejected?: (event: BridgeToolEvent) => void;
  inProcessOnly?: boolean;
  targetRouter?: TargetRouter;
  cacheTtlMs?: number;
  discover?: typeof discoverServe;
  callHosted?: typeof callHostedMethod;
  initialHost?: Discovered;
  initialHostMode?: 'sandbox' | 'live';
  onBeforeLocalFallback?: () => Promise<string | undefined>;
}

/** Build the pure in-process MCP server around an in-process sandbox. */
export function buildInProcessMcpServer(sandbox: LocalSandbox, opts?: InProcessMcpServerOptions) {
  const bridge = createLocalBridge(sandbox, opts);
  const onCallRejected = opts?.onCallRejected;
  const rejectionEvent = (rejection: RejectedToolCall): void => {
    onCallRejected?.({
      timestamp: new Date().toISOString(),
      mode: 'sandbox',
      project: bridge.project,
      tool: rejection.tool,
      args: rejection.args,
      result: { ok: false, summary: rejection.message },
      durationMs: rejection.durationMs,
      schemaRejected: rejection.schemaRejected,
      isError: true,
    });
  };

  const rendered = renderSurface(opts?.surface, { allowProduction: opts?.allowProduction });
  const projectDir = opts?.projectDir ?? process.cwd();
  const projectIdentity = resolveProjectIdentity(projectDir);
  const targetRouter =
    opts?.targetRouter ??
    new TargetRouter({
      projectDir,
      inProcessOnly: opts?.inProcessOnly,
      allowProduction: opts?.allowProduction,
      cacheTtlMs: opts?.cacheTtlMs,
      discover: opts?.discover,
      callHosted: opts?.callHosted,
      initialHost: opts?.initialHost,
      initialHostMode: opts?.initialHostMode,
      onBeforeLocalFallback: opts?.onBeforeLocalFallback,
    });
  const instructions = formatMcpInstructions(
    projectIdentity,
    targetRouter.getCurrentTarget(),
    opts?.initialHost?.url,
  );
  const server = new McpServer({ name: 'pyric', version: bridge.version }, { instructions });
  const surfaceContext = createSurfaceContext(sandbox, projectDir, targetRouter);
  syncHydratedAgentIdentity(surfaceContext);
  const defaultBucketName = inProcessDefaultBucketName(projectDir);
  surfaceContext.storageBucketName = () => defaultBucketName;
  let onCallRejectedHandler: ((rejection: RejectedToolCall) => void) | undefined;
  if (onCallRejected !== undefined) {
    onCallRejectedHandler = rejectionEvent;
  }
  return registerRenderedSurface(server, bridge, rendered, surfaceContext, {
    onCallRejected: onCallRejectedHandler,
    onAfterCall: opts?.onAfterDispatch,
    projectIdentity,
  });
}

/** The project rules file a load read, and why it was refused, if it was. */
export interface ProjectRulesLoad {
  path: string;
  refused: string | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readProjectFirebaseJson(cwd: string): FirebaseJson | null {
  const path = join(cwd, 'firebase.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FirebaseJson;
  } catch (error) {
    throw new Error(`pyric: failed to parse firebase.json: ${errorMessage(error)}`);
  }
}

/** Load the rules `<cwd>/firebase.json` deploys to `(default)`, else `firestore.rules`. */
export function loadProjectRules(
  sandbox: LocalSandbox,
  cwd: string,
  onWarning: (message: string) => void = () => {},
): ProjectRulesLoad | null {
  const config = readProjectFirebaseJson(cwd);
  const persistedFs = readPersistedRulesState(cwd)?.firestore;
  return loadInProcessFirestoreProjectRules(
    sandbox,
    cwd,
    config,
    persistedFs,
    join(cwd, IN_PROCESS_STATE_RELATIVE),
    onWarning,
  );
}

/** Open auth, database, and storage so `loadSnapshot` restores every bucket. */
export function openPersistedServices(sandbox: LocalSandbox, cwd: string): FirebaseStorage {
  getAuth(sandbox);
  getAdminDatabase(sandbox);
  const persistedStorage = readPersistedRulesState(cwd)?.storage;
  const projectId = resolveFirebaseProject({ projectDir: cwd }).projectId;
  const targetOpts: { projectId?: string } = {};
  if (projectId !== undefined) {
    targetOpts.projectId = projectId;
  }
  const { targets } = storageRulesTargets(cwd, readProjectFirebaseJson(cwd), targetOpts);
  const defaultTarget = targets.find((target) => isDefaultBucketTarget(target, projectId));
  for (const target of targets) {
    if (target.bucket === null) continue;
    const prepared = prepareStorageTarget(sandbox, target);
    const savedBucket = persistedStorage?.buckets?.[target.bucket];
    let effective = prepared;
    if (savedBucket !== undefined && savedBucket.diskAtSave === prepared) {
      effective = savedBucket.active;
    }
    if (effective !== null) deployStorageBucketRules(sandbox, target.bucket, effective);
  }
  for (const [bucket, savedBucket] of Object.entries(persistedStorage?.buckets ?? {})) {
    const configuredInTargets = targets.some((target) => target.bucket === bucket);
    if (!configuredInTargets && savedBucket.diskAtSave === null) {
      deployStorageBucketRules(sandbox, bucket, savedBucket.active);
    }
  }
  let diskDefault: string | null = null;
  if (defaultTarget !== undefined) {
    diskDefault = prepareStorageTarget(sandbox, defaultTarget);
  }
  const savedDefault = persistedStorage?.default;
  let defaultRules = diskDefault;
  if (savedDefault !== undefined && savedDefault.diskAtSave === diskDefault) {
    defaultRules = savedDefault.active;
  }
  if (defaultRules === null) return getAdminStorageSandbox(sandbox);
  return getAdminStorageSandbox(sandbox, { rules: defaultRules });
}

/** Resolve the project's default Storage bucket name without a connected page. */
export function inProcessDefaultBucketName(cwd: string): string | undefined {
  const projectId = resolveFirebaseProject({ projectDir: cwd }).projectId;
  if (projectId === undefined) return undefined;
  const { targets } = storageRulesTargets(cwd, readProjectFirebaseJson(cwd), { projectId });
  const named = targets.find((target) => target.bucket !== null && isDefaultBucketTarget(target, projectId));
  return named?.bucket ?? `${projectId}.appspot.com`;
}

function isDefaultBucketTarget(target: StorageRulesTarget, projectId: string | undefined): boolean {
  if (target.bucket === null) return true;
  if (projectId === undefined) return false;
  return target.bucket === `${projectId}.appspot.com` || target.bucket === `${projectId}.firebasestorage.app`;
}

function prepareStorageTarget(sandbox: LocalSandbox, target: StorageRulesTarget): string | null {
  if (!existsSync(target.path)) return null;
  const source = readFileSync(target.path, 'utf8');
  try {
    return prepareStorageRulesSource(source, target.path);
  } catch (error) {
    process.stderr.write(
      `[pyric mcp in-process] Storage rules not loaded: ${errorMessage(error)}\n`,
    );
    rememberUnloadedStorageRules(sandbox, source);
    return null;
  }
}

const RULES_STATE_SERVICE_KEY = '__pyric_cli_rules_state';

interface PersistedRulesEntry {
  active: string;
  diskAtSave: string | null;
}

interface PersistedRulesState {
  firestore?: PersistedRulesEntry;
  storage?: {
    default?: PersistedRulesEntry;
    buckets?: Record<string, PersistedRulesEntry>;
  };
}

function readDiskFirestoreRules(cwd: string): string | null {
  try {
    const config = readProjectFirebaseJson(cwd);
    const projectId = resolveFirebaseProject({ projectDir: cwd }).projectId;
    const dbOpts: { projectId?: string } = {};
    if (projectId !== undefined) {
      dbOpts.projectId = projectId;
    }
    const databases = firestoreDatabases(cwd, config, dbOpts);
    const entry = defaultFirestoreDatabase(databases);
    const path = entry?.rulesFile;
    if (entry === undefined || path === undefined || !existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    let candidate = raw;
    if (MODULAR_SOURCE.test(raw)) {
      const resolved = resolveProjectModules(raw, path, path, 'cloud.firestore').result;
      if (!resolved.success) return null;
      candidate = resolved.data.resolved;
    }
    return rulesSourceRejection(candidate) === null ? candidate : null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

function readDiskStorageRules(cwd: string): { default: string | null; buckets: Record<string, string | null> } {
  const buckets: Record<string, string | null> = {};
  try {
    const projectId = resolveFirebaseProject({ projectDir: cwd }).projectId;
    const targetOpts: { projectId?: string } = {};
    if (projectId !== undefined) {
      targetOpts.projectId = projectId;
    }
    const { targets } = storageRulesTargets(cwd, readProjectFirebaseJson(cwd), targetOpts);
    const defaultTarget = targets.find((target) => isDefaultBucketTarget(target, projectId));
    const prepareQuiet = (target: StorageRulesTarget): string | null => {
      if (!existsSync(target.path)) return null;
      try {
        return prepareStorageRulesSource(readFileSync(target.path, 'utf8'), target.path);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return null;
      }
    };
    for (const target of targets) {
      if (target.bucket === null) continue;
      buckets[target.bucket] = prepareQuiet(target);
    }
    let defaultRules: string | null = null;
    if (defaultTarget !== undefined) {
      defaultRules = prepareQuiet(defaultTarget);
    }
    return { default: defaultRules, buckets };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { default: null, buckets };
  }
}

function captureRulesState(sandbox: LocalSandbox, cwd: string): PersistedRulesState | null {
  const state: PersistedRulesState = {};
  const activeFs = firestoreRulesInForce(sandbox);
  if (activeFs !== '') {
    state.firestore = { active: activeFs, diskAtSave: readDiskFirestoreRules(cwd) };
  }
  const diskStorage = readDiskStorageRules(cwd);
  const defaultStorage = getStorageRulesResolution(getAdminStorageSandbox(sandbox))?.source ?? null;
  const bucketEntries: Record<string, PersistedRulesEntry> = {};
  for (const bucket of storageBucketsWithRules(sandbox)) {
    const handle = nameStorageBucket(getAdminStorageSandbox(sandbox, { bucket }), bucket);
    const activeBucket = getStorageRulesResolution(handle)?.source ?? null;
    if (activeBucket !== null) {
      bucketEntries[bucket] = { active: activeBucket, diskAtSave: diskStorage.buckets[bucket] ?? null };
    }
  }
  const hasBuckets = Object.keys(bucketEntries).length > 0;
  if (defaultStorage !== null || hasBuckets) {
    const storageState: NonNullable<PersistedRulesState['storage']> = {};
    if (defaultStorage !== null) {
      storageState.default = { active: defaultStorage, diskAtSave: diskStorage.default };
    }
    if (hasBuckets) {
      storageState.buckets = bucketEntries;
    }
    state.storage = storageState;
  }
  if (state.firestore !== undefined || state.storage !== undefined) {
    return state;
  }
  return null;
}

function readPersistedRulesState(cwd: string): PersistedRulesState | null {
  const path = join(cwd, IN_PROCESS_STATE_RELATIVE);
  if (!existsSync(path)) return null;
  try {
    const snap = decodeInProcessSnapshot(path);
    const raw = snap.services[RULES_STATE_SERVICE_KEY];
    if (raw !== null && typeof raw === 'object') {
      return raw as PersistedRulesState;
    }
    return null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

/** Persist the sandbox to `<cwd>/.pyric/state/in-process.json` atomically. */
export function saveSandboxSnapshot(sandbox: LocalSandbox, cwd: string): void {
  const snap = sandbox.snapshot();
  const services = {
    ...snap.services,
    [APP_SESSION_SERVICE_KEY]: captureAppSession(sandbox),
    [AGENT_IDENTITY_SERVICE_KEY]: captureAgentIdentity(sandbox),
    [CLOCK_STATE_SERVICE_KEY]: captureClockState(sandbox),
    [AI_LOGIC_SCRIPTS_SERVICE_KEY]: captureAiLogicScripts(sandbox),
    [RULES_STATE_SERVICE_KEY]: captureRulesState(sandbox, cwd),
  };
  const bundle = bundleRecords(serializeToBuckets(snap.firestore, services, 0));
  const path = join(cwd, IN_PROCESS_STATE_RELATIVE);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bundle, 'utf8');
  renameSync(tmp, path);
}

/** Restore the sandbox from `.pyric/state/in-process.json` when present. */
export function loadSandboxSnapshot(sandbox: LocalSandbox, cwd: string): number | null {
  const path = join(cwd, IN_PROCESS_STATE_RELATIVE);
  if (!existsSync(path)) return null;
  const snap = decodeInProcessSnapshot(path);
  sandbox.loadSnapshot(snap);
  restoreAppSession(sandbox, snap.services[APP_SESSION_SERVICE_KEY]);
  restoreAgentIdentity(sandbox, snap.services[AGENT_IDENTITY_SERVICE_KEY]);
  restoreClockState(sandbox, snap.services[CLOCK_STATE_SERVICE_KEY]);
  restoreAiLogicScripts(sandbox, snap.services[AI_LOGIC_SCRIPTS_SERVICE_KEY]);
  const persistedRules = snap.services[RULES_STATE_SERVICE_KEY] as PersistedRulesState | null | undefined;
  const persistedFs = persistedRules?.firestore;
  if (
    persistedFs !== undefined &&
    persistedFs.active !== '' &&
    persistedFs.diskAtSave === readDiskFirestoreRules(cwd)
  ) {
    loadFirestoreRules(sandbox, persistedFs.active);
  }
  return Object.keys(snap.firestore).length;
}

export interface InProcessRunOptions {
  surface?: string;
  allowProduction?: boolean;
  projectDir?: string;
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
  inProcessOnly?: boolean;
  initialHost?: Discovered;
  initialHostMode?: 'sandbox' | 'live';
}

/** Build the tool-event writer for an in-process session, or null when unset. */
export function createInProcessEventWriter(env: NodeJS.ProcessEnv): AuditWriter | null {
  const evalLogPath = env[EVAL_LOG_ENV_KEY];
  if (evalLogPath === undefined || evalLogPath.trim() === '') return null;
  return createEvalLogWriter(evalLogPath, readEvalRunIdentity(env));
}

/** Wire a session's event writer into the server options when present. */
export function withInProcessEventWriter(
  options: InProcessMcpServerOptions,
  writer: AuditWriter | null,
): InProcessMcpServerOptions {
  if (!writer) return options;
  return {
    ...options,
    onToolEvent: (event) => writer.write(event),
    onCallRejected: (event) => writer.write(event),
  };
}

/** Run the stdio MCP server, owning `.pyric/state/in-process.json` when local. */
export async function runInProcessMcp(
  cwd: string = process.cwd(),
  options: InProcessRunOptions = {},
): Promise<number> {
  const projectDir = resolve(cwd, options.projectDir ?? '.');
  let initialOwner: ProjectStateOwner | null = null;
  if (options.initialHost === undefined || options.inProcessOnly) {
    mkdirSync(projectDir, { recursive: true });
    initialOwner = await claimProjectState(projectDir, 'in-process');
  }
  try {
    return await runInProcessSession(projectDir, options, initialOwner);
  } finally {
    initialOwner?.close();
  }
}

async function runInProcessSession(
  projectDir: string,
  options: InProcessRunOptions,
  initialOwner: ProjectStateOwner | null,
): Promise<number> {
  const log = (m: string): void => {
    process.stderr.write(`[pyric mcp in-process] ${m}\n`);
  };

  const env = options.env ?? process.env;
  const evalLog = createInProcessEventWriter(env);
  if (evalLog !== null) log(`recording tool events to ${evalLog.path}`);

  const sandbox = initializeSandbox();
  const storage = openPersistedServices(sandbox, projectDir);
  const reloadRules = (): void => {
    const projectRules = loadProjectRules(sandbox, projectDir, log);
    if (projectRules !== null && projectRules.refused === null) {
      log(`rules loaded from ${projectRules.path}`);
    } else if (projectRules !== null) {
      log(`rules not loaded from ${projectRules.path}: ${projectRules.refused} The sandbox keeps the rules in force.`);
    } else {
      log(`no Firestore rules for (default) found in ${projectDir}`);
    }
  };
  const persistence = createInProcessPersistence({
    projectDir,
    stateRelativePath: IN_PROCESS_STATE_RELATIVE,
    initialOwner,
    storage,
    loadSnapshot: () => loadSandboxSnapshot(sandbox, projectDir),
    saveSnapshot: () => saveSandboxSnapshot(sandbox, projectDir),
    reloadRules,
    log,
  });

  try {
    let server;
    try {
      await persistence.hydrateAtStartup();
      const baseServerOptions: InProcessMcpServerOptions = {
        onAfterDispatch: () => persistence.scheduleSave(),
        onBeforeLocalFallback: () => persistence.activateOnFallback(),
        surface: options.surface,
        allowProduction: options.allowProduction,
        projectDir,
        inProcessOnly: options.inProcessOnly,
        initialHost: options.initialHost,
        initialHostMode: options.initialHostMode,
      };
      server = buildInProcessMcpServer(sandbox, withInProcessEventWriter(baseServerOptions, evalLog));
    } catch (error) {
      log(errorMessage(error));
      return 1;
    }
    const transport = options.transport ?? (await openStdioTransport());

    return await new Promise<number>((resolveExit) => {
      let stopping = false;
      const onStdinEnd = (): void => stop(0);
      const finishStop = async (code: number): Promise<number> => {
        await persistence.flushStorage();
        try {
          await server.close();
          return code;
        } catch (error) {
          log(`shutdown failed: ${errorMessage(error)}`);
          if (code === 0) return 1;
          return code;
        }
      };
      const stop = (code: number): void => {
        if (stopping) return;
        stopping = true;
        process.stdin.off('end', onStdinEnd);
        persistence.flush();
        void finishStop(code).then(resolveExit);
      };
      transport.onclose = () => stop(0);
      process.stdin.once('end', onStdinEnd);
      process.once('SIGINT', () => stop(0));
      process.once('SIGTERM', () => stop(0));
      let readyMessage = `in-process sandbox MCP server ready (persisting to ${IN_PROCESS_STATE_RELATIVE})`;
      if (!persistence.isPersisting() && options.initialHost !== undefined) {
        readyMessage = `MCP server ready (routing to Node host at ${options.initialHost.url})`;
      }
      void server.connect(transport).then(
        () => log(readyMessage),
        (error) => {
          log(`failed to start: ${errorMessage(error)}`);
          resolveExit(1);
        },
      );
    });
  } finally {
    persistence.release();
  }
}
