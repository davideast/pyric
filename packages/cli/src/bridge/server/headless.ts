/**
 * Headless MCP server: runs the pyric sandbox IN this process (no browser, no
 * serve) and exposes the SAME tool surface the bridge advertises, over stdio.
 *
 * This is the zero-setup half of the hybrid MCP server
 * (design rationale): when no `pyric dev --bridge` is running to
 * attach to, the MCP server hosts its own sandbox. The tool surface is identical
 * to the served bridge by construction (`buildSandboxDispatcher` is the shared
 * source pinned by `tool-parity.test.ts`), including the per-identity `as` arg.
 *
 * Persistence (Phase 1b) uses the v3 bundle codec the worker already uses for
 * transfer/branches (`serializeToBuckets` + `bundleRecords`). It writes its OWN
 * `.pyric/state/headless.json`, NOT serve's `state.json` (which currently uses a
 * different on-disk envelope, and carries a controller-blob version that has
 * drifted from pyric's snapshot SCHEMA_VERSION). Unifying the two formats so a
 * headless session and a `pyric dev` session can share one file is a tracked
 * design item, not done here.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  initializeSandbox,
  serializeToBuckets,
  bundleRecords,
  parseBundle,
  deserializeFromBuckets,
  type LocalSandbox,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { getAuth } from 'pyric/auth';
import { getAdminDatabase } from 'pyric/database';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import type { FirebaseStorage } from 'pyric/storage';
import {
  saveStorageSidecar,
  loadStorageSidecar,
  STORAGE_SIDECAR_RELATIVE,
} from './storage-sidecar.js';
import { buildMcpServer, type RejectedToolCall } from './mcp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRenderedSurface } from './surface-server.js';
import { getDefaultMcpToolSurface } from './mcp-contract.js';
import { renderSurface } from '../surface/index.js';
import { createSurfaceContext } from '../surface/context.js';
import { createLocalBridge, type LocalBridgeOptions } from './local-bridge.js';
import {
  createEvalLogWriter,
  readEvalRunIdentity,
  EVAL_LOG_ENV_KEY,
  type AuditWriter,
} from './audit.js';
import type { BridgeToolEvent } from './bridge.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** The stdio transport is a late import: the SDK is heavy and only needed here. */
async function openStdioTransport(): Promise<Transport> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  return new StdioServerTransport();
}

/** Where the headless sandbox snapshot is persisted (relative to the project
 *  dir). Deliberately separate from serve's `state.json` (different format). */
export const HEADLESS_STATE_RELATIVE = join('.pyric', 'state', 'headless.json');

export interface HeadlessMcpServerOptions extends LocalBridgeOptions {
  /** Tool-surface variant id. Absent serves the default surface. */
  surface?: string;
  /**
   * Called for a tool call the MCP SDK refused before any handler ran, so a
   * schema rejection is still recorded. Absent leaves the server as it was.
   */
  onCallRejected?: (event: BridgeToolEvent) => void;
}

/**
 * Build the headless MCP server around an in-process sandbox. Pure: no I/O and
 * no transport, so callers (and tests) can drive it however they like. Mirrors
 * the served bridge's construction (forwarded data-plane + in-process rules
 * tools), with `dispatch` bound to the local sandbox instead of a ws peer.
 */
export function buildHeadlessMcpServer(sandbox: LocalSandbox, opts?: HeadlessMcpServerOptions) {
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

  // No variant is the path the server has always taken: the default surface
  // registered by `buildMcpServer`, with the bridge's own consumer registry and
  // caller identity behind the in-process identity tools. A variant id renders
  // the operation set instead and registers it through the surface adapter, on
  // a server built here rather than there.
  if (opts?.surface === undefined) {
    const surface = getDefaultMcpToolSurface({
      consumers: bridge.consumers,
      callerIdentity: bridge.callerIdentity,
    });
    if (!onCallRejected) return buildMcpServer(bridge, surface);
    return buildMcpServer(bridge, { ...surface, onCallRejected: rejectionEvent });
  }

  // Throws for an id no renderer claims, which fails the session at startup
  // rather than measuring the wrong surface.
  const rendered = renderSurface(opts.surface);
  const server = new McpServer({ name: 'pyric', version: bridge.version });
  return registerRenderedSurface(server, bridge, rendered, createSurfaceContext(sandbox), {
    onCallRejected: onCallRejected ? rejectionEvent : undefined,
    onAfterCall: opts.onAfterDispatch,
  });
}

