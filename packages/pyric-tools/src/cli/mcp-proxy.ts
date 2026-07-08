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
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ParsedArgs } from './parse-args.js';
import { discoverServe, SCAN_PORTS } from '../serve/discovery.js';

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
