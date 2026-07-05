/**
 * `pyric mcp-proxy` — a stdio MCP server that relays to a RUNNING
 * `pyric serve --bridge`'s HTTP MCP endpoint.
 *
 * Why this exists: a Claude Code plugin can only declare a STATIC MCP URL in
 * `.mcp.json`, but serve's endpoint is `http://localhost:<PORT>/__pyric/mcp`
 * with a runtime port (scan-forward / AirPlay). So the plugin declares a
 * STDIO server that runs this proxy; the proxy discovers the live serve and
 * forwards the protocol. No manual `claude mcp add`, no fixed port.
 * (design rationale)
 *
 * Relay is at the TRANSPORT level via the MCP SDK's own transports — we do
 * NOT re-implement JSON-RPC/SSE/session framing. `StdioServerTransport`
 * talks to Claude Code; `StreamableHTTPClientTransport` talks to serve; each
 * transport's `onmessage` is piped to the other's `send`.
 *
 * Two hardening layers sit on top of that pipe:
 *
 *   IDENTITY — the discovery pointer records the bridge's `instanceId`; the
 *     proxy accepts a server only if its `/health` reports the SAME id. Two
 *     sandboxes can collide on one port across loopback families (IPv4 `*:P`
 *     + IPv6 `[::1]:P`); without this, the proxy locks onto whichever family
 *     answers first while the browser is on the other — split-brain.
 *   TIMEOUT — every relayed request is failed with a JSON-RPC error after
 *     REQUEST_TIMEOUT_MS instead of hanging Claude Code forever (a killed
 *     server can leave a half-open keep-alive socket that never FINs). A
 *     `settled` set swallows a late real response so the client never sees a
 *     duplicate after the timeout already failed the call.
 *
 * (Auto-reconnect on serve restart is deliberately NOT here — it needs a
 * live-restart test harness; the timeout makes a stale connection fail fast,
 * and the user restarts the MCP connection.)
 *
 * Discovery preference: the `.pyric/serve.json` pointer serve writes in the
 * project cwd (exact + project-correct), then a health probe across the scan
 * window as a fallback. Degrades LEGIBLY: if no serve is found, or the pointed
 * server's identity can't be matched, we report it — never a silent hang.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ParsedArgs } from './parse-args.js';

/** Ports probed when the pointer is absent — serve's default scan window PLUS
 *  the vite-plugin default (5174), which the old 5000-5004 window missed (so a
 *  vite-only project was never found by scan). The standalone `pyric bridge`
 *  serves `/health` (not `/__pyric/health`) and writes no pointer, so it is
 *  registered directly via `claude mcp add`, not discovered here. */
const SCAN_PORTS = [5000, 5001, 5002, 5003, 5004, 5174];
const POINTER = join('.pyric', 'serve.json');

/** A relayed request with no response within this window is failed with a
 *  JSON-RPC error rather than hanging forever. Sits just above the bridge's
 *  own 30s `callTimeoutMs` so a legitimately-slow tool still completes. */
const REQUEST_TIMEOUT_MS = 35_000;
/** JSON-RPC error code for proxy-synthesized failures (server-defined range). */
const PROXY_ERROR_CODE = -32001;

interface HealthLite {
  mode?: string;
  instanceId?: string;
}
interface Discovered {
  mcpUrl: string;
  url: string;
  /** `http://<family>:<port>` the server actually answered on. */
  base: string;
  /** Identity pinned at discovery. Null only when talking to an older server
   *  that predates the instanceId field (matching is then skipped). */
  instanceId: string | null;
  source: string;
}

/**
 * Probe BOTH loopback families on a port and return the base that answers.
 *
 * Hostname-based URLs are a trap here: serve writes `http://localhost:...`
 * for humans (browsers dual-stack fine), but `localhost` resolution differs
 * by runtime — node/undici prefers IPv6 `::1`, and a serve under one runtime
 * may bind `127.0.0.1`-only while under another binds `::1`-only. So the
 * proxy never trusts the hostname: it takes the PORT and tries explicit
 * `127.0.0.1` and `[::1]`, using whichever the server is actually on.
 */
function basesForPort(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}

async function probeHealth(base: string): Promise<HealthLite | null> {
  try {
    const res = await fetch(`${base}/__pyric/health`, { signal: AbortSignal.timeout(1000) });
    if (res.status !== 200) return null;
    const body = (await res.json()) as HealthLite;
    return body.mode === 'sandbox' ? body : null;
  } catch {
    return null;
  }
}