/**
 * Load `<cwd>/firestore.rules` into the sandbox when present. Returns the path
 * it loaded, or null if there was no rules file. Without rules, rules-enforcing
 * (`as:{uid}`) ops fall back to the sandbox's default; admin ops are unaffected.
 */
export function loadProjectRules(sandbox: LocalSandbox, cwd: string): string | null {
  const rulesPath = join(cwd, 'firestore.rules');
  if (!existsSync(rulesPath)) return null;
  setRules(sandbox, readFileSync(rulesPath, 'utf8'));
  return rulesPath;
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
 */
export function openPersistedServices(sandbox: LocalSandbox, cwd: string): FirebaseStorage {
  getAuth(sandbox);
  getAdminDatabase(sandbox);
  // Storage rules are read only by the call that opens the service, so the
  // project's rules have to be in hand here or not at all.
  const rulesPath = join(cwd, 'storage.rules');
  if (!existsSync(rulesPath)) return getAdminStorageSandbox(sandbox);
  return getAdminStorageSandbox(sandbox, { rules: readFileSync(rulesPath, 'utf8') });
}

/**
 * Persist the sandbox to `<cwd>/.pyric/state/headless.json` using the v3 bundle
 * codec (the same `serializeToBuckets` + `bundleRecords` the worker uses). Atomic
 * tmp+rename so a crash mid-write never truncates the live file.
 */
export function saveSandboxSnapshot(sandbox: LocalSandbox, cwd: string): void {
  const snap = sandbox.snapshot();
  const bundle = bundleRecords(serializeToBuckets(snap.firestore, snap.services, 0));
  const path = join(cwd, HEADLESS_STATE_RELATIVE);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bundle, 'utf8');
  renameSync(tmp, path);
}

/**
 * Restore the sandbox from the headless snapshot file if present (a clobber via
 * `loadSnapshot`). Returns the restored doc count, or null when there is no file.
 */
export function loadSandboxSnapshot(sandbox: LocalSandbox, cwd: string): number | null {
  const path = join(cwd, HEADLESS_STATE_RELATIVE);
  if (!existsSync(path)) return null;
  const snap = deserializeFromBuckets(parseBundle(readFileSync(path, 'utf8')));
  sandbox.loadSnapshot(snap);
  return Object.keys(snap.firestore).length;
}

export interface HeadlessRunOptions {
  /** Tool-surface variant id, from `--surface` or `PYRIC_TOOL_SURFACE`. */
  surface?: string;
  /** Environment to read the evaluation settings from. Defaults to the process. */
  env?: NodeJS.ProcessEnv;
  /**
   * Transport to serve on. Defaults to stdio, which is what an editor and the
   * evaluation runner both use; a test supplies an in-memory pair so it can
   * close the session and observe the final flush.
   */
  transport?: Transport;
}

/**
 * Build the tool-event writer for a headless session. Returns null when no
 * evaluation log is named, which is the default and records nothing.
 */
export function createHeadlessEventWriter(env: NodeJS.ProcessEnv): AuditWriter | null {
  const evalLogPath = env[EVAL_LOG_ENV_KEY];
  if (evalLogPath === undefined || evalLogPath.trim() === '') return null;
  return createEvalLogWriter(evalLogPath, readEvalRunIdentity(env));
}

/**
 * Wire a session's event writer into the server options. Without a writer the
 * options are left as they were, and the server records nothing.
 */
export function withHeadlessEventWriter(
  options: HeadlessMcpServerOptions,
  writer: AuditWriter | null,
): HeadlessMcpServerOptions {
  if (!writer) return options;
  return {
    ...options,
    onToolEvent: (event) => writer.write(event),
    onCallRejected: (event) => writer.write(event),
  };
}

/**
 * Run the headless MCP server over stdio. Loads `.pyric/state/headless.json` and
 * the storage sidecar on start, debounces a save after each dispatch, and
 * flushes both on shutdown. Resolves with an exit code when the stdio transport
 * closes (the editor disconnects).
 *
 * With `PYRIC_EVAL_LOG` set, every tool call is appended to that file as NDJSON
 * and the per-project audit log is not written. Without it, nothing is recorded,
 * which is the behaviour headless mode has always had.
 */
