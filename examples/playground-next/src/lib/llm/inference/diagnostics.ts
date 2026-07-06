/**
 * Page-side activity log.
 *
 *   - logPage(event, reqId?, meta?) → localStorage ring buffer
 *   - exportLogs() returns the full payload
 *   - printLogs() / printSummary() console-dump it as JSON so you can
 *     select-all + copy from the DevTools console (clipboard writes
 *     from a console invocation throw NotAllowedError — console it is)
 *   - summarize() rolls server-stream jobs up to one row each and
 *     flags anomalies
 *
 * Exposed on `window.__pyric` so a console caller — including remote
 * DevTools over USB — can dump the snapshot during/after a failure
 * with no UI.
 *
 * (There used to be a second surface: the service worker's
 * diagnostics IDB, read cross-side. The SW was removed — this is
 * page-only now. See plans/sw-inference-backgrounding-recovery.md.)
 */

const PAGE_STORAGE_KEY = 'pyric.diagnostics.log';
const MAX_PAGE_ENTRIES = 1000;

export interface LogEntry {
  ts: number;
  event: string;
  reqId?: string;
  meta?: Record<string, unknown>;
}

export interface ExportPayload {
  exportedAt: number;
  userAgent: string;
  inferenceMode: string;
  visibility: string;
  online: boolean;
  connectionType: string | null;
  counts: { page: number };
  page: LogEntry[];
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readPageArray(): LogEntry[] {
  const ls = safeLocalStorage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(PAGE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LogEntry[]) : [];
  } catch {
    return [];
  }
}

function writePageArray(arr: LogEntry[]): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(PAGE_STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // Quota exceeded — drop the older half and retry once.
    try {
      ls.setItem(PAGE_STORAGE_KEY, JSON.stringify(arr.slice(-Math.floor(MAX_PAGE_ENTRIES / 2))));
    } catch {
      /* give up; instrumentation must not crash */
    }
  }
}

export function logPage(event: string, reqId?: string, meta?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const arr = readPageArray();
  const entry: LogEntry = { ts: Date.now(), event };
  if (reqId) entry.reqId = reqId;
  if (meta) entry.meta = meta;
  arr.push(entry);
  if (arr.length > MAX_PAGE_ENTRIES) {
    arr.splice(0, arr.length - MAX_PAGE_ENTRIES);
  }
  writePageArray(arr);
  // Stored only — no console mirror. The on-page Diagnostics panel
  // and the `window.__pyric.printLogs()` dump are the inspection
  // surfaces; spamming every page event into the console was hostile
  // (visibility_change alone fires hundreds of times in a session).
}

