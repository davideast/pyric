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
import { getFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
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
import { readFirebaseRcSync, type FirebaseJson } from '../../cli/firebase-json.js';
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

/** Where the in-process sandbox snapshot is persisted (relative to the project
 *  dir). Deliberately separate from serve's `state.json` (different format). */
export const IN_PROCESS_STATE_RELATIVE = join('.pyric', 'state', 'in-process.json');

export interface InProcessMcpServerOptions extends LocalBridgeOptions {
  /** Tool-surface variant id. Absent serves the default surface. */
  surface?: string;
  /**
   * Directory the session's `.pyric/` files live under, handed to every method
   * that reaches the filesystem. Absent, the process working directory.
   */
  projectDir?: string;
  /**
   * Mount `production` methods (ADR-0014 Decision 5). Defaults to false: a
   * `production` method is neither listed nor callable unless the server was
   * started with `--allow-production`.
   */
  allowProduction?: boolean;
  /**
   * Called for a tool call the MCP SDK refused before any handler ran, so a
   * schema rejection is still recorded. Absent leaves the server as it was.
   */
  onCallRejected?: (event: BridgeToolEvent) => void;
  /** Suppress following a live Node host (--in-process flag). */
  inProcessOnly?: boolean;
  /** Pre-configured target router, if any. */
  targetRouter?: TargetRouter;
  /** Cache TTL in ms for the pointer check (default 1000ms). */
  cacheTtlMs?: number;
  /** Injected discovery function for testing. */
  discover?: typeof discoverServe;
  /** Injected hosted method caller for testing. */
  callHosted?: typeof callHostedMethod;
  /** Pre-discovered Node host present when the session started. */
  initialHost?: Discovered;
  /** Runtime mode of `initialHost`. */
  initialHostMode?: 'sandbox' | 'live';
  /** Optional hook run before local fallback execution in TargetRouter. */
  onBeforeLocalFallback?: () => Promise<string | undefined>;
}

/**
 * Build the in-process MCP server around an in-process sandbox. Pure: no I/O and
 * no transport, so callers (and tests) can drive it however they like. Mirrors
 * the served bridge's construction (forwarded data-plane + in-process rules
 * tools), with `dispatch` bound to the local sandbox instead of a ws peer.
 */
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
  // With no page, rules see the default bucket under the name the project gives it.
  const defaultBucketName = inProcessDefaultBucketName(projectDir);
  surfaceContext.storageBucketName = () => defaultBucketName;
  return registerRenderedSurface(server, bridge, rendered, surfaceContext, {
    onCallRejected: onCallRejected ? rejectionEvent : undefined,
    onAfterCall: opts?.onAfterDispatch,
    projectIdentity,
  });
}

/** The project rules file a load read, and why it was refused, if it was. */
export interface ProjectRulesLoad {
  path: string;
  /** Why production would not load the file, when the sandbox refused it; null when it loaded. */
  refused: string | null;
}

