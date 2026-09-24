import { getHostedFirestore } from '@pyric/cli/serve/worker';
import { resolveSessionToken } from './http-workspace.js';
import type { StudioWorkerRuntime, StudioWorkerRuntimeSnapshot } from './worker-runtime.js';

/** Reuse Studio's status surface and the browser transport; hosted builds update on restart. */
export function connectHostedStudio(target: { url: string; projectKey: string }) {
  const listeners = new Set<() => void>();
  let snapshot: StudioWorkerRuntimeSnapshot = {
    mode: 'hosted', servedEpoch: null, runningEpoch: null,
    updateAvailable: false, updating: false, error: 'Connecting to the hosted sandbox.',
  };
  function publish(error: string | null): void {
    snapshot = { ...snapshot, error };
    for (const listener of listeners) listener();
  }
  const db = getHostedFirestore({
    ...target,
    // Studio reads object bytes for previews over the host's byte route.
    sessionToken: () => resolveSessionToken(location.origin),
    onConnection(state) {
      switch (state) {
        case 'attached': publish(null); return;
        case 'connecting': publish('Connecting to the hosted sandbox.'); return;
        case 'restoring': publish('Restoring the hosted session.'); return;
        case 'interrupted': publish('Hosted connection lost; reconnecting.'); return;
        case 'closed': publish('Hosted connection closed. Repair the host and reload Studio.'); return;
      }
    },
    onError: error => publish(error.message),
  });
  const runtime: StudioWorkerRuntime = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async update() { throw new Error('Restart the hosted sandbox and reload Studio to update it.'); },
    dispose() { listeners.clear(); },
  };
  return { db, runtime };
}
