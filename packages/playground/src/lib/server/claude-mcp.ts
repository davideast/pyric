/**
 * Claude lane MCP bridge — the SERVER-HOSTED workspace the `claude -p`
 * subprocess gets real tools against (seam A in
 * plans/agent-capability-epic/step-CLAUDE-bridge.md).
 *
 * Why server-hosted (A) and not browser-forwarded (B): the playground's
 * file tools, workspace-test runner, and rules simulator all run
 * headlessly in Node against the in-memory VFS — proven by
 * `src/lib/vfs/file-tools-headless.test.ts` and the experiment harness
 * (`scripts/run-experiment.ts`). The playground has NO browser↔server
 * relay channel today, so seam B would mean building a WebSocket
 * request/response forwarder (ordering, timeouts, reconnects) from
 * scratch. Instead this module hosts the SAME tool handlers in the dev
 * server process; the browser pushes its workspace before a tools turn
 * and pulls the result after (`~/lib/llm/claude-workspace-sync.ts`) —
 * the browser is a viewer for this mode.
 *
 * Why not `pyric serve --bridge`: its MCP surface is the pyric SANDBOX
 * SDK (forwarded ops that need a `connectBridge()` page peer, plus
 * rules lint) — not the playground's workspace tools. What IS reused
 * from the bridge is the hard-won transport lesson (bridge-mount.ts):
 * a stateless `StreamableHTTPServerTransport` is SINGLE-USE, so the
 * MCP server + transport are built PER REQUEST while the workspace
 * (VFS singleton + stores) stays long-lived in the module graph.
 *
 * Tool results are serialised COMPACTLY (single-line JSON, no
 * pretty-print) — the lane pays per token like every other provider.
 *
 * This module is SSR/dev-server only. The tool chain reaches for
 * `window.localStorage` at import time (zustand persistence), so a
 * polyfill is installed before the handlers are dynamically imported —
 * the exact pattern the headless harness and file-tools test use.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolHandler } from '@inbrowser/agent';

/** Server name — the key the lane uses in `--mcp-config`, so Claude
 *  sees tools as `mcp__playground__<name>`. */
export const MCP_SERVER_NAME = 'playground';
export const MCP_SERVER_VERSION = '0.0.1';

/**
 * The tool surface Claude gets: the playground's core authoring loop
 * (file tools + one-call test suite), the rules simulator, the rules
 * stdlib reference + linter, and the jailed `bash` shell (which
 * carries the `man` + `test` builtins). Static so the lane route can
 * build `--allowedTools` without loading the tool chain;
 * `loadWorkspaceTools()` is asserted against this list in tests so
 * the two can't drift.
 *
 * The stdlib/lint trio joined after the user-found delegated-turn
 * failure (trace t-mq9msa9m-xcgt): Claude authoring rules WITHOUT the
 * stdlib reference was the immediate trigger — the prompt mandated a
 * stdlib lookup the session couldn't perform.
 *
 * Deliberately excluded: `firestore_resolve_modules` (resolution is a
 * compile step — this lane's write_file gate resolves `2+modules`
 * imports on save exactly like the browser gate, so the agent never
 * needs the expanded output; epic #787), sandbox discovery / checkpoint / auth /
 * denial-diagnostic tools (browser-session coupled).
 */
export const MCP_TOOL_NAMES = [
  'list_files',
  'search_file',
  'read_file',
  'edit_file',
  'write_file',
  'delete_file',
  'run_workspace_tests',
  'simulate_firestore_write',
  'firestore_rules_stdlib_list',
  'firestore_rules_stdlib_get',
  'firestore_lint_rules',
  'bash',
] as const;

