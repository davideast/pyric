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
import { buildMcpServer } from './mcp.js';
import { getDefaultMcpToolSurface } from './mcp-contract.js';
import { createLocalBridge, type LocalBridgeOptions } from './local-bridge.js';
import { resolveBridgeScope } from './scope.js';
import type { ProjectScope } from '../../credentials/core/types.js';

/** Where the headless sandbox snapshot is persisted (relative to the project
 *  dir). Deliberately separate from serve's `state.json` (different format). */
export const HEADLESS_STATE_RELATIVE = join('.pyric', 'state', 'headless.json');

export interface HeadlessMcpOptions extends LocalBridgeOptions {
  /** Project credentials for the Rules Test API operations; `runHeadlessMcp`
   *  resolves them once from the environment. Absent means those operations
   *  return their credentials error on use. */
  scope?: ProjectScope;
}

/**
 * Build the headless MCP server around an in-process sandbox. Pure: no I/O and
 * no transport, so callers (and tests) can drive it however they like. Mirrors
 * the served bridge's construction (forwarded data-plane + in-process rules
 * tools), with `dispatch` bound to the local sandbox instead of a ws peer.
 */
export function buildHeadlessMcpServer(sandbox: LocalSandbox, opts: HeadlessMcpOptions = {}) {
  const { scope, ...bridgeOptions } = opts;
  const bridge = createLocalBridge(sandbox, bridgeOptions);
  return buildMcpServer(bridge, getDefaultMcpToolSurface(scope ? { scope } : {}));
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

/**
 * Run the headless MCP server over stdio. Loads `.pyric/state/headless.json` on
 * start, debounces a save after each dispatch, and flushes on shutdown. Resolves
 * with an exit code when the stdio transport closes (the editor disconnects).
 */
export async function runHeadlessMcp(cwd: string = process.cwd()): Promise<number> {
  const log = (m: string): void => {
    process.stderr.write(`[pyric mcp headless] ${m}\n`);
  };

  const sandbox = initializeSandbox();
  const rulesPath = loadProjectRules(sandbox, cwd);
  log(rulesPath ? `rules loaded from ${rulesPath}` : `no firestore.rules found in ${cwd}`);

  const restored = loadSandboxSnapshot(sandbox, cwd);
  if (restored !== null) log(`restored ${restored} docs from ${join(cwd, HEADLESS_STATE_RELATIVE)}`);

  // Debounced persistence: a burst of writes collapses to one flush; the final
  // flush runs on shutdown so a clean disconnect never loses the tail.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      saveSandboxSnapshot(sandbox, cwd);
    } catch (e) {
      log(`persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 750);
  };

  const credentials = await resolveBridgeScope();
  log(
    credentials.scope
      ? `project credentials resolved from ${credentials.source} (${credentials.scope.projectId})`
      : `no project credentials: ${credentials.reason}`,
  );

  const server = buildHeadlessMcpServer(sandbox, {
    onAfterDispatch: scheduleSave,
    ...(credentials.scope ? { scope: credentials.scope } : {}),
  });
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const onStdinEnd = (): void => stop(0);
    const stop = (code: number): void => {
      if (stopping) return;
      stopping = true;
      process.stdin.off('end', onStdinEnd);
      flush();
      void server.close().then(
        () => resolve(code),
        (e) => {
          log(`shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
          resolve(code === 0 ? 1 : code);
        },
      );
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
