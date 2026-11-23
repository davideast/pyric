import {
  DIAGNOSTICS_PATH,
  DIAGNOSTIC_EVENT_LIMIT,
  diagnosticUrl,
  type BrowserDiagnosticReport,
  type DiagnosticEvent,
} from './diagnostics-report.js';
import { stampedSessionToken } from './hosted-target.js';

type DiagnosticReportingState = 'active' | 'deferred' | 'stopped';

interface BrowserDiagnostics {
  getSnapshot(): BrowserDiagnosticReport;
  record(event: Omit<DiagnosticEvent, 'at'>): void;
  flush(): Promise<void>;
  cancelPending?(options?: { abortInFlight?: boolean }): void;
  scheduleIfPending?(): void;
}

declare global {
  var __pyricDiagnostics: BrowserDiagnostics | undefined;
}

const REPORTING_STATE_KEY = Symbol.for('pyric.diagnostics.reportingState');

function getReportingState(): DiagnosticReportingState {
  const current = (globalThis as Record<symbol, unknown>)[REPORTING_STATE_KEY];
  if (current === 'deferred' || current === 'stopped') return current;
  return 'active';
}

function setReportingState(next: DiagnosticReportingState): void {
  (globalThis as Record<symbol, unknown>)[REPORTING_STATE_KEY] = next;
}

/**
 * Holds HTTP flushes to `/__pyric/diagnostics` while keeping in-memory
 * recording active until `/__pyric/init.json` confirms the page is local
 * and accepted (#3264). A stopped collector stays stopped.
 */
export function deferDiagnosticReporting(): void {
  if (getReportingState() === 'stopped') return;
  setReportingState('deferred');
  globalThis.__pyricDiagnostics?.cancelPending?.();
}

/**
 * Releases a deferred hold once `/__pyric/init.json` confirms a non-remote
 * local peer and schedules any buffered events for HTTP delivery (#3264).
 * A stopped collector stays stopped.
 */
export function resumeDiagnosticReporting(): void {
  if (getReportingState() !== 'deferred') return;
  setReportingState('active');
  globalThis.__pyricDiagnostics?.scheduleIfPending?.();
}

/**
 * Stops (or re-enables when `stopped === false`) HTTP reporting to
 * `/__pyric/diagnostics` while keeping the bounded in-memory snapshot.
 * Used when `/__pyric/init.json` identifies a refused or remote page (#2056).
 */
export function stopDiagnosticReporting(stopped = true): void {
  if (stopped) {
    setReportingState('stopped');
    globalThis.__pyricDiagnostics?.cancelPending?.({ abortInFlight: true });
    return;
  }
  setReportingState('active');
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
  let deliveredSequence = 0;
  let activeController: AbortController | undefined;
  const snapshot = (): BrowserDiagnosticReport => ({
    ...report,
    events: report.events.map(event => ({ ...event })),
  });
  const schedule = (): void => {
    if (getReportingState() !== 'active') return;
    const hasPendingReport = timer !== undefined || sending;
    if (hasPendingReport) return;
    timer = setTimeout(() => {
      timer = undefined;
      void client.flush();
    }, 100);
  };
  const client: BrowserDiagnostics = {
    getSnapshot: snapshot,
    cancelPending(options) {
      clearTimeout(timer);
      timer = undefined;
      if (options?.abortInFlight === true) {
        activeController?.abort();
        activeController = undefined;
      }
    },
    scheduleIfPending() {
      if (getReportingState() !== 'active') return;
      if (report.sequence > deliveredSequence) {
        schedule();
      }
    },
    record(event) {
      const endpoint = event.endpoint ? diagnosticUrl(event.endpoint) : undefined;
      report.sequence += 1;
      report.events.push({ ...event, endpoint, at: Date.now() });
      report.events = report.events.slice(-DIAGNOSTIC_EVENT_LIMIT);
      schedule();
    },
    async flush() {
      if (sending || getReportingState() !== 'active') return;
      sending = true;
      const sentSequence = report.sequence;
      const controller = new AbortController();
      activeController = controller;
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
          setReportingState('stopped');
        } else {
          deliveredSequence = Math.max(deliveredSequence, sentSequence);
        }
      } catch {
        // The bounded local report remains available if HTTP is also unavailable.
      } finally {
        clearTimeout(timeout);
        if (activeController === controller) activeController = undefined;
        sending = false;
        const hasNewEvents = getReportingState() === 'active' && report.sequence > sentSequence;
        if (hasNewEvents) schedule();
      }
    },
  };
  globalThis.__pyricDiagnostics = client;
  globalThis.addEventListener('online', () => {
    if (globalThis.__pyricDiagnostics !== client) return;
    client.scheduleIfPending?.();
  });
  globalThis.addEventListener('pagehide', () => {
    if (globalThis.__pyricDiagnostics !== client) return;
    clearTimeout(timer);
    timer = undefined;
    if (report.sequence > deliveredSequence) {
      void client.flush();
    }
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
