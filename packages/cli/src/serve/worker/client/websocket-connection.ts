import type { DiagnosticEvent } from '../../runtime/diagnostics-report.js';
import { recordDiagnostic } from '../../runtime/diagnostics-client.js';
import { hasValidAttachFields } from '../../../bridge/attach-validation.js';
import { isBridgeMessage, MAX_BRIDGE_FRAME_BYTES, WORKER_PORT_CAPABILITY, WORKER_SESSION_EXPIRED_CLOSE_CODE, WORKER_SESSION_RETENTION_MS, type BridgeMessage } from '../../../bridge/protocol.js';
import { FirebaseError } from 'pyric/app';
import { BROWSER_FRAME_LIMIT_CLOSE_CODE, BRIDGE_FRAME_LIMIT_MESSAGE, encodeBridgeMessage } from '../../../bridge/frame-output.js';
import type { InboundMessage, OutboundMessage } from '../protocol.js';
import { hasValidOutboundEnvelope, hasValidReplyOutcome } from '../outbound-validation.js';
import { nextId, rawRpc, rejectPendingRequests, restoreAuthSubscriptions, restoreFirestoreSubscriptions, restoreMessagingSubscriptions, wirePort } from './core.js';
import type { ClientDb, ClientPort } from './handles.js';

const CONNECTION_LOST = 'The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.';
const HEARTBEAT_INTERVAL_MS = 15_000;
const LIVENESS_TIMEOUT_MS = 45_000;
const utf8 = new TextEncoder();

export type HostedConnectionState = 'connecting' | 'restoring' | 'attached' | 'interrupted' | 'closed';

