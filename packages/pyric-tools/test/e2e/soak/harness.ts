/**
 * Soak-suite harness: spawn a REAL `pyric dev --ui --bridge --no-open
 * --port 0 --json` serve in a throwaway copy of the fixture, parse the
 * one-line `--json` contract for URLs, and provide the observation
 * helpers the scenarios share:
 *
 *  - `waitFor` — bounded condition polling (never a bare sleep where a
 *    condition exists).
 *  - `health` — the bridge's `/__pyric/health` (`sandboxConnected`).
 *  - `WS_INSTRUMENTATION` — a page init script that wraps
 *    `window.WebSocket` so each tab's bridge `hello` registrations and
 *    close codes are countable from the test (no product code needed:
 *    the bridge client runs in the page, so the page's own socket IS the
 *    observation point for peer-slot churn).
 *  - `McpHttpClient` — a minimal MCP streamable-HTTP client (initialize /
 *    tools-list / tools-call) speaking directly to `/__pyric/mcp`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = join(HERE, '..', '..', '..', 'dist', 'cli', 'index.js');
const FIXTURE_DIR = join(HERE, 'fixture');

// ─── waitFor ────────────────────────────────────────────────────────────────

export async function waitFor<T>(
  label: string,
  condition: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── serve orchestration ────────────────────────────────────────────────────

export interface ServeJson {
  url: string;
  port: number;
  uiUrl: string | null;
  mcpUrl: string | null;
  rulesHash: string | null;
}

export interface SoakServe {
  info: ServeJson;
  /** Temp project dir the serve runs in. */
  dir: string;
  child: ChildProcess;
  /** Everything the serve (and any `--` child) wrote to stderr so far. */
  stderr: () => string;
  /** Full stdout (line 1 is the --json contract; a `--` child's output is
   *  prefixed `[dev] ` on stderr, never here). */
  stdout: () => string;
  stop: () => Promise<void>;
}

/**
 * Copy the fixture into a fresh temp dir (plus any extra files) and start
 * `pyric dev --ui --bridge --no-open --port 0 --json [-- <cmd>]` there.
 * Resolves once the one-line JSON contract arrives on stdout.
 */
export async function startSoakServe(
  opts: { extraFiles?: Record<string, string>; passthrough?: string[]; flags?: string[] } = {},
): Promise<SoakServe> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-bridge-soak-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  for (const [name, content] of Object.entries(opts.extraFiles ?? {})) {
    writeFileSync(join(dir, name), content);
  }

  const args = [
    CLI_PATH,
    'dev',
    '--ui',
    '--bridge',
    '--no-open',
    '--port',
    '0',
    '--json',
    // ALWAYS bundle fresh. Finding from this suite's first run: the serve
    // bundle cache key (serve/bundler.ts cacheKey) hashes the pyric version +
    // the serve/entries sources only — NOT the bridge client / worker client
    // sources the bundle also includes — so a warm ~/.pyric/serve-cache keeps
    // serving a PRE-FIX in-page bridge client after pyric-tools-only changes
    // (observed live: a stale client ignored the standby protocol and bounced
    // the peer slot once per replacement). The suite must test the code as
    // built, so it opts out of the cache.
    '--no-cache',
    ...(opts.flags ?? []),
    ...(opts.passthrough && opts.passthrough.length > 0 ? ['--', ...opts.passthrough] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => (out += c));
  child.stderr!.on('data', (c: string) => (err += c));

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  let info: ServeJson;
  try {
    info = await waitFor<ServeJson>(
      `pyric dev --json line`,
      () => {
        if (child.exitCode !== null) {
          throw new Error(
            `pyric dev exited early (code ${child.exitCode}). stderr:\n${err.slice(-2000)}`,
          );
        }
        const line = out.split('\n').find((l) => l.trim().startsWith('{'));
        if (!line) return null;
        try {
          return JSON.parse(line) as ServeJson;
        } catch {
          return null;
        }
      },
      // First run may build the SDK bundles; later runs hit the cache.
      { timeoutMs: 90_000, intervalMs: 100 },
    );
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(killTimer);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  };

  return { info, dir, child, stderr: () => err, stdout: () => out, stop };
}

// ─── bridge health ──────────────────────────────────────────────────────────

export async function health(serveUrl: string): Promise<{ sandboxConnected: boolean } | null> {
  try {
    const res = await fetch(`${serveUrl.replace(/\/$/, '')}/__pyric/health`);
    if (!res.ok) return null;
    return (await res.json()) as { sandboxConnected: boolean };
  } catch {
    return null;
  }
}

