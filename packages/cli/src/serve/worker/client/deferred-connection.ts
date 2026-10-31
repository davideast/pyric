import { FirebaseError } from 'pyric/app';
import type { InboundMessage } from '../protocol.js';
import type { ClientDb, ClientPort } from './handles.js';
import { endPortSubscriptions, forgetOnDisconnectCalls, rejectPendingRequests, wirePort } from './core.js';
import { closeSendOrder } from './send-order.js';

type TransportChoice = Promise<(port: ClientPort) => ClientDb>;

/** Whether a frame needs the transport: an operation or a subscription, not app configuration or the clock. */
function needsTransport(message: InboundMessage): boolean {
  return message.t === 'op' || message.t === 'sub';
}

/** A transport that refuses with its own code keeps it (a Node process off the Node host, #1082). */
function choiceFailure(error: unknown): FirebaseError {
  const isFirebaseError = error instanceof FirebaseError;
  if (isFirebaseError) return error;
  return new FirebaseError('unavailable', error instanceof Error ? error.message : String(error));
}

/**
 * Keep SDK handles and correlations on one port while choosing its transport.
 * Given a function, the choice starts at the first operation or subscription,
 * so a handle no call uses opens nothing (a Node process, #1082). A function
 * choice that fails fails the calls waiting on it, and the next call chooses
 * again, so a process started before its host reaches it once the host is up.
 * A promise choice is made once: a page's transport does not change.
 */
export function getDeferredFirestore(choice: TransportChoice | (() => TransportChoice)): ClientDb {
  const choosesAgain = typeof choice === 'function';
  const queued: InboundMessage[] = [];
  const observers = new Map<(connected: boolean) => void, (() => void) | undefined>();
  let closed = false;
  let failure: FirebaseError | undefined;
  let chosen = false;
  /** The choice in progress, or the one made; it settles with its failure, if any. */
  let attempt: Promise<FirebaseError | undefined> | undefined;
  // Until the transport is chosen nobody knows its byte route; after, the
  // transport answers (the hosted one installs its own on this port).
  const awaitTransportRoute = async (): Promise<void> => {
    // Asking for the route is a call about to send; it starts the choice.
    const failed = await startChoice();
    if (failed !== undefined) throw failed;
    const ownsRouteAnswer = port.byteRouteSettled === pendingRoute;
    if (ownsRouteAnswer) return;
    await port.byteRouteSettled?.();
  };
  const pendingRoute = (): Promise<void> | undefined => {
    if (chosen) return undefined;
    const route = awaitTransportRoute();
    // A caller may only ask whether the route is known; the call that sends hears the failure.
    route.catch(() => undefined);
    return route;
  };
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
      if (needsTransport(message)) void startChoice();
    },
    start() {},
    observeConnection(listener) {
      // Watching the connection (`.info/connected`) needs one.
      void startChoice();
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
      forgetOnDisconnectCalls(port);
      rejectPendingRequests(port, closedError);
      endPortSubscriptions(port, new FirebaseError('aborted', 'The operation was aborted.'), closedError);
      port.onmessage = null;
    },
  };
  wirePort(port);

  function connectTransport(connect: (port: ClientPort) => ClientDb): undefined {
    chosen = true;
    if (closed) return undefined;
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
    return undefined;
  }

  /** Fails what waits on this choice. A promise choice fails every later call too. */
  function failChoice(error: unknown): FirebaseError {
    const failed = choiceFailure(error);
    if (choosesAgain) {
      attempt = undefined;
    } else {
      chosen = true;
      failure = failed;
      closeSendOrder(port);
    }
    rejectPendingRequests(port, failed);
    // Calls fail. App configuration stays queued for the next choice to send first.
    const waiting = queued.splice(0);
    if (choosesAgain) queued.push(...waiting.filter(message => !needsTransport(message)));
    for (const message of waiting) {
      const isSubscription = message.t === 'sub';
      if (isSubscription) port.onmessage?.(new MessageEvent('message', {
        data: { t: 'snap', subId: message.subId, value: { __error: { code: failed.code, message: failed.message } } },
      }));
    }
    endPortSubscriptions(port, failed);
    return failed;
  }

  function startChoice(): Promise<FirebaseError | undefined> {
    if (attempt !== undefined) return attempt;
    const choosing = choosesAgain ? choice() : choice;
    const started = choosing.then(connectTransport).catch(failChoice);
    attempt = started;
    return started;
  }

  if (!choosesAgain) void startChoice();
  return { __kind: 'client-db', port };
}