export function clearPageLog(): void {
  const ls = safeLocalStorage();
  try {
    ls?.removeItem(PAGE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Restore a previously-exported payload into the local log. Used when
 * loading a saved session whose `diagnostics` field carries a payload
 * captured on another device — restoring it locally lets the existing
 * Settings → Diagnostics panel render it with no special-casing.
 * Clobbers the local log; that's intentional — you loaded a session
 * to inspect ITS diagnostics.
 *
 * `async` only to keep call sites unchanged from when there was also
 * an IDB surface to restore. Tolerates old payloads that still carry
 * a `sw` field (ignored).
 */
export async function restoreLogs(payload: ExportPayload): Promise<void> {
  writePageArray(payload.page ?? []);
}

/** Clear the page activity log — a clean slate before a focused test
 *  run. `async` for call-site stability (see `restoreLogs`). */
export async function clearAllLogs(): Promise<void> {
  clearPageLog();
}

interface NetworkInformation {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

function getConnection(): NetworkInformation | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as unknown as { connection?: NetworkInformation }).connection;
}

export async function exportLogs(): Promise<ExportPayload> {
  const page = readPageArray();
  const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : {};
  const pyric = (w.__pyric as { inferenceMode?: string } | undefined) ?? {};
  const conn = getConnection();
  return {
    exportedAt: Date.now(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    inferenceMode: pyric.inferenceMode ?? 'unknown',
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    connectionType: conn?.effectiveType ?? null,
    counts: { page: page.length },
    page,
  };
}

/**
 * Print the full diagnostics payload as stringified JSON to the
 * console. Console output works in every context — including the
 * remote-DevTools panel served over USB from Android — which the
 * clipboard API does not (`navigator.clipboard.writeText` requires a
 * fresh user gesture and throws `NotAllowedError` from a console
 * invocation).
 */
export async function printLogs(): Promise<void> {
  const payload = await exportLogs();
  if (typeof console !== 'undefined') {
    console.info('[diag] dumping', payload.counts.page, 'log entries');
    console.log(JSON.stringify(payload, null, 2));
  }
}

/**
 * Compact, signal-heavy view of a session for sharing back during
 * debugging. Collapses chatter and rolls the server-stream client's
 * job lifecycles up to one row per requestId. Surfaces detected
 * anomalies up front.
 *
 * Use this as the default. For raw event details call
 * `__pyric.printLogs()`, or `__pyric.printRequest(reqId)` to drill
 * into one request's timeline.
 */
export interface SessionSummary {
  meta: {
    exportedAt: number;
    sessionStartedAt: number;
    sessionDurationMs: number;
    userAgent: string;
    inferenceMode: string;
    visibility: string;
    online: boolean;
    connectionType: string | null;
    counts: { page: number };
  };
  lifecycle: Array<Record<string, unknown> & { t: number; event: string }>;
  requests: Array<{
    reqId: string;
    startMs: number;
    durationMs: number | null;
    provider: string | null;
    model: string | null;
    /** server-stream reconnects observed for this job. */
    reconnects: number;
    outcome: 'complete' | 'incomplete';
  }>;
  anomalies: string[];
}

const SIGNIFICANT_PAGE_EVENTS = new Set([
  'page_load',
  'lifecycle_freeze',
  'lifecycle_resume',
  'lifecycle_pagehide',
  'lifecycle_pageshow',
  'online',
  'offline',
  'connection_change',
  'dispatch_route',
  'server_job_started',
  'server_reconnect',
  'server_job_complete',
]);

export async function summarize(): Promise<SessionSummary> {
  const payload = await exportLogs();
  const pageLoadEvent = payload.page.find((e) => e.event === 'page_load');
  const sessionStartedAt = pageLoadEvent?.ts ?? payload.page[0]?.ts ?? payload.exportedAt;
  const rel = (ts: number) => ts - sessionStartedAt;

  const lifecycle: Array<Record<string, unknown> & { t: number; event: string }> = [];
  for (const e of payload.page) {
    if (!SIGNIFICANT_PAGE_EVENTS.has(e.event)) continue;
    lifecycle.push({ t: rel(e.ts), event: e.event, ...(e.meta ?? {}) });
  }
  lifecycle.sort((a, b) => a.t - b.t);

  // Roll up every reqId-tagged event per request. Post-SW the only
  // reqId-tagged events are the server-stream client's:
  // server_job_started / server_reconnect / server_job_complete.
  const byReq = new Map<string, LogEntry[]>();
  for (const e of payload.page) {
    if (!e.reqId) continue;
    const arr = byReq.get(e.reqId) ?? [];
    arr.push(e);
    byReq.set(e.reqId, arr);
  }

  const requests: SessionSummary['requests'] = [];
  for (const [reqId, events] of byReq.entries()) {
    events.sort((a, b) => a.ts - b.ts);
    const startEvent = events.find((e) => e.event === 'server_job_started') ?? events[0]!;
    const endEvent = events.find((e) => e.event === 'server_job_complete');
    const reconnects = events.filter((e) => e.event === 'server_reconnect').length;
    const startMeta = startEvent.meta as { provider?: string; model?: string } | undefined;
    requests.push({
      reqId,
      startMs: rel(startEvent.ts),
      durationMs: endEvent ? endEvent.ts - startEvent.ts : null,
      provider: startMeta?.provider ?? null,
      model: startMeta?.model ?? null,
      reconnects,
      outcome: endEvent ? 'complete' : 'incomplete',
    });
  }
  requests.sort((a, b) => a.startMs - b.startMs);

  // Drop requests from previous sessions (negative startMs). They're
  // noise for "what just went wrong"; full history is in printLogs().
  const currentSessionRequests = requests.filter((r) => r.startMs >= 0);
  const historicalRequestCount = requests.length - currentSessionRequests.length;

  // Auto-detected anomalies — cheap heuristics; flag, don't diagnose.
  const anomalies: string[] = [];
  for (const ev of lifecycle) {
    if (ev.event === 'offline') anomalies.push(`offline at t=${ev.t}ms`);
  }
  for (const r of currentSessionRequests) {
    if (r.outcome === 'incomplete') {
      anomalies.push(`req ${r.reqId} never completed (started at t=${r.startMs}ms)`);
    }
  }
  if (historicalRequestCount > 0) {
    anomalies.push(
      `(${historicalRequestCount} request(s) from previous sessions hidden — use __pyric.printLogs() for the full list)`,
    );
  }

  return {
    meta: {
      exportedAt: payload.exportedAt,
      sessionStartedAt,
      sessionDurationMs: payload.exportedAt - sessionStartedAt,
      userAgent: payload.userAgent,
      inferenceMode: payload.inferenceMode,
      visibility: payload.visibility,
      online: payload.online,
      connectionType: payload.connectionType,
      counts: payload.counts,
    },
    lifecycle,
    requests: currentSessionRequests,
    anomalies,
  };
}

/**
 * Slim view of the session. Paste the JSON it logs back to the agent
 * — it's almost always enough to diagnose. Falls back to
 * `printLogs()` if more detail is needed.
 */
export async function printSummary(): Promise<void> {
  const s = await summarize();
  if (typeof console === 'undefined') return;
  console.info(
    '[diag] summary —',
    s.requests.length,
    'requests,',
    s.anomalies.length,
    'anomalies, session',
    Math.round(s.meta.sessionDurationMs / 1000),
    's',
  );
  console.log(JSON.stringify(s, null, 2));
}

/**
 * Full event timeline for a single request. Useful when the summary
 * flags an anomaly on a specific reqId and you want everything that
 * happened to that one request.
 */
export async function printRequest(reqId: string): Promise<void> {
  const payload = await exportLogs();
  const events = payload.page.filter((e) => e.reqId === reqId).sort((a, b) => a.ts - b.ts);
  if (typeof console === 'undefined') return;
  if (events.length === 0) {
    console.info('[diag] no events for', reqId);
    return;
  }
  const start = events[0]!.ts;
  const compact = events.map((e) => ({ t: e.ts - start, event: e.event, ...(e.meta ?? {}) }));
  console.info('[diag] request', reqId, '—', events.length, 'events');
  console.log(JSON.stringify(compact, null, 2));
}

export function installDiagnosticsGlobals(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __pyric?: Record<string, unknown> };
  if (!w.__pyric) w.__pyric = {};
  w.__pyric.exportLogs = exportLogs;
  w.__pyric.printLogs = printLogs;
  w.__pyric.printSummary = printSummary;
  w.__pyric.printRequest = printRequest;
  w.__pyric.clearLogs = clearAllLogs;
}