export async function waitForPeer(serveUrl: string, timeoutMs = 20_000): Promise<void> {
  await waitFor(
    `a sandbox peer at ${serveUrl}`,
    async () => (await health(serveUrl))?.sandboxConnected === true,
    { timeoutMs, intervalMs: 200 },
  );
}

// ─── page-side WS observation ───────────────────────────────────────────────

/** Shape of `window.__wsLog` installed by {@link WS_INSTRUMENTATION}. */
export interface PageWsLog {
  /** Total bridge `hello` frames this page has sent (peer registrations). */
  hellos: number;
  /** One record per WebSocket to the bridge sandbox path. */
  sockets: Array<{
    url: string;
    openedAt: number;
    hellos: number;
    hellosAt: number[];
    closeCode: number | null;
    closeAt: number | null;
  }>;
  /** Close codes observed, in order (4001 = replaced → standby). */
  closes: number[];
}

/**
 * Init script wrapping `window.WebSocket`: counts `hello` frames (bridge
 * peer registrations) and records close codes for sockets to
 * `/__pyric/sandbox`. Pure test-side observation — the page's bridge client
 * is untouched, this only watches the frames it already sends.
 */
export const WS_INSTRUMENTATION = `(() => {
  const log = { hellos: 0, sockets: [], closes: [] };
  Object.defineProperty(window, '__wsLog', { value: log });
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      const isBridge = String(url).includes('/__pyric/sandbox');
      const rec = { url: String(url), openedAt: Date.now(), hellos: 0, hellosAt: [], closeCode: null, closeAt: null };
      if (isBridge) log.sockets.push(rec);
      this.addEventListener('close', (e) => {
        if (isBridge) { rec.closeCode = e.code; rec.closeAt = Date.now(); log.closes.push(e.code); }
      });
      const nativeSend = this.send.bind(this);
      this.send = (data) => {
        if (isBridge && typeof data === 'string' && data.includes('"type":"hello"')) {
          rec.hellos += 1;
          rec.hellosAt.push(Date.now());
          log.hellos += 1;
        }
        return nativeSend(data);
      };
    }
  };
})();`;

// ─── minimal MCP streamable-HTTP client ─────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Speaks MCP over the streamable HTTP endpoint directly (initialize →
 * notifications/initialized → tools/list → tools/call), carrying the
 * `Mcp-Session-Id` the stateful transport mints on initialize.
 */
export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private readonly mcpUrl: string) {}

  private async post(body: Record<string, unknown>): Promise<{ msg: JsonRpcResponse | null; status: number }> {
    const res = await fetch(this.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const contentType = res.headers.get('content-type') ?? '';
    let msg: JsonRpcResponse | null = null;
    if (contentType.includes('text/event-stream')) {
      // A POST-scoped SSE stream: the transport writes the one response and
      // closes, so reading to end is bounded.
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
          if (parsed.id === body.id) msg = parsed;
        } catch {
          // non-JSON SSE line — skip
        }
      }
    } else if (contentType.includes('application/json')) {
      msg = (await res.json()) as JsonRpcResponse;
    }
    return { msg, status: res.status };
  }

  async initialize(): Promise<JsonRpcResponse> {
    const { msg, status } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'bridge-soak', version: '0.0.0' },
      },
    });
    if (!msg || msg.error) {
      throw new Error(`MCP initialize failed (status ${status}): ${JSON.stringify(msg?.error)}`);
    }
    // Per spec, follow with the initialized notification (202, no body).
    await fetch(this.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    return msg;
  }

  async toolsList(): Promise<string[]> {
    const { msg, status } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list',
      params: {},
    });
    if (!msg || msg.error) {
      throw new Error(`MCP tools/list failed (status ${status}): ${JSON.stringify(msg?.error)}`);
    }
    const tools = (msg.result as { tools: Array<{ name: string }> }).tools;
    return tools.map((t) => t.name);
  }

  /** Call a tool; returns the parsed bridge result from the text content. */
  async toolCall(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }> {
    const { msg, status } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (!msg || msg.error) {
      throw new Error(`MCP tools/call ${name} failed (status ${status}): ${JSON.stringify(msg?.error)}`);
    }
    const content = (msg.result as { content: Array<{ type: string; text: string }> }).content;
    const text = content.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error(`MCP tools/call ${name}: no text content in result`);
    return JSON.parse(text) as { ok: boolean; summary: string; data?: unknown };
  }
}