function readProjectFirebaseJson(cwd: string): FirebaseJson | null {
  const path = join(cwd, 'firebase.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FirebaseJson;
  } catch (error) {
    throw new Error(`pyric: failed to parse firebase.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Load the rules `<cwd>/firebase.json` deploys to the `(default)` Firestore
 * database, resolved as the dev server resolves them, else
 * `<cwd>/firestore.rules` when `firebase.json` names none. A file production
 * would not load (it does not parse, or it is past a compile limit) is
 * refused: the rules in force stay, and lint and simulate read the file's
 * source. Null when there is no rules file. Without rules, rules-enforcing
 * (`as:{uid}`) ops fall back to the sandbox's default; admin ops are
 * unaffected. `onWarning` receives one line per named database or unresolved
 * deploy target pyric does not serve yet, and one for a named file that is
 * missing.
 */
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

/**
 * Open the services whose state a snapshot carries.
 *
 * `loadSnapshot` restores only services that are already registered, so a start
 * that applies a snapshot before anything has touched auth, database, or
 * storage drops those buckets without a word. Opening them first is what makes
 * a restored session complete. Returns the storage handle, which the sidecar
 * codec reads and writes; storage keeps its own durability and is not in the
 * bundle at all.
 *
 * Storage enforces the rules `firebase.json` deploys to each bucket (or the
 * runtime rules persisted in the snapshot when the disk rules have not changed
 * since save), resolved by the dev server's `storageRulesTargets` and prepared
 * by `prepareStorageRulesSource`, with `2+modules` imports resolved against the
 * file's own directory. With no page to name the default bucket, it is the
 * bucket `.firebaserc`'s project names (see {@link inProcessDefaultBucketName}).
 */
export function openPersistedServices(sandbox: LocalSandbox, cwd: string): FirebaseStorage {
  getAuth(sandbox);
  getAdminDatabase(sandbox);
  // Storage rules are read only by the call that opens the service, so the
  // project's rules have to be in hand here or not at all.
  const persistedStorage = readPersistedRulesState(cwd)?.storage;
  const projectId = readFirebaseRcSync(cwd)?.projects?.default;
  const { targets } = storageRulesTargets(cwd, readProjectFirebaseJson(cwd), projectId === undefined ? {} : { projectId });
  const defaultTarget = targets.find((target) => isDefaultBucketTarget(target, projectId));
  for (const target of targets) {
    if (target.bucket === null) continue;
    const prepared = prepareStorageTarget(sandbox, target);
    const savedBucket = persistedStorage?.buckets?.[target.bucket];
    const effective =
      savedBucket !== undefined && savedBucket.diskAtSave === prepared ? savedBucket.active : prepared;
    if (effective !== null) deployStorageBucketRules(sandbox, target.bucket, effective);
  }
  for (const [bucket, savedBucket] of Object.entries(persistedStorage?.buckets ?? {})) {
    const configuredInTargets = targets.some((target) => target.bucket === bucket);
    if (!configuredInTargets && savedBucket.diskAtSave === null) {
      deployStorageBucketRules(sandbox, bucket, savedBucket.active);
    }
  }
  const diskDefault = defaultTarget === undefined ? null : prepareStorageTarget(sandbox, defaultTarget);
  const savedDefault = persistedStorage?.default;
  const defaultRules =
    savedDefault !== undefined && savedDefault.diskAtSave === diskDefault ? savedDefault.active : diskDefault;
  if (defaultRules === null) return getAdminStorageSandbox(sandbox);
  return getAdminStorageSandbox(sandbox, { rules: defaultRules });
}

/**
 * The default bucket's name with no page to give it: the bucket
 * `firebase.json` names that `.firebaserc`'s project owns by default,
 * `<project>.appspot.com` or `<project>.firebasestorage.app`, else
 * `<project>.appspot.com`. Undefined without a project.
 */
export function inProcessDefaultBucketName(cwd: string): string | undefined {
  const projectId = readFirebaseRcSync(cwd)?.projects?.default;
  if (projectId === undefined) return undefined;
  const { targets } = storageRulesTargets(cwd, readProjectFirebaseJson(cwd), { projectId });
  const named = targets.find((target) => target.bucket !== null && isDefaultBucketTarget(target, projectId));
  return named?.bucket ?? `${projectId}.appspot.com`;
}

/** Whether a deploy target is the default bucket's: unnamed, or named for the project's default bucket. */
function isDefaultBucketTarget(target: StorageRulesTarget, projectId: string | undefined): boolean {
  if (target.bucket === null) return true;
  if (projectId === undefined) return false;
  return target.bucket === `${projectId}.appspot.com` || target.bucket === `${projectId}.firebasestorage.app`;
}

/**
 * One target's rules, prepared for install, or null when its file is missing
 * or does not install. A rules file the sandbox cannot install cannot govern
 * its bucket, but a lint call must still be able to say what is wrong with
 * it, so the source is kept for the lint operation.
 */
function prepareStorageTarget(sandbox: LocalSandbox, target: StorageRulesTarget): string | null {
  if (!existsSync(target.path)) return null;
  const source = readFileSync(target.path, 'utf8');
  try {
    return prepareStorageRulesSource(source, target.path);
  } catch (error) {
    process.stderr.write(
      `[pyric mcp in-process] Storage rules not loaded: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    rememberUnloadedStorageRules(sandbox, source);
    return null;
  }
}

/**
 * Where the app session rides inside a snapshot's `services` map, alongside
 * the persistable services the sandbox core knows about. `sandbox.snapshot()`
 * and `loadSnapshot()` are keyed by registered service name and this name is
 * never registered, so the sandbox core passes it through untouched in both
 * directions without knowing it carries anything auth-shaped.
 */
const APP_SESSION_SERVICE_KEY = '__pyric_cli_app_session';
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
    const projectId = readFirebaseRcSync(cwd)?.projects?.default;
    const databases = firestoreDatabases(cwd, config, projectId === undefined ? {} : { projectId });
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
  } catch {
    return null;
  }
}

