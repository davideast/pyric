import type { ClientDb } from '../client.js';
import { disconnectClient } from './disconnect.js';

interface PagehideEvents {
  addEventListener?(type: 'pagehide', listener: (event: Event) => void): void;
  removeEventListener?(type: 'pagehide', listener: (event: Event) => void): void;
}

type Disconnect = (client: ClientDb) => Promise<void>;

function isServiceWorkerScope(events: unknown): boolean {
  if (typeof events !== 'object' || events === null) return false;
  const scope = events as { registration?: unknown; clients?: unknown };
  return scope.registration !== undefined && scope.clients !== undefined;
}

function canListenToPagehide(events: PagehideEvents): boolean {
  if (typeof events.addEventListener !== 'function') return false;
  if (isServiceWorkerScope(events)) return false;
  return true;
}

/** Own a worker port until its page permanently leaves. */
export function ownClientUntilPagehide(
  client: ClientDb,
  events: PagehideEvents = globalThis,
  disconnectClientImpl: Disconnect = disconnectClient,
): { disconnect(): Promise<void>; dispose(): void } {
  let disconnecting: Promise<void> | undefined;
  const disconnect = (): Promise<void> => disconnecting ??= disconnectClientImpl(client);
  const onPageHide = (event: Event): void => {
    // A persisted pagehide enters the back-forward cache, which restores the
    // live client and its port on pageshow.
    if ((event as PageTransitionEvent).persisted) return;
    void disconnect().catch(() => undefined);
  };

  // Only attach in environments that actually represent a page/window.
  // In Service Workers or non-browser environments, `addEventListener('pagehide')` is invalid and
  // attaching on a ServiceWorkerGlobalScope after initial evaluation throws.
  const canListen = canListenToPagehide(events);
  if (canListen) {
    events.addEventListener?.('pagehide', onPageHide);
  }
  return {
    disconnect,
    dispose: () => {
      if (canListen) {
        events.removeEventListener?.('pagehide', onPageHide);
      }
    },
  };
}


