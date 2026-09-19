import { FirebaseError } from 'pyric/app';
import type { InboundMessage } from '../protocol.js';
import type { ClientDb, ClientPort } from './handles.js';
import { rejectPendingRequests, wirePort } from './core.js';

/** Keep SDK handles and correlations on one port while choosing its transport. */
export function getDeferredFirestore(connection: Promise<(port: ClientPort) => ClientDb>): ClientDb {
  const queued: InboundMessage[] = [];
  const observers = new Map<(connected: boolean) => void, (() => void) | undefined>();
  let closed = false;
  let failure: FirebaseError | undefined;
  const port: ClientPort = {
    onmessage: null,
    postMessage(message) {
      if (failure) throw failure;
      if (closed) throw new FirebaseError('app/app-deleted', 'Firebase App was deleted');
      const cancelsStartup = message.t === 'disconnect';
      if (cancelsStartup) {
        queued.length = 0;
        closed = true;
        port.onmessage?.(new MessageEvent('message', { data: { t: 'res', id: message.id, ok: true, value: undefined } }));
        return;
      }
      queued.push(message);
    },
    start() {},
    observeConnection(listener) {
      observers.set(listener, undefined);
      listener(false);
      return () => { observers.get(listener)?.(); observers.delete(listener); };
    },
    close() { closed = true; queued.length = 0; observers.clear(); port.onmessage = null; },
  };
  wirePort(port);
  void connection.then(connect => {
    if (closed) return;
    // The transport installs methods on this port; it must not replace its identity.
    connect(port);
    const closeTransport = port.close;
    port.close = () => {
      closeTransport();
      for (const stop of observers.values()) stop?.();
      observers.clear();
    };
    for (const message of queued) port.postMessage(message);
    queued.length = 0;
    for (const listener of observers.keys()) {
      const stop = port.observeConnection?.(listener);
      observers.set(listener, stop);
      const isLocalTransport = port.observeConnection === undefined;
      if (isLocalTransport) listener(true);
    }
  }).catch(error => {
    failure = new FirebaseError('unavailable', error instanceof Error ? error.message : String(error));
    rejectPendingRequests(port, failure);
    for (const message of queued.splice(0)) {
      const isSubscription = message.t === 'sub';
      if (isSubscription) port.onmessage?.(new MessageEvent('message', {
        data: { t: 'snap', subId: message.subId, value: { __error: { code: failure.code, message: failure.message } } },
      }));
    }
  });
  return { __kind: 'client-db', port };
}