/** `--allowedTools` entries for `claude -p` (mcp__<server>__<tool>). */
export function mcpAllowedTools(): string[] {
  return MCP_TOOL_NAMES.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`);
}

// ── window/localStorage polyfill (before the tool chain loads) ───────

function installWindowPolyfill(): void {
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') return;
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  };
}

// ── tool loading (lazy — one workspace per dev-server process) ───────

let toolsPromise: Promise<ToolHandler[]> | null = null;

/** Load the real playground tool handlers, headless. Cached — the
 *  VFS/store singletons behind them ARE the server workspace, shared
 *  across MCP requests for the dev server's lifetime. */
export function loadWorkspaceTools(): Promise<ToolHandler[]> {
  if (!toolsPromise) {
    toolsPromise = (async () => {
      installWindowPolyfill();
      const [listF, searchF, readF, editF, writeF, deleteF, runTests, simulate, stdlib, bash] =
        await Promise.all([
          import('~/lib/tools/core/listFiles'),
          import('~/lib/tools/core/searchFile'),
          import('~/lib/tools/core/readFile'),
          import('~/lib/tools/core/editFile'),
          import('~/lib/tools/core/writeFile'),
          import('~/lib/tools/core/deleteFile'),
          import('~/lib/tools/core/runWorkspaceTests'),
          import('~/lib/tools/diagnostics/simulate-firestore-write'),
          import('~/lib/tools/core/firestoreRulesStdlib'),
          import('~/lib/tools/core/bash'),
        ]);
      // The stdlib factory also ships `firestore_resolve_modules`
      // (excluded — see MCP_TOOL_NAMES docblock), so pick by name.
      const wanted = new Set<string>(MCP_TOOL_NAMES);
      const stdlibHandlers = stdlib
        .buildFirestoreRulesStdlibHandlers()
        .filter((h) => wanted.has(h.name));
      return [
        listF.listFilesHandler as ToolHandler,
        searchF.searchFileHandler as ToolHandler,
        readF.readFileHandler as ToolHandler,
        editF.editFileHandler as ToolHandler,
        writeF.writeFileHandler as ToolHandler,
        deleteF.deleteFileHandler as ToolHandler,
        runTests.runWorkspaceTestsHandler as ToolHandler,
        simulate.buildSimulateFirestoreWriteHandler() as ToolHandler,
        ...stdlibHandlers,
        bash.bashHandler as ToolHandler,
      ];
    })();
    toolsPromise.catch(() => {
      toolsPromise = null; // don't cache a failed load
    });
  }
  return toolsPromise;
}

// ── MCP server assembly ──────────────────────────────────────────────

/**
 * Build an MCP server over the supplied handlers. Low-level `Server`
 * (not `McpServer`) on purpose: the handlers already carry JSON Schema
 * `parameters`, and `tools/list` can serve them VERBATIM — no
 * JSON-schema→zod→JSON-schema round-trip to lose `enum`/`oneOf`
 * fidelity (the simulator's schema uses both).
 */
export function buildWorkspaceMcpServer(handlers: ToolHandler[]): Server {
  const byName = new Map(handlers.map((h) => [h.name, h]));
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: handlers.map((h) => ({
      name: h.name,
      description: h.description,
      inputSchema: h.parameters as { type: 'object'; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = byName.get(req.params.name);
    if (!handler) {
      return {
        content: [{ type: 'text' as const, text: `unknown tool '${req.params.name}'` }],
        isError: true,
      };
    }
    const ctx = { signal: new AbortController().signal } as never;
    try {
      const result = await handler.execute(req.params.arguments ?? {}, ctx);
      // Compact on purpose — single-line JSON, only the contract fields.
      const body = { ok: result.ok, summary: result.summary, data: result.data };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(body) }],
        isError: !result.ok,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, summary: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Handle one MCP-over-HTTP POST. Per-request server + stateless
 * transport (`sessionIdGenerator: undefined`) — the lesson from
 * `packages/pyric-tools/src/serve/bridge-mount.ts`: a shared stateless
 * transport handles `initialize` then 500s on everything after.
 * `enableJsonResponse` keeps responses plain JSON (no dangling SSE
 * stream per request); the Claude Code MCP client accepts both.
 */
export async function handleMcpPost(request: Request): Promise<Response> {
  const handlers = await loadWorkspaceTools();
  const server = buildWorkspaceMcpServer(handlers);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Fire-and-forget: the JSON response is already materialised.
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}

/** GET /api/claude-mcp payload — the lane's preflight target. */
export function mcpHealth(): { ok: true; server: string; version: string; tools: string[] } {
  return {
    ok: true,
    server: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    tools: [...MCP_TOOL_NAMES],
  };
}

// ── workspace snapshot (browser push/pull) ───────────────────────────

export interface WorkspaceFileEntry {
  path: string;
  content: string;
}

export interface WorkspaceSnapshot {
  files: WorkspaceFileEntry[];
}

async function vfsHelpers() {
  installWindowPolyfill();
  const [{ getVFS }, { listAllFiles }, { WORKSPACE_ROOT }, { notifyVfsWrite }] =
    await Promise.all([
      import('~/lib/vfs'),
      import('~/lib/files/file-tree'),
      import('~/lib/store/files'),
      import('~/lib/files/bootstrap'),
    ]);
  return { getVFS, listAllFiles, WORKSPACE_ROOT, notifyVfsWrite };
}

/** Read every file under /workspace on the SERVER workspace. */
export async function snapshotServerWorkspace(): Promise<WorkspaceSnapshot> {
  const { getVFS, listAllFiles, WORKSPACE_ROOT } = await vfsHelpers();
  const vfs = getVFS();
  const paths = await listAllFiles(WORKSPACE_ROOT).catch(() => [] as string[]);
  const files: WorkspaceFileEntry[] = [];
  for (const path of paths) {
    try {
      const raw = await vfs.promises.readFile(path, 'utf8');
      files.push({
        path,
        content: typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
      });
    } catch {
      // Unreadable entry (race with a delete) — skip rather than fail the snapshot.
    }
  }
  return { files };
}

/**
 * Replace the server workspace with the browser's snapshot (turn
 * seeding). Files not in the snapshot are deleted so Claude sees
 * exactly what the user sees; writes go through the VFS + the store
 * mirror (`notifyVfsWrite`) so rules/App reads observe them.
 */
export async function replaceServerWorkspace(snapshot: WorkspaceSnapshot): Promise<void> {
  const { getVFS, listAllFiles, WORKSPACE_ROOT, notifyVfsWrite } = await vfsHelpers();
  const vfs = getVFS();
  const incoming = new Set(snapshot.files.map((f) => f.path));
  const existing = await listAllFiles(WORKSPACE_ROOT).catch(() => [] as string[]);
  for (const path of existing) {
    if (!incoming.has(path)) {
      await vfs.promises.unlink(path).catch(() => {});
    }
  }
  for (const { path, content } of snapshot.files) {
    if (!path.startsWith(`${WORKSPACE_ROOT}/`)) continue; // workspace-only surface
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) await vfs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    await vfs.promises.writeFile(path, content);
    notifyVfsWrite(path, content);
  }
}
