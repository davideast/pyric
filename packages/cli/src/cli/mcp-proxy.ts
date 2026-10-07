/**
 * `pyric mcp-proxy` — a stdio MCP server that relays to a RUNNING
 * the HTTP MCP endpoint from `pyric sandbox --bridge`.
 *
 * Why this exists: the agent plugin declares one static stdio command, while
 * serve's endpoint is `http://localhost:<PORT>/__pyric/mcp` with a runtime
 * port (scan-forward / AirPlay). The proxy discovers the live serve and
 * forwards the protocol. No per-client MCP setup, no fixed port.
 * (design rationale)
 *
 * Relay is at the TRANSPORT level via the MCP SDK's own transports — we do
 * NOT re-implement JSON-RPC/SSE/session framing. `StdioServerTransport`
 * talks to the MCP client; `StreamableHTTPClientTransport` talks to serve; each
 * transport's `onmessage` is piped to the other's `send`.
 *
 * Discovery checks and request deadlines sit on top of that pipe:
 *
 *   IDENTITY — the discovery pointer records the bridge's `instanceId`; the
 *     proxy accepts a server only if its `/health` reports the SAME id. Two
 *     sandboxes can collide on one port across loopback families (IPv4 `*:P`
 *     + IPv6 `[::1]:P`); without this, the proxy locks onto whichever family
 *     answers first while the browser is on the other — split-brain.
 *     Each HTTP request carries that identity so replacement after discovery
 *     is refused, including before the first MCP session exists.
 *   PROJECT — each request carries the canonical directory containing the
 *     selected pointer. The endpoint verifies it before creating or resuming
 *     an MCP session. This checks discovery context, not client authentication.
 *   TIMEOUT — every relayed request is failed with a JSON-RPC error after
 *     REQUEST_TIMEOUT_MS instead of hanging the agent forever (a killed
 *     server can leave a half-open keep-alive socket that never FINs). A
 *     `settled` set swallows a late real response so the client never sees a
 *     duplicate after the timeout already failed the call.
 *
 * RECOVERY — when a send to serve fails, that call is failed with an
 * unknown-outcome error and never replayed. The next call rediscovers through
 * the pointer and starts a new HTTP session, initialized with the client's own
 * `initialize` request. Only a sandbox of the project the session attached to
 * is accepted (a restart carries a new instance identity); a pointer-less scan
 * hit or another project's sandbox is refused with a message saying so.
 *
 * `--in-process` opts out of all of this: it forces the in-process sandbox and
 * never looks for a running bridge. The selected project must still have no
 * other in-process sandbox; a running sandbox host owns different state files
 * and does not conflict. `--surface <id>` (or `PYRIC_TOOL_SURFACE`, with the flag
 * winning) selects the tool surface the in-process server renders, and
 * `--project-dir <dir>` (or `PYRIC_PROJECT_DIR`, same precedence) names the
 * directory that in-process server reads its rules files and `.pyric/state` from.
 * Absent both, the project directory is the process cwd. `--allow-production`
 * (or `PYRIC_ALLOW_PRODUCTION` set to `1` or `true`) enables `production`
 * methods on the in-process server; absent, a `production` method is still
 * listed, under a heading that says it is disabled, and every call to one is
 * refused (ADR-0014 Decision 5).
 *
 * Discovery: the `.pyric/serve.json` pointer serve writes in the project cwd
 * selects a host; its contents alone do not prove project ownership. The
 * endpoint verifies the pointer's directory. The health probe across the scan window
 * still runs, but a server it finds is reported and not attached to: it may be
 * another project's sandbox on the same machine. Degrades LEGIBLY: if no serve
 * is found, or the pointed server's identity can't be matched, we report it
 * and never hang.
 */
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ParsedArgs } from './parse-args.js';
import { allowProductionFrom } from '../bridge/surface/method-effects.js';
import { discoverServe, SCAN_PORTS, type Discovered } from '../serve/discovery.js';
import { MCP_PROJECT_HEADER, MCP_INSTANCE_HEADER } from '../serve/mcp-project.js';

// Discovery (pointer + identity-pinned health probing) lives in
// `serve/discovery.ts` — shared with the Node remote-sandbox client
// (`remote/index.ts`). Re-exported here for existing consumers.
export { discoverServe } from '../serve/discovery.js';

