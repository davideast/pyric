import { DIAGNOSTICS_PATH, DIAGNOSTIC_EVENT_LIMIT, diagnosticUrl, type BrowserDiagnosticReport, type DiagnosticEvent } from './diagnostics-report.js';

export interface BrowserDiagnostics {
  getSnapshot(): BrowserDiagnosticReport;
  record(event: Omit<DiagnosticEvent, 'at'>): void;
  flush(): Promise<void>;
}

declare global { var __pyricDiagnostics: BrowserDiagnostics | undefined; }

/** Lazy per-realm collector. Reporting must never delay or reject an SDK operation. */
function diagnostics(): BrowserDiagnostics | undefined {
  if (globalThis.__pyricDiagnostics) return globalThis.__pyricDiagnostics;
  if (typeof location === 'undefined') return undefined;
  const isHttpPage = location.protocol === 'http:' || location.protocol === 'https:';
  if (!isHttpPage) return undefined;
  const report: BrowserDiagnosticReport = {
    version: 1,
    clientId: `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    sequence: 0,
    realm: typeof document === 'undefined' ? 'service-worker' : 'page',
    pageOrigin: location.origin,
    events: [],
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  const snapshot = () => ({ ...report, events: report.events.map(event => ({ ...event })) });
  const schedule = () => {
    const hasPendingReport = timer !== undefined || sending;
    if (hasPendingReport) return;
    timer = setTimeout(() => { timer = undefined; void client.flush(); }, 100);
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
      if (sending) return;
      sending = true;
      const sentSequence = report.sequence;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        await fetch(new URL(DIAGNOSTICS_PATH, location.href), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(snapshot()), signal: controller.signal,
          credentials: 'same-origin', keepalive: true,
        });
      } catch {
        // The bounded local report remains available if HTTP is also unavailable.
      } finally {
        clearTimeout(timeout);
        sending = false;
        const hasNewEvents = report.sequence > sentSequence;
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
  try { diagnostics()?.record(event); }
  catch { /* Diagnostics are best-effort even with restricted browser APIs. */ }
}
