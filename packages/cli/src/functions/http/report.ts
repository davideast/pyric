/**
 * The lines both planes print about onRequest functions, so `pyric sandbox`
 * and the Vite plugin say the same thing.
 */
import type { FunctionsChildHttpReady, FunctionsChildReady, SerializedFunctionsError } from '../child-protocol.js';
import type { FunctionsHttpState } from './gateway.js';

/** One URL per served function and region, under the emulator path. */
export function httpFunctionLines(http: FunctionsChildHttpReady, serveUrl: string, projectId: string): string[] {
  const base = serveUrl.replace(/\/$/, '');
  const count = http.functions.length;
  const urls = http.functions.flatMap((fn) =>
    fn.regions.map((region) => `    ${base}/${projectId}/${region}/${fn.exportName}`));
  return [`functions ${count} onRequest function${count === 1 ? '' : 's'}:`, ...urls];
}

/**
 * Warns once per function, across reloads, that an `invoker: 'private'`
 * function is served without authentication (functions-http#15).
 */
export function createPrivateInvokerWarnings(): (http: FunctionsChildHttpReady) => string[] {
  const warned = new Set<string>();
  return (http) => http.functions
    .filter((fn) => fn.privateInvoker && !warned.has(fn.exportName))
    .map((fn) => {
      warned.add(fn.exportName);
      return `functions export ${fn.exportName} sets invoker: 'private'; production refuses unauthenticated calls with 403, and pyric serves it without authentication.`;
    });
}

export function uncaughtErrorLine(error: SerializedFunctionsError): string {
  return `functions uncaught exception, kept serving: ${error.stack ?? `${error.name}: ${error.message}`}`;
}

/** The gateway state a finished start or reload leaves. */
export function stateAfterStart(
  result: { kind: 'ready'; ready: FunctionsChildReady } | { kind: 'no-peer' } | { kind: 'failed'; error: Error },
  serveUrl: string,
): FunctionsHttpState {
  if (result.kind === 'ready') return { kind: 'ready', http: result.ready.http ?? null };
  if (result.kind === 'no-peer') return { kind: 'waiting-peer', serveUrl };
  return { kind: 'failed', message: result.error.message };
}