/** A relayed request with no response within this window is failed with a
 *  JSON-RPC error rather than hanging forever. Sits just above the bridge's
 *  own 30s `callTimeoutMs` so a legitimately-slow tool still completes. */
const REQUEST_TIMEOUT_MS = 35_000;
/** JSON-RPC error code for proxy-synthesized failures (server-defined range). */
const PROXY_ERROR_CODE = -32001;
/** Transport failure cannot establish whether a sent mutation committed. */
const UNKNOWN_REQUEST_OUTCOME = 'The request outcome is unknown; a write may have committed. ' +
  'Check the host state before issuing another write.';

// ── JSON-RPC shape helpers (relay-level; no SDK runtime import) ──────────────
function msgId(m: JSONRPCMessage): string | number | null {
  const hasIdentifier = 'id' in m;
  if (hasIdentifier) return m.id ?? null;
  return null;
}
/** A request expects a response (has both `id` and `method`). */
function isRequest(m: JSONRPCMessage): m is JSONRPCRequest {
  return 'method' in m && msgId(m) != null;
}
/** A response/error answers a request (has `id`, no `method`). */
function isResponse(m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number } {
  return !('method' in m) && msgId(m) != null;
}

/** Injectable seams for testing the attach-vs-in-process selection. */
export interface McpProxyDeps {
  discover?: typeof discoverServe;
  inProcess?: (cwd: string, options: InProcessSelection) => Promise<number>;
  /** Environment the surface fallback is read from. Defaults to the process. */
  env?: NodeJS.ProcessEnv;
  /** The client-facing transport. Defaults to this process's stdio. */
  stdio?: StdioSide;
}

/** The client-facing half of the relay: the subset of a server transport it uses. */
export interface StdioSide {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
}

/** How the in-process server is started once this command has selected it. */
export interface InProcessSelection {
  /** Tool-surface variant id, or undefined for the default surface. */
  surface?: string;
  /** Project directory, or undefined to use the cwd the server is started in. */
  projectDir?: string;
  /** Mount `production` methods (ADR-0014 Decision 5). Defaults to false. */
  allowProduction?: boolean;
  /** Suppress following a live Node host (--in-process flag). */
  inProcessOnly?: boolean;
}

/** Environment variable naming the tool surface when `--surface` is absent. */
export const TOOL_SURFACE_ENV_KEY = 'PYRIC_TOOL_SURFACE';

/** Environment variable naming the project directory when `--project-dir` is absent. */
export const PROJECT_DIR_ENV_KEY = 'PYRIC_PROJECT_DIR';

/** `--in-process` forces the in-process sandbox and skips discovery entirely. */
function forcesInProcessSandbox(parsed: ParsedArgs): boolean {
  return parsed.flags?.get('in-process') === true;
}

/** `--attach` insists on a running serve and fails rather than owning a sandbox. */
function requiresRunningServe(parsed: ParsedArgs): boolean {
  return parsed.flags?.get('attach') === true;
}

/** Exit code for a command line that asks for two hosts at once, or for one that is not there. */
const USAGE_ERROR = 1;

/**
 * The tool surface to serve. The flag wins over the environment; absent both,
 * the server serves its default surface.
 */
function selectToolSurface(parsed: ParsedArgs, env: NodeJS.ProcessEnv): string | undefined {
  return selectFlagOrEnv(parsed, 'surface', env, TOOL_SURFACE_ENV_KEY);
}

/**
 * The project directory the in-process server reads and writes. The flag wins
 * over the environment; absent both, the server uses the cwd it was started in.
 */
function selectProjectDir(parsed: ParsedArgs, env: NodeJS.ProcessEnv): string | undefined {
  return selectFlagOrEnv(parsed, 'project-dir', env, PROJECT_DIR_ENV_KEY);
}

/** A setting that comes from a flag, else the environment, else nowhere. */
function selectFlagOrEnv(
  parsed: ParsedArgs,
  flag: string,
  env: NodeJS.ProcessEnv,
  envKey: string,
): string | undefined {
  const flagValue = parsed.flags?.get(flag);
  if (typeof flagValue === 'string' && flagValue !== '') return flagValue;
  const envValue = env[envKey];
  if (envValue !== undefined && envValue !== '') return envValue;
  return undefined;
}