function readDiskStorageRules(cwd: string): { default: string | null; buckets: Record<string, string | null> } {
  const buckets: Record<string, string | null> = {};
  try {
    const projectId = readFirebaseRcSync(cwd)?.projects?.default;
    const { targets } = storageRulesTargets(cwd, readProjectFirebaseJson(cwd), projectId === undefined ? {} : { projectId });
    const defaultTarget = targets.find((target) => isDefaultBucketTarget(target, projectId));
    const prepareQuiet = (target: StorageRulesTarget): string | null => {
      if (!existsSync(target.path)) return null;
      try {
        return prepareStorageRulesSource(readFileSync(target.path, 'utf8'), target.path);
      } catch {
        return null;
      }
    };
    for (const target of targets) {
      if (target.bucket === null) continue;
      buckets[target.bucket] = prepareQuiet(target);
    }
    const defaultRules = defaultTarget === undefined ? null : prepareQuiet(defaultTarget);
    return { default: defaultRules, buckets };
  } catch {
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
  if (defaultStorage !== null || Object.keys(bucketEntries).length > 0) {
    state.storage = {
      ...(defaultStorage !== null ? { default: { active: defaultStorage, diskAtSave: diskStorage.default } } : {}),
      ...(Object.keys(bucketEntries).length > 0 ? { buckets: bucketEntries } : {}),
    };
  }
  return state.firestore !== undefined || state.storage !== undefined ? state : null;
}

function readPersistedRulesState(cwd: string): PersistedRulesState | null {
  const path = join(cwd, IN_PROCESS_STATE_RELATIVE);
  if (!existsSync(path)) return null;
  try {
    const snap = decodeInProcessSnapshot(path);
    const raw = snap.services[RULES_STATE_SERVICE_KEY];
    return raw !== null && typeof raw === 'object' ? (raw as PersistedRulesState) : null;
  } catch {
    return null;
  }
}

/** What is captured for the app session: the signed-in uid and the tenant
 *  scope it authenticated under, so a later process restores both rather than
 *  just the uid and a default (untenanted) scope. */
interface PersistedAppSession {
  uid: string;
  tenantId: string | null;
}

/** The app session to fold into a snapshot's `services` map, or `null` when
 *  signed out, meaning nothing for a later process to restore. */
function captureAppSession(sandbox: LocalSandbox): PersistedAppSession | null {
  const auth = getAuth(sandbox);
  const uid = auth.currentUser?.uid ?? null;
  if (uid === null) return null;
  return { uid, tenantId: authSandbox.getTenantId(auth) };
}

/**
 * Sign the captured uid back in through the auth backend's own restore seam
 * (`sandbox.restoreSession`), never a session minted outside it, then restore
 * the tenant scope it carried. Called after `sandbox.loadSnapshot()` so the
 * user pool the uid names is already back in place. A uid the pool no longer
 * holds (the user was deleted since the snapshot was taken) leaves the app
 * signed out rather than throwing: the state file is stale, not corrupt.
 */
function restoreAppSession(sandbox: LocalSandbox, stored: unknown): void {
  const parsed = stored as PersistedAppSession | null | undefined;
  if (parsed === null || parsed === undefined) return;
  const auth = getAuth(sandbox);
  try {
    authSandbox.restoreSession(auth, parsed.uid);
  } catch {
    return;
  }
  authSandbox.setTenantId(auth, parsed.tenantId);
}

/**
 * Persist the sandbox to `<cwd>/.pyric/state/in-process.json` using the v3 bundle
 * codec (the same `serializeToBuckets` + `bundleRecords` the worker uses). Atomic
 * tmp+rename so a crash mid-write never truncates the live file. Carries the
 * app session (the uid `auth.currentUser` names, and its tenant) alongside the
 * user pool, so `pyric auth signInWithEmailAndPassword` in one process and
 * `pyric auth whoami` in the next see the same session.
 */
export function saveSandboxSnapshot(sandbox: LocalSandbox, cwd: string): void {
  const snap = sandbox.snapshot();
  const services = {
    ...snap.services,
    [APP_SESSION_SERVICE_KEY]: captureAppSession(sandbox),
    [RULES_STATE_SERVICE_KEY]: captureRulesState(sandbox, cwd),
  };
  const bundle = bundleRecords(serializeToBuckets(snap.firestore, services, 0));
  const path = join(cwd, IN_PROCESS_STATE_RELATIVE);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bundle, 'utf8');
  renameSync(tmp, path);
}

