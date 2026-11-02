/**
 * What a matched function route answers while the child cannot serve it
 * (functions-http#20). Each line says what actually brings Functions back on
 * the plane that prints it: the Vite plugin retries when a tab connects and
 * reloads on save, and `pyric sandbox` does neither.
 */
import type { FunctionsHttpState } from './gateway.js';

/** The plane a gateway serves: `pyric sandbox`'s static server, or the `pyric()` Vite plugin. */
export type FunctionsPlane = 'pyric-sandbox' | 'vite';

function peerTimeoutReason(serveUrl: string, plane: FunctionsPlane): string {
  const retriesOnPeer = plane === 'vite';
  if (retriesOnPeer) {
    return `Functions are not running: no browser tab connected to the sandbox within 30 s. Open ${serveUrl}; they start when the tab connects.`;
  }
  return `Functions did not start: no browser tab connected to pyric sandbox within 30 s, and pyric sandbox does not retry. Open ${serveUrl}, then restart pyric sandbox.`;
}

function exitedReason(code: number, plane: FunctionsPlane): string {
  const reloadsOnSave = plane === 'vite';
  if (reloadsOnSave) {
    return `The Functions child exited (code ${code}). Save a Functions source file or restart the Vite dev server to start it again.`;
  }
  return `The Functions child exited (code ${code}). Restart pyric sandbox to start it again.`;
}

/** Why a matched route cannot be served now; null once the child is ready. */
export function unavailableReason(state: FunctionsHttpState, plane: FunctionsPlane): string | null {
  switch (state.kind) {
    case 'waiting-peer':
      return `Functions are not running yet: no browser tab is connected to the sandbox. Open ${state.serveUrl} to start them.`;
    case 'peer-timeout':
      return peerTimeoutReason(state.serveUrl, plane);
    case 'starting':
      return 'Functions are starting. Retry in a moment.';
    case 'reloading':
      return 'Functions are reloading after a source change. Retry in a moment.';
    case 'failed':
      return `Functions failed to start: ${state.message}`;
    case 'unresponsive':
      return 'The Functions child is unresponsive: a handler may be stuck in a synchronous loop. pyric is restarting it; retry in a moment.';
    case 'exited':
      return exitedReason(state.code, plane);
    case 'stopped':
      return 'Functions are stopped.';
    case 'ready':
      return null;
  }
}