/**
 * Whether `production` methods run (ADR-0014 Decision 5), read from this
 * command's flags. The rule itself, including which environment values count,
 * lives on the surface in `method-effects.ts`, so the MCP path and `pyric
 * <tool> <method>` cannot drift apart on what opting in means.
 */
export function selectAllowProduction(parsed: ParsedArgs, env: NodeJS.ProcessEnv): boolean {
  return allowProductionFrom(parsed.flags?.get('allow-production') === true, env);
}

export async function runMcpProxy(
  parsed: ParsedArgs,
  cwd: string = process.cwd(),
  deps: McpProxyDeps = {},
): Promise<number> {
  // NB: stdout is the MCP stdio channel — diagnostics go to stderr ONLY.
  const log = (m: string): void => {
    process.stderr.write(`[pyric mcp-proxy] ${m}\n`);
  };

  const forcesInProcess = forcesInProcessSandbox(parsed);
  const env = deps.env ?? process.env;
  const selection: InProcessSelection = {
    surface: selectToolSurface(parsed, env),
    projectDir: selectProjectDir(parsed, env),
    allowProduction: selectAllowProduction(parsed, env),
    inProcessOnly: forcesInProcess,
  };
  const runInProcess =
    deps.inProcess ??
    ((c: string, o: InProcessSelection) =>
      import('../bridge/server/in-process.js').then((m) => m.runInProcessMcp(c, o)));
  const hasConflictingHosts = forcesInProcess && requiresRunningServe(parsed);
  if (hasConflictingHosts) {
    log('--attach and --in-process name different hosts for the sandbox; pass one of them.');
    return USAGE_ERROR;
  }

  if (forcesInProcess) {
    // `--in-process` is the evaluation and scripting path: one sandbox per
    // process, with no dependence on whatever else is running on this machine.
    // Discovery is not consulted at all, so a running bridge cannot be attached.
    log('starting an in-process sandbox (--in-process); not looking for a running sandbox');
    return await runInProcess(cwd, selection);
  }

  const discovered = await (deps.discover ?? discoverServe)(cwd, log);
  // Only a pointer selects a host. Its directory is then verified by the MCP
  // endpoint; the pointer's contents alone do not establish project ownership.
  const hasPointer = discovered !== null && discovered.source.startsWith('pointer');
  const found = hasPointer ? discovered : null;
  const foundOnlyByScan = discovered !== null && found === null;
  if (foundOnlyByScan) {
    log(
      `a sandbox server is answering at ${discovered.base} (${discovered.source}), but no ` +
        '.pyric/serve.json in this project names it, so it is not attached to. Start `pyric serve` ' +
        'from this project to write the pointer, or ignore the server if it belongs to another project.',
    );
  }
  const hasNoHost = found === null;
  const requiresMissingHost = hasNoHost && requiresRunningServe(parsed);
  if (requiresMissingHost) {
    log(
      'no running `pyric serve` or `pyric sandbox --bridge` found for this project (looked for ' +
        `.pyric/serve.json and ports ${SCAN_PORTS.join(', ')}), and --attach asks for one. ` +
        'Start it first, or drop --attach to own an in-process sandbox instead.',
    );
    return USAGE_ERROR;
  }
  if (hasNoHost) {
    // Hybrid mode (design rationale): no dev server to attach to, so host the
    // sandbox IN this process. Zero setup, no browser tab required. A running
    // `pyric sandbox --bridge` upgrades to the shared session on reconnect.
    log(
      'no running `pyric sandbox --bridge` found (looked for .pyric/serve.json and ports ' +
        `${SCAN_PORTS.join(', ')}); starting an in-process sandbox (zero-setup).\n` +
        '  Data persists to .pyric/state/in-process.json. For a shared-live Studio\n' +
        '  session, start `pyric sandbox --bridge` before connecting the agent (a sandbox host\n' +
        '  started mid-session keeps its own state; this session stays on the in-process file).',
    );
    return await runInProcess(cwd, selection);
  }
  log(`relaying stdio ↔ ${found.mcpUrl} (via ${found.source}; attached to a running serve)`);

  // Late, dynamic imports: the SDK is heavy and only needed here.
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );

  type HttpSide = InstanceType<typeof StreamableHTTPClientTransport>;
  const buildTransport = (target: Discovered): HttpSide => {
    const requestHeaders: Record<string, string> = {};
    const targetProjectDir = target.pointerProjectDir;
    const hasPointerProject = targetProjectDir !== undefined;
    if (hasPointerProject) requestHeaders[MCP_PROJECT_HEADER] = encodeURIComponent(targetProjectDir);
    const targetInstanceId = target.instanceId;
    const hasInstanceIdentity = targetInstanceId !== null;
    if (hasInstanceIdentity) requestHeaders[MCP_INSTANCE_HEADER] = targetInstanceId;
    return new StreamableHTTPClientTransport(new URL(target.mcpUrl), {
      requestInit: { headers: requestHeaders },
    });
  };
  /** The project this session attached to. Recovery may move to a restarted
   *  sandbox of the same project and never to another one. */
  const attachedProjectDir = found.pointerProjectDir;
  let http = buildTransport(found);
  const stdio: StdioSide = deps.stdio ?? new StdioServerTransport();

  return await new Promise<number>((resolveExit) => {
    let closing = false;
    /** In-flight relayed requests → their timeout timers. */
    const pending = new Map<string | number, ReturnType<typeof setTimeout>>();
    /** Ids already failed by a timeout — used to SWALLOW a late real response so
     *  Claude Code never sees a duplicate (error frame, then result frame). */
    const settled = new Set<string | number>();
    /** The client's `initialize` request, kept so a replacement HTTP session can
     *  be initialized the same way. */
    let initializeRequest: JSONRPCRequest | null = null;
    /** Set once a send failed: the HTTP session is not trusted until replaced. */
    let stale = false;
    /** The replacement in progress, shared by every call that arrives meanwhile.
     *  Resolves to null on success, else the reason the call cannot be sent. */
    let recovery: Promise<string | null> | null = null;
    /** Resolvers for the proxy's own requests (the re-initialize), by id. */
    const proxyRequests = new Map<string, () => void>();

    const sendStdio = (m: JSONRPCMessage): void => {
      void stdio.send(m).catch((e) => log(`→client send failed: ${e}`));
    };
    const failRequest = (id: string | number, message: string): void => {
      const timer = pending.get(id);
      const hasTimer = timer !== undefined;
      if (hasTimer) clearTimeout(timer);
      pending.delete(id);
      settled.add(id);
      sendStdio({ jsonrpc: '2.0', id, error: { code: PROXY_ERROR_CODE, message } });
    };

    const shutdown = (code: number): void => {
      if (closing) return; // re-entrancy guard: close() fires onclose → shutdown → …
      closing = true;
      process.stdin.off('end', onStdinEnd);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      void Promise.allSettled([stdio.close(), http.close()]).then(() => resolveExit(code));
    };

    // ── relay: http (serve) → stdio (Claude Code) ──
    const bindHttp = (transport: HttpSide): void => {
      const isCurrent = (): boolean => transport === http;
      transport.onmessage = (msg) => {
        if (!isCurrent()) return;
        const answersRequest = isResponse(msg);
        if (answersRequest) {
          const id = msg.id;
          const proxyRequest = proxyRequests.get(String(id));
          const isProxyRequest = typeof id === 'string' && proxyRequest !== undefined;
          if (isProxyRequest) {
            proxyRequests.delete(id);
            proxyRequest();
            return;
          }
          const timer = pending.get(id);
          const hasTimer = timer !== undefined;
          if (hasTimer) {
            clearTimeout(timer);
            pending.delete(id);
          } else {
            const alreadySettled = settled.has(id);
            if (alreadySettled) {
              // A response that lost the race to its timeout — already failed to the
              // client. Swallow it so the client never sees a duplicate frame.
              settled.delete(id);
              return;
            }
          }
        }
        sendStdio(msg);
      };
      transport.onerror = (e) => {
        if (!isCurrent()) return;
        const isError = e instanceof Error;
        log(`serve transport error: ${isError ? e.message : String(e)}`);
      };
      transport.onclose = () => {
        if (!isCurrent()) return;
        log('serve closed the connection (did serve stop?)');
        shutdown(0);
      };
    };

    /**
     * Replace the HTTP session after a send failure. The replacement must be a
     * sandbox of the project this session attached to: a different project (a
     * stranger on the old port, a scan hit) is refused, while a restart of the
     * same project, which carries a new instance identity, is accepted. The new
     * session is initialized with the client's own `initialize` request; no
     * interrupted tool call is replayed.
     */
    const replaceSession = async (): Promise<string | null> => {
      const target = await (deps.discover ?? discoverServe)(cwd, log);
      const isPointerTarget = target !== null && target.source.startsWith('pointer');
      if (!isPointerTarget) {
        return (
          'no running sandbox for this project is reachable (looked for the .pyric/serve.json ' +
          'pointer). Start the dev server for this project; the next call reattaches.'
        );
      }
      const isSameProject = target.pointerProjectDir === attachedProjectDir;
      if (!isSameProject) {
        return (
          `the sandbox now answering at ${target.base} is not the sandbox this session attached ` +
          'to (a different project). Not attaching to it.'
        );
      }
      const replacement = buildTransport(target);
      const previous = http;
      http = replacement;
      bindHttp(replacement);
      void previous.close().catch(() => {});
      try {
        await replacement.start();
        const clientInitialize = initializeRequest;
        const hasInitialize = clientInitialize !== null;
        if (hasInitialize) {
          const proxyId = `pyric-mcp-proxy-init-${Date.now()}`;
          const answered = new Promise<void>((resolve) => proxyRequests.set(proxyId, resolve));
          const reinitialize: JSONRPCRequest = { ...clientInitialize, id: proxyId };
          await replacement.send(reinitialize);
          await answered;
          await replacement.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        }
      } catch (e) {
        return `could not reconnect to ${target.base}: ${e instanceof Error ? e.message : String(e)}`;
      }
      log(`reattached to ${target.mcpUrl} (via ${target.source}) after the previous connection failed`);
      return null;
    };

    /** Resolves to null when the HTTP session is usable, else why it is not. */
    const ensureSession = async (): Promise<string | null> => {
      if (!stale) return null;
      recovery ??= replaceSession().finally(() => {
        recovery = null;
      });
      const reason = await recovery;
      const recovered = reason === null;
      if (recovered) stale = false;
      return reason;
    };

    const dispatch = async (msg: JSONRPCMessage): Promise<void> => {
      const id = msgId(msg);
      const reason = await ensureSession();
      const unavailable = reason !== null;
      if (unavailable) {
        log(`→serve not sent: ${reason}`);
        const hasPendingRequest = id !== null && pending.has(id);
        if (hasPendingRequest) {
          failRequest(id, `pyric mcp-proxy: ${reason} The request was not sent.`);
        }
        return;
      }
      try {
        await http.send(msg);
      } catch (e) {
        log(`→serve send failed: ${e}`);
        stale = true;
        const hasPendingRequest = id !== null && pending.has(id);
        if (hasPendingRequest) {
          failRequest(id, 'pyric mcp-proxy: no acknowledgment from serve. ' + UNKNOWN_REQUEST_OUTCOME);
        }
      }
    };

    // ── relay: stdio (Claude Code) → http (serve) ──
    stdio.onmessage = (msg) => {
      const startsRequest = isRequest(msg);
      if (startsRequest) {
        const id = msg.id;
        const isInitialize = msg.method === 'initialize';
        if (isInitialize) initializeRequest = msg;
        const timer = setTimeout(() => {
          failRequest(
            id,
            `pyric mcp-proxy: no response from serve within ${REQUEST_TIMEOUT_MS / 1000}s. ` +
              UNKNOWN_REQUEST_OUTCOME,
          );
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, timer);
      }
      void dispatch(msg);
    };

    bindHttp(http);
    stdio.onclose = () => shutdown(0); // Claude Code disconnected
    const onStdinEnd = (): void => shutdown(0);
    process.stdin.once('end', onStdinEnd);

    process.once('SIGINT', () => shutdown(0));
    process.once('SIGTERM', () => shutdown(0));

    Promise.all([http.start(), stdio.start()]).catch((e) => {
      const isError = e instanceof Error;
      log(`failed to start relay: ${isError ? e.message : String(e)}`);
      shutdown(1);
    });
  });
}
