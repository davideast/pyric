#!/usr/bin/env bun
/**
 * Pull recent Cloud Run logs for the `inferenceApi` function, using
 * the digame-mas service account — so the function side stops being a
 * black box.
 *
 * The function logs structured JSON lines via `logFn()`; Cloud Run
 * captures stdout into Cloud Logging as `jsonPayload`. This fetches
 * and pretty-prints them (alongside any plain stdout / crash output).
 *
 * SA lookup: $DEPLOY_SA_PATH, else a walk up to
 * ignored/digame-mas-service-account.json. Needs `logging.logEntries.list`
 * on the SA (roles/logging.viewer or broader) — if it 403s, that's the
 * grant to add.
 *
 * Usage:
 *   bun scripts/fn-logs.ts                # last 15 min
 *   bun scripts/fn-logs.ts --since=1h     # last hour
 *   bun scripts/fn-logs.ts --since=45m
 */
import { fromServiceAccount } from 'pyric-tools/deploy';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'inferenceapi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const playgroundRoot = resolve(__dirname, '..');

function findServiceAccount(): string {
  if (process.env.DEPLOY_SA_PATH) return process.env.DEPLOY_SA_PATH;
  let dir = playgroundRoot;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'ignored', 'digame-mas-service-account.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  console.error(
    'Could not find the digame-mas service account. Set DEPLOY_SA_PATH or place it at ignored/digame-mas-service-account.json.',
  );
  process.exit(1);
}

function parseSinceMinutes(): number {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  const raw = arg ? arg.slice('--since='.length) : '15m';
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 15;
  return raw.trim().endsWith('h') ? n * 60 : n;
}

interface LogEntry {
  timestamp?: string;
  severity?: string;
  jsonPayload?: Record<string, unknown>;
  textPayload?: string;
  /** Cloud Run request logs land here, not in a payload. */
  httpRequest?: {
    requestMethod?: string;
    requestUrl?: string;
    status?: number;
    latency?: string;
  };
}

const scope = await fromServiceAccount(findServiceAccount());
const token = await scope.resolveToken();

const sinceMinutes = parseSinceMinutes();
const startTime = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
const filter = [
  'resource.type="cloud_run_revision"',
  `resource.labels.service_name="${SERVICE_NAME}"`,
  `timestamp>="${startTime}"`,
].join(' AND ');

const res = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${scope.projectId}`],
    filter,
    orderBy: 'timestamp asc',
    pageSize: 400,
  }),
});

if (!res.ok) {
  const body = await res.text().catch(() => res.statusText);
  console.error(`\nCloud Logging request failed: ${res.status}`);
  console.error(body.slice(0, 600));
  if (res.status === 403) {
    console.error('\n→ The SA needs log-read access. Grant roles/logging.viewer on digame-mas.');
  }
  process.exit(1);
}

const data = (await res.json()) as { entries?: LogEntry[] };
const entries = data.entries ?? [];

console.log('');
console.log(`  ${SERVICE_NAME} — ${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'} in the last ${sinceMinutes}m\n`);

if (entries.length === 0) {
  console.log('  (nothing — run a job against the function, then re-run this)\n');
  process.exit(0);
}

for (const e of entries) {
  const time = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 23) : '??:??:??';
  const sev = (e.severity ?? 'DEFAULT').padEnd(7);
  if (e.jsonPayload && typeof e.jsonPayload.event === 'string') {
    // Our structured logFn() line — the signal we care about.
    const { src, event, ts, ...meta } = e.jsonPayload;
    void src;
    void ts;
    const metaStr = Object.keys(meta).length > 0 ? `  ${JSON.stringify(meta)}` : '';
    console.log(`  ${time}  ${sev}  ${String(event)}${metaStr}`);
  } else if (e.jsonPayload) {
    console.log(`  ${time}  ${sev}  ${JSON.stringify(e.jsonPayload)}`);
  } else if (e.httpRequest) {
    const h = e.httpRequest;
    console.log(
      `  ${time}  ${sev}  HTTP ${h.requestMethod ?? '?'} ${h.status ?? '?'} ` +
        `${h.latency ?? ''}  ${h.requestUrl ?? ''}`,
    );
  } else if (e.textPayload && e.textPayload.trim()) {
    console.log(`  ${time}  ${sev}  ${e.textPayload.trim()}`);
  } else {
    // Platform line with content in protoPayload / labels we don't
    // format — show severity so the timeline stays intact.
    console.log(`  ${time}  ${sev}  (platform)`);
  }
}
console.log('');