/** Own one app's physical connections while retaining its logical SDK port. */
export function getHostedFirestore(target: { url: string; projectKey: string; onConnection?: (state: HostedConnectionState) => void; onError?: (error: FirebaseError) => void }): ClientDb {
  const connectionId = `socket-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const report = (phase: DiagnosticEvent['phase'], code?: number) => {
    recordDiagnostic({ phase, connectionId, endpoint: target.url, code });
  };
  const queued: InboundMessage[] = [];
  const connectionListeners = new Set<(connected: boolean) => void>();
  let state: HostedConnectionState = 'connecting';
  let socket: WebSocket | undefined;
  let resumeToken: string | undefined;
  let hostInstanceId: string | undefined;
  let appConfig: Extract<InboundMessage, { t: 'appConfig' }> | undefined;
  let needsSessionRestore = false;
  let hasEverAttached = false;
  let reconnectAttempt = 0;
  let interruptedAt: number | undefined;
  let attachDeadline: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReceivedAt = 0;

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
        encodeRequest({ type: 'worker-message', message });
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
      interruptedAt = undefined;
      hostInstanceId = undefined;
      appConfig = undefined;
      port.restoreAuth = undefined;
      port.messagingVisibility = undefined;
      clearTimeout(attachDeadline);
      clearTimeout(reconnectTimer);
      clearTimeout(heartbeatTimer);
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
    report(state);
    target.onConnection?.(state);
    const connected = state === 'attached';
    for (const listener of [...connectionListeners]) listener(connected);
  }

  function encodeRequest(message: BridgeMessage): string {
    const payload = encodeBridgeMessage(message);
    const exceedsFrameLimit = payload === undefined;
    if (exceedsFrameLimit) throw new FirebaseError('resource-exhausted', 'Bridge request exceeds the 12 MiB encoded frame limit.');
    return payload;
  }

  function send(connection: WebSocket, message: BridgeMessage): void {
    connection.send(encodeRequest(message));
  }

  function deliver(message: OutboundMessage): void {
    port.onmessage?.(new MessageEvent('message', { data: message }));
  }

  function failConnection(message: string): void {
    const isClosed = state === 'closed';
    if (isClosed) return;
    port.close();
    const error = new FirebaseError('unavailable', message);
    target.onError?.(error);
    rejectPendingRequests(port, error);
  }

  function isCurrent(connection: WebSocket): boolean {
    return socket === connection && state !== 'closed';
  }

  function interruptConnection(connection: WebSocket): void {
    const isStaleConnection = !isCurrent(connection);
    if (isStaleConnection) return;
    clearTimeout(attachDeadline);
    clearTimeout(heartbeatTimer);
    interruptedAt ??= performance.now();
    state = 'interrupted';
    socket = undefined;
    notifyConnectionChange();
    rejectPendingRequests(port, new FirebaseError('unavailable', CONNECTION_LOST));
    connection.close();
    const delay = Math.min(5_000, 250 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    const jitter = Math.random() * Math.min(250, delay / 10);
    reconnectTimer = setTimeout(connect, Math.min(5_000, delay + jitter));
  }

  function scheduleHeartbeat(connection: WebSocket): void {
    const remainingLiveness = LIVENESS_TIMEOUT_MS - (performance.now() - lastReceivedAt);
    const delay = Math.max(0, Math.min(HEARTBEAT_INTERVAL_MS, remainingLiveness));
    heartbeatTimer = setTimeout(() => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      const hasLostLiveness = performance.now() - lastReceivedAt >= LIVENESS_TIMEOUT_MS;
      if (hasLostLiveness) {
        interruptConnection(connection);
        return;
      }
      try {
        send(connection, { type: 'ping', id: nextId() });
      } catch {
        interruptConnection(connection);
        return;
      }
      scheduleHeartbeat(connection);
    }, delay);
  }

  async function finishAttachment(connection: WebSocket, isResume: boolean): Promise<void> {
    const postMessage = (message: InboundMessage): void => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) throw new FirebaseError('unavailable', CONNECTION_LOST);
      send(connection, { type: 'worker-message', message });
    };
    if (needsSessionRestore) {
      state = 'restoring';
      report(state);
      target.onConnection?.(state);
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
    interruptedAt = undefined;
    lastReceivedAt = performance.now();
    clearTimeout(heartbeatTimer);
    scheduleHeartbeat(connection);
    for (const request of queued.splice(0)) port.postMessage(request);
    if (isResume) {
      postMessage({ t: 'clock-subscribe' });
      restoreFirestoreSubscriptions(port, postMessage);
      restoreMessagingSubscriptions(port, postMessage);
    }
    notifyConnectionChange();
  }

  function connect(): void {
    const isClosed = state === 'closed';
    if (isClosed) return;
    state = 'connecting';
    report('connecting');
    const connectionState = hasEverAttached ? 'interrupted' : 'connecting';
    target.onConnection?.(connectionState);
    const retentionExpired = interruptedAt !== undefined && performance.now() - interruptedAt >= WORKER_SESSION_RETENTION_MS;
    if (retentionExpired) resumeToken = undefined;
    const requestsFreshSession = resumeToken === undefined;
    let connection: WebSocket;
    try { connection = new WebSocket(target.url); }
    catch (error) { report('socket-error'); throw error; }
    socket = connection;
    attachDeadline = setTimeout(() => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      report('timeout');
      if (hasEverAttached) connection.close();
      else failConnection('Timed out connecting to the hosted sandbox.');
    }, 5_000);

    connection.addEventListener('error', () => {
      const isActiveConnection = isCurrent(connection);
      if (isActiveConnection) report('socket-error');
    });
    connection.addEventListener('open', () => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      report('transport-open');
      send(connection, { type: 'attach', protocol: 1, transport: 'worker-port', resumeToken, hostInstanceId, clientInfo: { platform: 'browser' } });
    });
    connection.addEventListener('message', (event: MessageEvent<string>) => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      const exceedsFrameLimit = utf8.encode(event.data).byteLength > MAX_BRIDGE_FRAME_BYTES;
      if (exceedsFrameLimit) {
        connection.close(BROWSER_FRAME_LIMIT_CLOSE_CODE, BRIDGE_FRAME_LIMIT_MESSAGE);
        failConnection(BRIDGE_FRAME_LIMIT_MESSAGE);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        failConnection('The hosted sandbox sent invalid JSON. Requests already sent may have completed; check state before retrying.');
        return;
      }
      const message = parsed;
      const isUnrecognizedFrame = !isBridgeMessage(message);
      if (isUnrecognizedFrame) {
        failConnection('The hosted sandbox sent an invalid message. Requests already sent may have completed; check state before retrying.');
        return;
      }
      lastReceivedAt = performance.now();
      switch (message.type) {
        case 'attach-ack': {
          const isUnsupportedProtocol = message.protocol !== 1;
          if (isUnsupportedProtocol) {
            failConnection('The hosted sandbox uses an unsupported bridge protocol. Expected version 1.');
            return;
          }
          const capabilities = message.capabilities;
          const hasCapabilityList = Array.isArray(capabilities);
          const hasNamedCapabilities = hasCapabilityList && capabilities.every(capability => typeof capability === 'string');
          const supportsWorkerPorts = hasNamedCapabilities && capabilities.includes(WORKER_PORT_CAPABILITY);
          const isIncompatibleHost = !supportsWorkerPorts;
          if (isIncompatibleHost) {
            failConnection('The selected host does not support browser worker ports. Upgrade @pyric/cli, restart with --hosted, and reload this page.');
            return;
          }
          const isDifferentProject = message.projectKey !== target.projectKey;
          if (isDifferentProject) {
            failConnection('The selected hosted sandbox belongs to a different project.');
            return;
          }
          const hasMalformedAttachment = !hasValidAttachFields(message);
          if (hasMalformedAttachment) {
            failConnection('The hosted sandbox sent a malformed attachment acknowledgment.');
            return;
          }
          const isResume = hasEverAttached;
          const hasHostIdentity = typeof message.hostInstanceId === 'string' && message.hostInstanceId.length > 0;
          const changedHost = isResume && hostInstanceId !== undefined && hasHostIdentity && message.hostInstanceId !== hostInstanceId;
          const attemptsResume = isResume && !requestsFreshSession;
          const receivedDifferentGrant = message.resumeToken !== resumeToken;
          const changedSessionUnexpectedly = attemptsResume && receivedDifferentGrant && !changedHost;
          if (changedSessionUnexpectedly) {
            failConnection('The hosted session could not be resumed.');
            return;
          }
          const hasResumeToken = typeof message.resumeToken === 'string' && message.resumeToken.length > 0;
          resumeToken = hasResumeToken ? message.resumeToken : undefined;
          hostInstanceId = hasHostIdentity ? message.hostInstanceId : undefined;
          const restoresSession = isResume && (changedHost || requestsFreshSession);
          if (restoresSession) needsSessionRestore = true;
          void finishAttachment(connection, isResume).catch(() => {
            const isCurrentConnection = isCurrent(connection);
            if (isCurrentConnection) failConnection('Could not restore the hosted app session.');
          });
          return;
        }
        case 'worker-message-result': {
          const response = message.message;
          const isResponse = hasValidOutboundEnvelope(response) && response.t === 'res';
          const hasError = isResponse && hasValidReplyOutcome(response) && response.ok === false;
          if (hasError) {
            const isPersistenceFailure = response.error.code === 'committed-but-not-durable' || response.error.code === 'persistence-unhealthy';
            if (isPersistenceFailure) target.onError?.(new FirebaseError(response.error.code, response.error.message));
          }
          deliver(response);
          return;
        }
      }
    });
    connection.addEventListener('close', (event) => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      report('socket-close', event.code);
      clearTimeout(attachDeadline);
      const hasExpiredSession = hasEverAttached && event.code === WORKER_SESSION_EXPIRED_CLOSE_CODE;
      if (hasExpiredSession) resumeToken = undefined;
      const canResume = hasEverAttached && event.code !== 1008;
      if (canResume) {
        interruptConnection(connection);
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