/**
 * First loopback base on `port` whose health reports a sandbox bridge. With an
 * `expectedInstanceId`, returns ONLY a family whose health identity matches —
 * so when two sandboxes collide on one port across families, the proxy locks
 * onto the one the pointer names, not merely the first to answer. (An older
 * server with no `instanceId` field can't be identity-checked; matching is
 * skipped in that case so the pointer still resolves.)
 */
async function healthyBase(
  port: number,
  expectedInstanceId?: string | null,
): Promise<{ base: string; instanceId: string | null } | null> {
  for (const base of basesForPort(port)) {
    const health = await probeHealth(base);
    if (!health) continue;
    const id = health.instanceId ?? null;
    // Healthy but the WRONG server (the cross-family squatter): skip, try next.
    if (expectedInstanceId && id !== expectedInstanceId) continue;
    return { base, instanceId: id };
  }
  return null;
}

/** Best-effort port extraction from a pointer url/mcpUrl. */
function portOf(u: string | undefined): number | null {
  const m = u?.match(/:(\d{2,5})(?:\/|$)/);
  return m ? Number(m[1]) : null;
}

/** Find the running serve: pointer first (in `cwd`), then a port scan. The
 *  pointer gives the PORT and (when present) the identity; the family is
 *  resolved by probing, so the returned base always uses the address the
 *  server is actually reachable on. */
export async function discoverServe(
  cwd: string,
  log: (m: string) => void = () => {},
  // Injectable so discovery can be tested hermetically — the default scan probes
  // real localhost ports, which a test environment can't guarantee are free.
  scanPorts: number[] = SCAN_PORTS,
): Promise<Discovered | null> {
  const pointerPath = join(cwd, POINTER);
  if (existsSync(pointerPath)) {
    try {
      const p = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        url?: string;
        mcpUrl?: string;
        port?: number;
        instanceId?: string;
      };
      const port = p.port ?? portOf(p.mcpUrl) ?? portOf(p.url);
      if (port) {
        const expectedId = typeof p.instanceId === 'string' && p.instanceId ? p.instanceId : null;
        const hit = await healthyBase(port, expectedId);
        if (hit) {
          return {
            mcpUrl: `${hit.base}/__pyric/mcp`,
            url: hit.base,
            base: hit.base,
            instanceId: hit.instanceId,
            source: `pointer ${POINTER}`,
          };
        }
        // The pointer named a specific identity we could NOT find on its port:
        // a different sandbox may be squatting it (cross-family collision) or
        // the server stopped. Do NOT scan into a possibly-wrong server — that
        // split-brain is exactly what this identity check prevents. Fail legibly.
        if (expectedId) {
          log(
            `pointer ${POINTER} names a server (instanceId ${expectedId.slice(0, 8)}…) ` +
              `that isn't answering on port ${port} — another sandbox may be squatting the ` +
              `port on the other loopback family, or the server stopped. Not falling back to ` +
              `a blind port scan (it could hit the wrong sandbox). Restart your dev server, ` +
              `and open http://127.0.0.1:${port} (NOT localhost) so a single family is used.`,
          );
          return null;
        }
      }
    } catch {
      /* stale/corrupt pointer — fall through to scan */
    }
  }
  for (const port of scanPorts) {
    const hit = await healthyBase(port);
    if (hit) {
      return {
        mcpUrl: `${hit.base}/__pyric/mcp`,
        url: hit.base,
        base: hit.base,
        instanceId: hit.instanceId,
        source: `port scan (:${port})`,
      };
    }
  }
  return null;
}

// ── JSON-RPC shape helpers (relay-level; no SDK runtime import) ──────────────
function msgId(m: JSONRPCMessage): string | number | null {
  return 'id' in m && (m as { id?: unknown }).id != null ? (m as { id: string | number }).id : null;
}
/** A request expects a response (has both `id` and `method`). */
function isRequest(m: JSONRPCMessage): boolean {
  return 'method' in m && msgId(m) != null;
}
/** A response/error answers a request (has `id`, no `method`). */
function isResponse(m: JSONRPCMessage): boolean {
  return !('method' in m) && msgId(m) != null;
}

/** Injectable seams for testing the attach-vs-headless selection. */
export interface McpProxyDeps {
  discover?: typeof discoverServe;
  headless?: (cwd: string) => Promise<number>;
}

