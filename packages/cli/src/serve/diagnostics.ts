import type { PersistenceStatus } from './hosted/persistence/commits.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { collectBody, BODY_TOO_LARGE_CODE } from '../bridge/server/peer.js';
import { DIAGNOSTIC_EVENT_LIMIT, DIAGNOSTIC_PHASES, diagnosticUrl, type BrowserDiagnosticReport } from './runtime/diagnostics-report.js';

const CLIENT_LIMIT = 32;
const RETENTION_MS = 15 * 60_000;
const id = z.string().min(1).max(64).regex(/^[\w-]+$/);
const schema = z.object({
  version: z.literal(1), clientId: id, sequence: z.number().int().nonnegative(),
  realm: z.enum(['page', 'service-worker']), pageOrigin: z.string().max(1024),
  events: z.array(z.object({
    at: z.number().finite().nonnegative(), phase: z.enum(DIAGNOSTIC_PHASES),
    connectionId: id.optional(), endpoint: z.string().max(1024).optional(),
    code: z.number().int().min(0).max(65535).optional(),
  })).max(DIAGNOSTIC_EVENT_LIMIT),
});

function sanitizeReport(value: unknown): BrowserDiagnosticReport {
  const report = schema.parse(value);
  report.pageOrigin = new URL(diagnosticUrl(report.pageOrigin)).origin;
  report.events = report.events.map(event => ({
    ...event,
    ...(event.endpoint ? { endpoint: diagnosticUrl(event.endpoint) } : {}),
  }));
  return report;
}

function findings(report: BrowserDiagnosticReport) {
  const expected = new URL(report.pageOrigin);
  expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
  const connections = new Map<string, string>();
  for (const event of report.events) {
    const hasEndpoint = event.connectionId !== undefined && event.endpoint !== undefined;
    if (hasEndpoint) connections.set(event.connectionId!, new URL(event.endpoint!).origin);
  }
  return [...connections].flatMap(([connectionId, actualOrigin]) => {
    const matchesPageOrigin = actualOrigin === expected.origin;
    return matchesPageOrigin ? [] : [{ code: 'endpoint-origin-mismatch', connectionId, expectedOrigin: expected.origin, actualOrigin }];
  });
}

/** One store per server generation. No disk writes, timers, or unbounded client history. */
export function createDiagnostics(mode: () => 'hosted' | 'browser', persistence?: () => PersistenceStatus) {
  const startedAt = Date.now();
  const clients = new Map<string, { report: BrowserDiagnosticReport; receivedAt: number }>();
  function expire() {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [key, entry] of clients) {
      const expired = entry.receivedAt < cutoff;
      if (expired) clients.delete(key);
    }
  }
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    expire();
    res.setHeader('cache-control', 'no-store');
    const readsReport = req.method === 'GET';
    if (readsReport) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        version: 1,
        server: { http: 'responding', mode: mode(), startedAt, uptimeMs: Date.now() - startedAt, persistence: persistence?.() },
        retention: { clientLimit: CLIENT_LIMIT, eventsPerClient: DIAGNOSTIC_EVENT_LIMIT, ttlMs: RETENTION_MS },
        clients: [...clients.values()].map(({ report, receivedAt }) => ({
          ...report, receivedAt, source: 'browser-reported', findings: findings(report),
        })),
      }));
      return;
    }
    const unsupportedMethod = req.method !== 'POST';
    if (unsupportedMethod) {
      res.writeHead(405, { allow: 'GET, POST' }).end();
      return;
    }
    const isJson = req.headers['content-type']?.split(';')[0]?.trim() === 'application/json';
    const invalidContentType = !isJson;
    if (invalidContentType) { res.writeHead(415).end(); return; }
    try {
      const report = sanitizeReport(await collectBody(req, 16_384));
      const previous = clients.get(report.clientId);
      const isNewer = previous === undefined || report.sequence > previous.report.sequence;
      if (isNewer) {
        clients.delete(report.clientId);
        clients.set(report.clientId, { report, receivedAt: Date.now() });
        const overCapacity = clients.size > CLIENT_LIMIT;
        const oldest = clients.keys().next().value;
        const evictsOldest = overCapacity && oldest !== undefined;
        if (evictsOldest) clients.delete(oldest);
      }
      res.writeHead(204).end();
    } catch (error) {
      const tooLarge = error instanceof Error && 'code' in error && error.code === BODY_TOO_LARGE_CODE;
      res.writeHead(tooLarge ? 413 : 400).end('Invalid diagnostic report.');
    }
  };
}
