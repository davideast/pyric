import type { ParsedArgs } from './parse-args.js';
import { boundedFetch } from '../bounded-request.js';
import { discoverServe } from '../serve/discovery.js';
import { DIAGNOSTICS_PATH } from '../serve/runtime/diagnostics-report.js';

/** Milliseconds the diagnostics request has, connect and body included. */
const DIAGNOSTICS_DEADLINE_MS = 3000;

export async function runServeDiagnostics(parsed: ParsedArgs, deps: {
  cwd?: string;
  stdout?: { write(value: string): void };
} = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const explicit = parsed.flags.get('url');
  const found = typeof explicit === 'string' ? explicit : (await discoverServe(deps.cwd ?? process.cwd()))?.url;
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
  let reachedServer = false;
  try {
    // Bounded, connect included, so a port whose connect never completes
    // cannot hold the command open past its answer (#1167). The report is
    // read whole within the deadline, as fetch's abort covered the body too.
    const response = await boundedFetch(endpoint, {
      deadlineMs: DIAGNOSTICS_DEADLINE_MS,
      maxBytes: Number.POSITIVE_INFINITY,
      redirect: 'error',
    });
    reachedServer = true;
    if (!response.ok) {
      print({ version: 1, server: { http: 'responding', status: response.status }, error: 'Diagnostics endpoint unavailable. Check the URL and CLI version.' });
      return 2;
    }
    const report = await response.json() as { version?: unknown; server?: { http?: unknown }; clients?: unknown };
    const validReport = report?.version === 1 && report.server?.http === 'responding' && Array.isArray(report.clients);
    if (!validReport) throw new Error('Invalid diagnostic report.');
    print(report);
    return 0;
  } catch {
    print({
      version: 1,
      server: { http: reachedServer ? 'responding' : 'unreachable' },
      error: reachedServer ? 'The server did not return a valid diagnostic report.' : 'HTTP connection failed or timed out. Check the server and network.',
    });
    return 2;
  }
}
