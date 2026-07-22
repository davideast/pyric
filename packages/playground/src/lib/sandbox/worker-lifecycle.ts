import { disconnectClient, type ClientDb } from '@pyric/cli/serve/worker';

interface PagehideEvents {
  addEventListener(type: 'pagehide', listener: (event: Event) => void): void;
  removeEventListener(type: 'pagehide', listener: (event: Event) => void): void;
}

type Disconnect = (client: ClientDb) => Promise<void>;

/** Own a playground worker port until the page permanently leaves. */
export function registerWorkerPagehideDisconnect(
  client: ClientDb,
  events: PagehideEvents = globalThis,
  disconnect: Disconnect = disconnectClient,
): () => void {
  let disconnecting: Promise<void> | undefined;
  const onPageHide = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted) return;
    disconnecting ??= disconnect(client);
    void disconnecting.catch(() => undefined);
  };

  events.addEventListener('pagehide', onPageHide);
  return () => events.removeEventListener('pagehide', onPageHide);
}
