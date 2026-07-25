/**
 * Discovery of a RUNNING `pyric dev --bridge` — shared by the stdio MCP
 * proxy (`cli/mcp-proxy.ts`) and the Node remote-sandbox client
 * (`remote/index.ts`). Extracted here so both speak the SAME pointer +
 * identity-pinning rules instead of drifting copies.
 *
 * Strategy: the `.pyric/serve.json` pointer serve writes in the project cwd
 * (exact + project-correct) first, then a health probe across the scan
 * window as a fallback. Degrades LEGIBLY: if no serve is found, or the
 * pointed server's identity can't be matched, callers get `null` (plus a
 * `log` diagnostic) — never a silent wrong-server hit.
 *
 * IDENTITY — the discovery pointer records the bridge's `instanceId`; a
 * server is accepted only if its `/__pyric/health` reports the SAME id. Two
 * sandboxes can collide on one port across loopback families (IPv4 `*:P` +
 * `[::1]:P`); without this, a client locks onto whichever family answers
 * first while the browser is on the other — split-brain.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Ports probed when the pointer is absent — serve's default scan window PLUS
 *  the standard Vite dev ports (5173-5177), which the plain 3473+ window would miss
 *  (so a vite-only or monorepo split-directory project is reliably found by scan).
 *  The standalone `pyric bridge` serves `/health` (not `/__pyric/health`) and
 *  writes no pointer, so it is registered directly via `claude mcp add`, not discovered here. */
export const SCAN_PORTS = [3473, 3474, 3475, 3476, 3477, 5173, 5174, 5175, 5176, 5177];
export const POINTER = join('.pyric', 'serve.json');

function candidatePointerPaths(startDir: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const subdirs = ['', 'web', 'frontend', 'client', 'app', 'ui', 'www'];
  let current = resolve(startDir);
  while (true) {
    for (const sub of subdirs) {
      const p = sub ? join(current, sub, POINTER) : join(current, POINTER);
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

export interface HealthLite {
  mode?: string;
  instanceId?: string;
  /** Whether a browser tab is currently connected as the sandbox peer. */
  sandboxConnected?: boolean;
}

export interface Discovered {
  mcpUrl: string;
  /**
   * The CANONICAL display URL — what a human/browser should OPEN. Comes from
   * the serve-written pointer when present (`http://localhost:<port>` for the
   * default host, the explicit `--host` otherwise); falls back to
   * `http://localhost:<port>`. NEVER a literal loopback address: to a browser
   * `localhost` and `127.0.0.1` are DIFFERENT ORIGINS (different
   * SharedWorkers, so different sandboxes), and serve's banner/auto-open use
   * `localhost` — guidance built from this field must land on the SAME origin.
   * Node-side connectivity uses `base`/`mcpUrl` instead.
   */
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
 * may bind `127.0.0.1`-only while under another binds `::1`-only. So a
 * discovery client never trusts the hostname: it takes the PORT and tries
 * explicit `127.0.0.1` and `[::1]`, using whichever the server is actually on.
 */
export function basesForPort(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}

export async function probeHealth(base: string): Promise<HealthLite | null> {
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
 * so when two sandboxes collide on one port across families, the client locks
 * onto the one the pointer names, not merely the first to answer. (An older
 * server with no `instanceId` field can't be identity-checked; matching is
 * skipped in that case so the pointer still resolves.)
 */
export async function healthyBase(
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

/**
 * Canonical display URL for a serve on `port`. Prefers the pointer's own
 * `url` (serve writes `http://<requested host>:<port>` — `localhost` for the
 * default, the explicit `--host` otherwise) so guidance shares the origin the
 * banner/auto-open used; falls back to `http://localhost:<port>` (browsers
 * resolve `localhost` dual-stack, so it reaches either loopback family).
 */
export function canonicalServeUrl(port: number, pointerUrl?: string): string {
  if (pointerUrl) {
    try {
      const u = new URL(pointerUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return `${u.protocol}//${u.host}`;
      }
    } catch {
      /* malformed pointer url — fall through to the localhost default */
    }
  }
  return `http://localhost:${port}`;
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
  for (const pointerPath of candidatePointerPaths(cwd)) {
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
              url: canonicalServeUrl(port, p.url),
              base: hit.base,
              instanceId: hit.instanceId,
              source: `pointer ${pointerPath}`,
            };
          }
          // The pointer named a specific identity we could NOT find on its port:
          // a different sandbox may be squatting it (cross-family collision) or
          // the server stopped. Do NOT scan into a possibly-wrong server — that
          // split-brain is exactly what this identity check prevents. Fail legibly.
          if (expectedId) {
            log(
              `pointer ${pointerPath} names a server (instanceId ${expectedId.slice(0, 8)}…) ` +
                `that isn't answering on port ${port} — another sandbox may be squatting the ` +
                `port on the other loopback family, or the server stopped. Not falling back to ` +
                `a blind port scan (it could hit the wrong sandbox). Restart your dev server, ` +
                `and open the exact URL it prints (http://localhost:<port> by default) — every ` +
                `page must share that ONE origin, or the browser splits into separate sandboxes.`,
            );
            return null;
          }
        }
      } catch {
        /* stale/corrupt pointer — fall through to next candidate */
      }
    }
  }
  for (const port of scanPorts) {
    const hit = await healthyBase(port);
    if (hit) {
      return {
        mcpUrl: `${hit.base}/__pyric/mcp`,
        url: canonicalServeUrl(port),
        base: hit.base,
        instanceId: hit.instanceId,
        source: `port scan (:${port})`,
      };
    }
  }
  return null;
}
