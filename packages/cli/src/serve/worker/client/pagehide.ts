import type { ClientDb } from '../client.js';
import { disconnectClient } from './disconnect.js';

interface PagehideEvents {
  addEventListener?(type: 'pagehide', listener: (event: Event) => void): void;
  removeEventListener?(type: 'pagehide', listener: (event: Event) => void): void;
}

type Disconnect = (client: ClientDb) => Promise<void>;

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

  events.addEventListener?.('pagehide', onPageHide);
  return {
    disconnect,
    dispose: () => events.removeEventListener?.('pagehide', onPageHide),
  };
}