export async function runMcpProxy(
  _parsed: ParsedArgs,
  cwd: string = process.cwd(),
  deps: McpProxyDeps = {},
): Promise<number> {
  // NB: stdout is the MCP stdio channel — diagnostics go to stderr ONLY.
  const log = (m: string): void => {
    process.stderr.write(`[pyric mcp-proxy] ${m}\n`);
  };

  const found = await (deps.discover ?? discoverServe)(cwd, log);
  if (!found) {
    // Hybrid mode (design rationale): no serve to attach to, so host the
    // sandbox IN this process. Zero setup, no browser tab required. A running
    // `pyric serve --bridge` upgrades to the shared-live experience on reconnect.
    log(
      'no running `pyric serve --bridge` found (looked for .pyric/serve.json and ports ' +
        `${SCAN_PORTS.join(', ')}); starting a headless in-process sandbox (zero-setup).\n` +
        '  Data persists to .pyric/state/headless.json. For a shared-live Studio\n' +
        '  session, start `pyric serve --bridge` BEFORE connecting the agent (a serve\n' +
        '  started mid-session does not yet adopt this headless data).',
    );
    const headless =
      deps.headless ??
      ((c: string) => import('../bridge/server/headless.js').then((m) => m.runHeadlessMcp(c)));
    return await headless(cwd);
  }
  log(`relaying stdio ↔ ${found.mcpUrl} (via ${found.source}; attached to a running serve)`);

  // Late, dynamic imports: the SDK is heavy and only needed here.
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );

  const http = new StreamableHTTPClientTransport(new URL(found.mcpUrl));
  const stdio = new StdioServerTransport();

  return await new Promise<number>((resolveExit) => {
    let closing = false;
    /** In-flight relayed requests → their timeout timers. */
    const pending = new Map<string | number, ReturnType<typeof setTimeout>>();
    /** Ids already failed by a timeout — used to SWALLOW a late real response so
     *  Claude Code never sees a duplicate (error frame, then result frame). */
    const settled = new Set<string | number>();

    const sendStdio = (m: JSONRPCMessage): void => {
      void stdio.send(m).catch((e) => log(`→client send failed: ${e}`));
    };
    const failRequest = (id: string | number, message: string): void => {
      const timer = pending.get(id);
      if (timer) clearTimeout(timer);
      pending.delete(id);
      settled.add(id);
      sendStdio({ jsonrpc: '2.0', id, error: { code: PROXY_ERROR_CODE, message } } as JSONRPCMessage);
    };

    const shutdown = (code: number): void => {
      if (closing) return; // re-entrancy guard: close() fires onclose → shutdown → …
      closing = true;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      void Promise.allSettled([stdio.close(), http.close()]).then(() => resolveExit(code));
    };

    // ── relay: stdio (Claude Code) → http (serve) ──
    stdio.onmessage = (msg) => {
      if (isRequest(msg)) {
        const id = msgId(msg)!;
        const timer = setTimeout(() => {
          failRequest(
            id,
            `pyric mcp-proxy: no response from serve within ${REQUEST_TIMEOUT_MS / 1000}s ` +
              `(the server may have stopped, or no browser tab is connected). ` +
              `Reopen the dev URL and retry.`,
          );
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, timer);
      }
      void http.send(msg).catch((e) => {
        log(`→serve send failed: ${e}`);
        const id = msgId(msg);
        if (id != null && pending.has(id)) failRequest(id, 'pyric mcp-proxy: failed to reach serve — retry.');
      });
    };

    // ── relay: http (serve) → stdio (Claude Code) ──
    http.onmessage = (msg) => {
      if (isResponse(msg)) {
        const id = msgId(msg)!;
        const timer = pending.get(id);
        if (timer) {
          clearTimeout(timer);
          pending.delete(id);
        } else if (settled.has(id)) {
          // A response that lost the race to its timeout — already failed to the
          // client. Swallow it so the client never sees a duplicate frame.
          settled.delete(id);
          return;
        }
      }
      sendStdio(msg);
    };

    http.onerror = (e) => log(`serve transport error: ${e instanceof Error ? e.message : String(e)}`);
    http.onclose = () => {
      log('serve closed the connection (did serve stop?)');
      shutdown(0);
    };
    stdio.onclose = () => shutdown(0); // Claude Code disconnected

    process.once('SIGINT', () => shutdown(0));
    process.once('SIGTERM', () => shutdown(0));

    Promise.all([http.start(), stdio.start()]).catch((e) => {
      log(`failed to start relay: ${e instanceof Error ? e.message : String(e)}`);
      shutdown(1);
    });
  });
}
