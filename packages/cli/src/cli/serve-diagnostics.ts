import type { ParsedArgs } from './parse-args.js';
import { boundedFetch } from '../bounded-request.js';
import { discoverServe, selectProjectHost } from '../serve/discovery.js';
import { discoverHttpsPointer, resolveSessionTokenForTarget } from '../serve/local-session-token.js';
import { DIAGNOSTICS_PATH } from '../serve/runtime/diagnostics-report.js';

/** Milliseconds the diagnostics request has, connect and body included. */
const DIAGNOSTICS_DEADLINE_MS = 3000;

export async function runServeDiagnostics(
  parsed: ParsedArgs,
  deps: {
    cwd?: string;
    stdout?: { write(value: string): void };
  } = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const cwd = deps.cwd ?? process.cwd();
  const explicit = parsed.flags.get('url');
  let discovered = null;
  if (typeof explicit !== 'string') {
    discovered =
      (await discoverHttpsPointer(cwd)) ??
      selectProjectHost(await discoverServe(cwd, () => {}), () => {});
  }
  const found = typeof explicit === 'string' ? explicit : discovered?.url;
  const print = (report: unknown) => out.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!found) {
    print({ version: 1, server: { http: 'unknown' }, error: 'No running sandbox found. Start it or pass --url.' });
    return 2;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(DIAGNOSTICS_PATH, found);
    const isHttp = endpoint.protocol === 'http:' || endpoint.protocol === 'https:';
    const hasCredentials = endpoint.username.length > 0 || endpoint.password.length > 0;
    const invalidUrl = !isHttp || hasCredentials;
    if (invalidUrl) throw new Error('Invalid URL.');
  } catch {
    print({ version: 1, server: { http: 'unknown' }, error: 'Use an HTTP(S) URL without credentials.' });
    return 1;
  }
  const sessionToken = discovered?.token ?? resolveSessionTokenForTarget({ cwd, url: endpoint.origin });
  let reachedServer = false;
  try {
    let response: Response;
    if (sessionToken !== undefined) {
      response = await boundedFetch(endpoint, {
        deadlineMs: DIAGNOSTICS_DEADLINE_MS,
        maxBytes: Number.POSITIVE_INFINITY,
        redirect: 'error',
        headers: { 'x-pyric-session-token': sessionToken },
      });
    } else {
      response = await boundedFetch(endpoint, {
        deadlineMs: DIAGNOSTICS_DEADLINE_MS,
        maxBytes: Number.POSITIVE_INFINITY,
        redirect: 'error',
      });
    }
    reachedServer = true;
    if (!response.ok) {
      print({
        version: 1,
        server: { http: 'responding', status: response.status },
        error: 'Diagnostics endpoint unavailable. Check the URL and CLI version.',
      });
      return 2;
    }
    const report = (await response.json()) as {
      version?: unknown;
      server?: { http?: unknown };
      clients?: unknown;
    };
    const validReport =
      report?.version === 1 && report.server?.http === 'responding' && Array.isArray(report.clients);
    if (!validReport) throw new Error('Invalid diagnostic report.');
    print(report);
    return 0;
  } catch {
    const httpState = reachedServer ? 'responding' : 'unreachable';
    let errorMessage = 'HTTP connection failed or timed out. Check the server and network.';
    if (reachedServer) {
      errorMessage = 'The server did not return a valid diagnostic report.';
    }
    print({
      version: 1,
      server: { http: httpState },
      error: errorMessage,
    });
    return 2;
  }
}