export async function runHeadlessMcp(
  cwd: string = process.cwd(),
  options: HeadlessRunOptions = {},
): Promise<number> {
  const log = (m: string): void => {
    process.stderr.write(`[pyric mcp headless] ${m}\n`);
  };

  const env = options.env ?? process.env;
  const evalLog = createHeadlessEventWriter(env);
  if (evalLog) log(`recording tool events to ${evalLog.path}`);

  const sandbox = initializeSandbox();
  // Before the snapshot, and before the transport serves a single call.
  const storage = openPersistedServices(sandbox, cwd);
  const rulesPath = loadProjectRules(sandbox, cwd);
  log(rulesPath ? `rules loaded from ${rulesPath}` : `no firestore.rules found in ${cwd}`);

  const restored = loadSandboxSnapshot(sandbox, cwd);
  if (restored !== null) log(`restored ${restored} docs from ${join(cwd, HEADLESS_STATE_RELATIVE)}`);
  const restoredObjects = await loadStorageSidecar(storage, cwd);
  if (restoredObjects > 0) {
    log(`restored ${restoredObjects} objects from ${join(cwd, STORAGE_SIDECAR_RELATIVE)}`);
  }

  // Debounced persistence: a burst of writes collapses to one flush. The final
  // flush is synchronous and runs before the server closes, so the file a reader
  // opens after the session always contains the last writes. `pendingSave`
  // covers the path where the process ends without reaching that flush.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave = false;
  const saveNow = (): void => {
    pendingSave = false;
    try {
      saveSandboxSnapshot(sandbox, cwd);
    } catch (e) {
      log(`persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const flush = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveNow();
  };
  const scheduleSave = (): void => {
    pendingSave = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 750);
  };
  const saveIfPendingAtExit = (): void => {
    if (pendingSave) saveNow();
  };
  process.once('exit', saveIfPendingAtExit);

  const baseServerOptions: HeadlessMcpServerOptions = {
    onAfterDispatch: scheduleSave,
    surface: options.surface,
  };
  // A surface id no renderer claims is a start-up failure, not a per-call one:
  // serving the wrong surface would silently mislabel a whole run.
  let server;
  try {
    server = buildHeadlessMcpServer(sandbox, withHeadlessEventWriter(baseServerOptions, evalLog));
  } catch (e) {
    process.off('exit', saveIfPendingAtExit);
    log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const transport = options.transport ?? (await openStdioTransport());

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const onStdinEnd = (): void => stop(0);
    /**
     * Write the storage sidecar. Storage reads are asynchronous, so this is the
     * one part of the final flush that cannot be synchronous; it runs before
     * the exit code resolves, which is before the process ends.
     */
    const flushStorage = async (): Promise<void> => {
      try {
        await saveStorageSidecar(storage, cwd);
      } catch (e) {
        log(`storage persist failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const finishStop = async (code: number): Promise<number> => {
      await flushStorage();
      try {
        await server.close();
        return code;
      } catch (e) {
        log(`shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
        return code === 0 ? 1 : code;
      }
    };
    const stop = (code: number): void => {
      if (stopping) return;
      stopping = true;
      process.stdin.off('end', onStdinEnd);
      // Synchronous, and before `server.close()`: the debounced timer can hold
      // writes that have not reached disk, and nothing after this point is
      // guaranteed to run.
      flush();
      process.off('exit', saveIfPendingAtExit);
      void finishStop(code).then(resolve);
    };
    transport.onclose = () => stop(0);
    // StdioServerTransport 1.29 no longer reports stdin EOF through onclose.
    // Editors close the pipe to end an MCP session, so own that lifecycle
    // signal explicitly and then close the server/transport above.
    process.stdin.once('end', onStdinEnd);
    process.once('SIGINT', () => stop(0));
    process.once('SIGTERM', () => stop(0));
    void server.connect(transport).then(
      () => log(`headless sandbox MCP server ready (persisting to ${HEADLESS_STATE_RELATIVE})`),
      (e) => {
        log(`failed to start: ${e instanceof Error ? e.message : String(e)}`);
        resolve(1);
      },
    );
  });
}
