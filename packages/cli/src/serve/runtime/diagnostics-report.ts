/** Connection metadata only: never SDK payloads, identities, URL credentials, or query strings. */
export const DIAGNOSTICS_PATH = '/__pyric/diagnostics';
export const DIAGNOSTIC_EVENT_LIMIT = 32;
export const DIAGNOSTIC_PHASES = [
  'init-request', 'init-ready', 'init-failed', 'connecting', 'transport-open',
  'attached', 'restoring', 'interrupted', 'closed', 'socket-error', 'socket-close',
  'timeout',
] as const;
export interface DiagnosticEvent {
  at: number;
  phase: typeof DIAGNOSTIC_PHASES[number];
  connectionId?: string;
  endpoint?: string;
  code?: number;
}
export interface BrowserDiagnosticReport {
  version: 1;
  clientId: string;
  sequence: number;
  realm: 'page' | 'service-worker';
  pageOrigin: string;
  events: DiagnosticEvent[];
}

export function diagnosticUrl(value: string): string {
  const url = new URL(value);
  const supported = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
  if (!supported) throw new Error('Unsupported diagnostic URL scheme.');
  // Only this known transport path carries diagnostic value. Other paths may contain application data.
  const path = url.pathname === '/__pyric/sandbox' ? url.pathname : '';
  return `${url.origin}${path}`;
}
