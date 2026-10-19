import { FirebaseError } from 'pyric/app';
import type { InboundMessage } from '../protocol.js';
import type { ClientDb, ClientPort } from './handles.js';
import { endPortSubscriptions, rejectPendingRequests, wirePort } from './core.js';
import { closeSendOrder } from './send-order.js';

/** Keep SDK handles and correlations on one port while choosing its transport. */
export function getDeferredFirestore(connection: Promise<(port: ClientPort) => ClientDb>): ClientDb {
  const queued: InboundMessage[] = [];
  const observers = new Map<(connected: boolean) => void, (() => void) | undefined>();
  let closed = false;
  let failure: FirebaseError | undefined;
  let chosen = false;
  // Until the transport is chosen nobody knows its byte route; after, the
  // transport answers (the hosted one installs its own on this port).
  const awaitTransportRoute = async (): Promise<void> => {
    await transportChosen;
    const ownsRouteAnswer = port.byteRouteSettled === pendingRoute;
    if (ownsRouteAnswer) return;
    await port.byteRouteSettled?.();
  };
  const pendingRoute = (): Promise<void> | undefined => (chosen ? undefined : awaitTransportRoute());
  const port: ClientPort = {
    byteRouteSettled: pendingRoute,
    onmessage: null,
    postMessage(message) {
      // Deleting the app settles even when the transport could not be chosen.
      const cancelsStartup = message.t === 'disconnect';
      if (!cancelsStartup && failure) throw failure;
      if (!cancelsStartup && closed) throw new FirebaseError('app/app-deleted', 'Firebase App was deleted');
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
    close() {
      closed = true;
      queued.length = 0;
      observers.clear();
      closeSendOrder(port);
      const closedError = new FirebaseError('app/app-deleted', 'Firebase App was deleted');
      rejectPendingRequests(port, closedError);
      endPortSubscriptions(port, new FirebaseError('aborted', 'The operation was aborted.'), closedError);
      port.onmessage = null;
    },
  };
  wirePort(port);
  const transportChosen = connection.then(connect => {
    chosen = true;
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
    chosen = true;
    // A transport that refuses with its own code keeps it (a Node process off the Node host, #1082).
    const isFirebaseError = error instanceof FirebaseError;
    failure = isFirebaseError ? error : new FirebaseError('unavailable', error instanceof Error ? error.message : String(error));
    closeSendOrder(port);
    rejectPendingRequests(port, failure);
    for (const message of queued.splice(0)) {
      const isSubscription = message.t === 'sub';
      if (isSubscription) port.onmessage?.(new MessageEvent('message', {
        data: { t: 'snap', subId: message.subId, value: { __error: { code: failure.code, message: failure.message } } },
      }));
    }
    endPortSubscriptions(port, failure);
  });
  return { __kind: 'client-db', port };
}
