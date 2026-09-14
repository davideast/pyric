import { isBridgeMessage, WORKER_PORT_CAPABILITY, type BridgeMessage } from '../../../bridge/protocol.js';
import { FirebaseError } from 'pyric/app';
import type { InboundMessage, OutboundMessage } from '../protocol.js';
import { nextId, rawRpc, rejectPendingRequests, restoreAuthSubscriptions, restoreFirestoreSubscriptions, wirePort } from './core.js';
import type { ClientDb, ClientPort } from './handles.js';

const CONNECTION_LOST = 'The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.';

/** Own one app's physical connections while retaining its logical SDK port. */
export function getHostedFirestore(target: { url: string; projectKey: string }): ClientDb {
  const queued: InboundMessage[] = [];
  const connectionListeners = new Set<(connected: boolean) => void>();
  let state: 'connecting' | 'restoring' | 'attached' | 'interrupted' | 'closed' = 'connecting';
  let socket: WebSocket | undefined;
  let resumeToken: string | undefined;
  let hostInstanceId: string | undefined;
  let appConfig: Extract<InboundMessage, { t: 'appConfig' }> | undefined;
  let needsSessionRestore = false;
  let hasEverAttached = false;
  let reconnectAttempt = 0;
  let attachDeadline: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const port: ClientPort = {
    onmessage: null,
    postMessage(message) {
      const isClosed = state === 'closed';
      if (isClosed) throw new FirebaseError('unavailable', 'The hosted sandbox connection is closed.');
      const configuresApp = message.t === 'appConfig';
      if (configuresApp) appConfig = message;
      const isAttached = state === 'attached';
      const cancelsStartup = !isAttached && message.t === 'disconnect';
      if (cancelsStartup) {
        queued.length = 0;
        deliver({ t: 'res', id: message.id, ok: true, value: undefined });
        return;
      }
      const isInitialStartup = state === 'connecting' && !hasEverAttached;
      const cancelsSubscription = !isAttached && message.t === 'unsub';
      const canQueue = isInitialStartup || cancelsSubscription;
      if (canQueue) {
        queued.push(message);
        return;
      }
      const activeSocket = socket;
      const isUnavailable = !isAttached || activeSocket === undefined;
      if (isUnavailable) throw new FirebaseError('unavailable', 'The hosted sandbox connection is closed.');
      send(activeSocket, { type: 'worker-message', message });
    },
    start() {},
    observeConnection(listener) {
      connectionListeners.add(listener);
      queueMicrotask(() => {
        const isSubscribed = connectionListeners.has(listener);
        if (isSubscribed) {
          const connected = state === 'attached';
          listener(connected);
        }
      });
      return () => { connectionListeners.delete(listener); };
    },
    close() {
      state = 'closed';
      notifyConnectionChange();
      connectionListeners.clear();
      queued.length = 0;
      resumeToken = undefined;
      hostInstanceId = undefined;
      appConfig = undefined;
      port.restoreAuth = undefined;
      clearTimeout(attachDeadline);
      clearTimeout(reconnectTimer);
      const closingSocket = socket;
      socket = undefined;
      const canNotifyHost = closingSocket?.readyState === WebSocket.OPEN;
      try {
        if (canNotifyHost) send(closingSocket, { type: 'worker-message', message: { t: 'disconnect', id: nextId() } });
      } catch {
        // A socket may close before the final notification can be sent.
      }
      closingSocket?.close();
      port.onmessage = null;
    },
  };

  function notifyConnectionChange(): void {
    const connected = state === 'attached';
    for (const listener of [...connectionListeners]) listener(connected);
  }

  function send(connection: WebSocket, message: BridgeMessage): void {
    connection.send(JSON.stringify(message));
  }

  function deliver(message: OutboundMessage): void {
    port.onmessage?.(new MessageEvent('message', { data: message }));
  }

  function failConnection(message: string): void {
    const isClosed = state === 'closed';
    if (isClosed) return;
    port.close();
    rejectPendingRequests(port, new FirebaseError('unavailable', message));
  }

  function isCurrent(connection: WebSocket): boolean {
    return socket === connection && state !== 'closed';
  }

  async function finishAttachment(connection: WebSocket, isResume: boolean): Promise<void> {
    const postMessage = (message: InboundMessage): void => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) throw new FirebaseError('unavailable', CONNECTION_LOST);
      send(connection, { type: 'worker-message', message });
    };
    if (needsSessionRestore) {
      state = 'restoring';
      const configuration = appConfig;
      const hasConfiguration = configuration !== undefined;
      if (hasConfiguration) postMessage(configuration);
      await port.restoreAuth?.(message => rawRpc(port, message, postMessage));
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      restoreAuthSubscriptions(port, postMessage);
      needsSessionRestore = false;
    }
    clearTimeout(attachDeadline);
    state = 'attached';
    hasEverAttached = true;
    reconnectAttempt = 0;
    for (const request of queued.splice(0)) port.postMessage(request);
    if (isResume) {
      postMessage({ t: 'clock-subscribe' });
      restoreFirestoreSubscriptions(port, postMessage);
    }
    notifyConnectionChange();
  }

  function connect(): void {
    const isClosed = state === 'closed';
    if (isClosed) return;
    state = 'connecting';
    const connection = new WebSocket(target.url);
    socket = connection;
    attachDeadline = setTimeout(() => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      if (hasEverAttached) connection.close();
      else failConnection('Timed out connecting to the hosted sandbox.');
    }, 5_000);

    connection.addEventListener('open', () => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      send(connection, { type: 'attach', protocol: 1, transport: 'worker-port', resumeToken, hostInstanceId, clientInfo: { platform: 'browser' } });
    });
    connection.addEventListener('message', (event: MessageEvent<string>) => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        failConnection('The hosted sandbox sent invalid JSON. Requests already sent may have completed; check state before retrying.');
        return;
      }
      const message = parsed;
      const isUnrecognizedFrame = !isBridgeMessage(message);
      if (isUnrecognizedFrame) return;
      switch (message.type) {
        case 'attach-ack': {
          const isIncompatibleHost = message.capabilities?.includes(WORKER_PORT_CAPABILITY) !== true;
          if (isIncompatibleHost) {
            failConnection('The selected host does not support browser worker ports.');
            return;
          }
          const isDifferentProject = message.projectKey !== target.projectKey;
          if (isDifferentProject) {
            failConnection('The selected hosted sandbox belongs to a different project.');
            return;
          }
          const isResume = hasEverAttached;
          const hasHostIdentity = typeof message.hostInstanceId === 'string' && message.hostInstanceId.length > 0;
          const changedHost = isResume && hostInstanceId !== undefined && hasHostIdentity && message.hostInstanceId !== hostInstanceId;
          const changedSessionUnexpectedly = isResume && message.resumeToken !== resumeToken && !changedHost;
          if (changedSessionUnexpectedly) {
            failConnection('The hosted session could not be resumed.');
            return;
          }
          const hasResumeToken = typeof message.resumeToken === 'string' && message.resumeToken.length > 0;
          resumeToken = hasResumeToken ? message.resumeToken : undefined;
          hostInstanceId = hasHostIdentity ? message.hostInstanceId : undefined;
          if (changedHost) needsSessionRestore = true;
          void finishAttachment(connection, isResume).catch(() => {
            const isCurrentConnection = isCurrent(connection);
            if (isCurrentConnection) failConnection('Could not restore the hosted app session.');
          });
          return;
        }
        case 'worker-message-result':
          deliver(message.message);
          return;
      }
    });
    connection.addEventListener('close', (event) => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      clearTimeout(attachDeadline);
      const canResume = hasEverAttached && resumeToken !== undefined && event.code !== 1008;
      if (canResume) {
        state = 'interrupted';
        socket = undefined;
        notifyConnectionChange();
        rejectPendingRequests(port, new FirebaseError('unavailable', CONNECTION_LOST));
        const delay = Math.min(5_000, 250 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        const jitter = Math.random() * Math.min(250, delay / 10);
        reconnectTimer = setTimeout(connect, Math.min(5_000, delay + jitter));
      } else {
        failConnection(CONNECTION_LOST);
      }
    });
  }

  const db = { __kind: 'client-db', port } satisfies ClientDb;
  wirePort(port);
  connect();
  return db;
}