/**
 * Restore the sandbox from the in-process snapshot file if present (a clobber via
 * `loadSnapshot`). Returns the restored doc count, or null when there is no file.
 */
export function loadSandboxSnapshot(sandbox: LocalSandbox, cwd: string): number | null {
  const path = join(cwd, IN_PROCESS_STATE_RELATIVE);
  if (!existsSync(path)) return null;
  const snap = decodeInProcessSnapshot(path);
  sandbox.loadSnapshot(snap);
  restoreAppSession(sandbox, snap.services[APP_SESSION_SERVICE_KEY]);
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
  /** Tool-surface variant id, from `--surface` or `PYRIC_TOOL_SURFACE`. */
  surface?: string;
  /**
   * Mount `production` methods, from `--allow-production` or
   * `PYRIC_ALLOW_PRODUCTION`. Defaults to false.
   */
  allowProduction?: boolean;
  /**
   * Directory the session reads its rules files and `.pyric/state` from and
   * writes them back to, from `--project-dir` or `PYRIC_PROJECT_DIR`. A relative
   * value resolves against `cwd`. Absent, the project directory is `cwd`, which
   * is what every existing caller gets.
   */
  projectDir?: string;
  /** Environment to read the evaluation settings from. Defaults to the process. */
  env?: NodeJS.ProcessEnv;
  /**
   * Transport to serve on. Defaults to stdio, which is what an editor and the
   * evaluation runner both use; a test supplies an in-memory pair so it can
   * close the session and observe the final flush.
   */
  transport?: Transport;
  /** Suppress following a live Node host (--in-process flag). */
  inProcessOnly?: boolean;
  /** Pre-discovered Node host present when the session started. */
  initialHost?: Discovered;
  /** Runtime mode of `initialHost`. */
  initialHostMode?: 'sandbox' | 'live';
}

/**
 * Build the tool-event writer for an in-process session. Returns null when no
 * evaluation log is named, which is the default and records nothing.
 */
export function createInProcessEventWriter(env: NodeJS.ProcessEnv): AuditWriter | null {
  const evalLogPath = env[EVAL_LOG_ENV_KEY];
  if (evalLogPath === undefined || evalLogPath.trim() === '') return null;
  return createEvalLogWriter(evalLogPath, readEvalRunIdentity(env));
}

/**
 * Wire a session's event writer into the server options. Without a writer the
 * options are left as they were, and the server records nothing.
 */
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

/**
 * Run the stdio MCP server. Owns `.pyric/state/in-process.json` when no Node
 * host was discovered at startup; routes straight to `options.initialHost`
 * without claiming the in-process lock when a Node host is already running.
 */
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
  const failureMessage = (error: unknown): string => {
    const isError = error instanceof Error;
    return isError ? error.message : String(error);
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
    // A corrupt state file or unknown surface id is a start-up failure, not a
    // per-call one: never serve over an unreadable snapshot or mislabel a run.
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
    } catch (e) {
      log(failureMessage(e));
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
        } catch (e) {
          log(`shutdown failed: ${failureMessage(e)}`);
          const wasSuccessful = code === 0;
          return wasSuccessful ? 1 : code;
        }
      };
      const stop = (code: number): void => {
        if (stopping) return;
        stopping = true;
        process.stdin.off('end', onStdinEnd);
        // Synchronous, and before `server.close()`: the debounced timer can hold
        // writes that have not reached disk, and nothing after this point is
        // guaranteed to run.
        persistence.flush();
        void finishStop(code).then(resolveExit);
      };
      transport.onclose = () => stop(0);
      // StdioServerTransport 1.29 no longer reports stdin EOF through onclose.
      // Editors close the pipe to end an MCP session, so own that lifecycle
      // signal explicitly and then close the server/transport above.
      process.stdin.once('end', onStdinEnd);
      process.once('SIGINT', () => stop(0));
      process.once('SIGTERM', () => stop(0));
      let readyMessage = `in-process sandbox MCP server ready (persisting to ${IN_PROCESS_STATE_RELATIVE})`;
      if (!persistence.isPersisting() && options.initialHost !== undefined) {
        readyMessage = `MCP server ready (routing to Node host at ${options.initialHost.url})`;
      }
      void server.connect(transport).then(
        () => log(readyMessage),
        (e) => {
          log(`failed to start: ${failureMessage(e)}`);
          resolveExit(1);
        },
      );
    });
  } finally {
    persistence.release();
  }
}
