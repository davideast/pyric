import {
  DIAGNOSTICS_PATH,
  DIAGNOSTIC_EVENT_LIMIT,
  diagnosticUrl,
  type BrowserDiagnosticReport,
  type DiagnosticEvent,
} from './diagnostics-report.js';
import { stampedSessionToken } from './hosted-target.js';

export interface BrowserDiagnostics {
  getSnapshot(): BrowserDiagnosticReport;
  record(event: Omit<DiagnosticEvent, 'at'>): void;
  flush(): Promise<void>;
}

declare global {
  var __pyricDiagnostics: BrowserDiagnostics | undefined;
}

let reportingStopped = false;
let cancelScheduledFlush: (() => void) | undefined;

/**
 * Stops (or re-enables when `stopped === false`) HTTP reporting to
 * `/__pyric/diagnostics` while keeping the bounded in-memory snapshot.
 * Used when `/__pyric/init.json` identifies a refused or remote page (#2056).
 */
export function stopDiagnosticReporting(stopped = true): void {
  reportingStopped = stopped;
  if (stopped) {
    cancelScheduledFlush?.();
  }
}

/** Lazy per-realm collector. Reporting must never delay or reject an SDK operation. */
function diagnostics(): BrowserDiagnostics | undefined {
  if (globalThis.__pyricDiagnostics) return globalThis.__pyricDiagnostics;
  if (typeof location === 'undefined') return undefined;
  const isHttpPage = location.protocol === 'http:' || location.protocol === 'https:';
  if (!isHttpPage) return undefined;
  const realm = typeof document === 'undefined' ? 'service-worker' : 'page';
  const report: BrowserDiagnosticReport = {
    version: 1,
    clientId: `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    sequence: 0,
    realm,
    pageOrigin: location.origin,
    events: [],
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  cancelScheduledFlush = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const snapshot = (): BrowserDiagnosticReport => ({
    ...report,
    events: report.events.map(event => ({ ...event })),
  });
  const schedule = (): void => {
    if (reportingStopped) return;
    const hasPendingReport = timer !== undefined || sending;
    if (hasPendingReport) return;
    timer = setTimeout(() => {
      timer = undefined;
      void client.flush();
    }, 100);
  };
  const client: BrowserDiagnostics = {
    getSnapshot: snapshot,
    record(event) {
      const endpoint = event.endpoint ? diagnosticUrl(event.endpoint) : undefined;
      report.sequence += 1;
      report.events.push({ ...event, endpoint, at: Date.now() });
      report.events = report.events.slice(-DIAGNOSTIC_EVENT_LIMIT);
      schedule();
    },
    async flush() {
      if (sending || reportingStopped) return;
      sending = true;
      const sentSequence = report.sequence;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const token = stampedSessionToken();
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token !== undefined) headers['x-pyric-session-token'] = token;
        const response = await fetch(new URL(DIAGNOSTICS_PATH, location.href), {
          method: 'POST',
          headers,
          body: JSON.stringify(snapshot()),
          signal: controller.signal,
          credentials: 'same-origin',
          keepalive: true,
        });
        if (response.status === 401 || response.status === 403) {
          reportingStopped = true;
        }
      } catch {
        // The bounded local report remains available if HTTP is also unavailable.
      } finally {
        clearTimeout(timeout);
        sending = false;
        const hasNewEvents = !reportingStopped && report.sequence > sentSequence;
        if (hasNewEvents) schedule();
      }
    },
  };
  globalThis.__pyricDiagnostics = client;
  globalThis.addEventListener('online', schedule);
  globalThis.addEventListener('pagehide', () => {
    clearTimeout(timer);
    timer = undefined;
    void client.flush();
  });
  return client;
}

export function recordDiagnostic(event: Omit<DiagnosticEvent, 'at'>): void {
  try {
    diagnostics()?.record(event);
  } catch {
    // Diagnostics are best-effort even with restricted browser APIs.
  }
}
