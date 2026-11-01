import type { DiagnosticEvent } from '../../runtime/diagnostics-report.js';
import { recordDiagnostic } from '../../runtime/diagnostics-client.js';
import { hasValidAttachFields } from '../../../bridge/attach-validation.js';
import { HOSTED_CLIENT_LIVENESS_TIMEOUT_MS, HOSTED_HEARTBEAT_INTERVAL_MS, isBridgeMessage, MAX_BRIDGE_FRAME_BYTES, STORAGE_BYTE_ROUTE_CAPABILITY, WORKER_PORT_CAPABILITY, WORKER_SESSION_EXPIRED_CLOSE_CODE, WORKER_SESSION_RETENTION_MS, type BridgeMessage } from '../../../bridge/protocol.js';
import { FirebaseError } from 'pyric/app';
import { BROWSER_FRAME_LIMIT_CLOSE_CODE, BRIDGE_FRAME_LIMIT_MESSAGE, encodeBridgeMessage } from '../../../bridge/frame-output.js';
import type { InboundMessage, OutboundMessage } from '../protocol.js';
import { hasValidOutboundEnvelope, hasValidReplyOutcome } from '../outbound-validation.js';
import { _pending, failInFlightStreams, forgetOnDisconnectCalls, nextId, rawRpc, rejectPendingRequests, restoreAuthSubscriptions, restoreObservationSubscriptions, restoreMessagingSubscriptions, wirePort } from './core.js';
import { endFailedPort } from './disconnect.js';
import type { ClientDb, ClientPort } from './handles.js';
import { createHeldMessages } from './held-messages.js';
import { settleInFlightAtDrop } from './in-flight-at-drop.js';
import { closeSendOrder, waitsToSend } from './send-order.js';

/** The HTTP origin that serves a WebSocket endpoint. */
function httpOriginOf(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

const CONNECTION_LOST = 'The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.';
const CONNECTION_CLOSED = 'The hosted sandbox connection is closed.';
const utf8 = new TextEncoder();

export type HostedConnectionState = 'connecting' | 'restoring' | 'attached' | 'interrupted' | 'closed';

/**
 * How a hosted connection behaves outside a page. A page leaves it out and
 * gets the global `WebSocket`, timers that keep the page as browsers do, and
 * `clientInfo.platform: 'browser'`. A Node process the register bootstrap
 * activated (#1082) supplies one, so the connection's own socket and timers do
 * not keep the process alive by themselves, and the realm decides from the
 * traffic when the process should stay up.
 */
export interface HostedSocketRealm {
  readonly platform: 'node';
  createSocket(url: string): WebSocket;
  /** Every timer the connection arms; the realm may stop it holding the process. */
  releaseTimer(timer: ReturnType<typeof setTimeout>): void;
  /** After a frame is sent or delivered, and when the connection closes or drops. */
  traffic(port: ClientPort, event: { sent?: InboundMessage; closed?: boolean }): void;
  /** The host's attach acknowledgment, for its version stamp. */
  attached?(ack: { serveVersion?: unknown }): void;
}

/** Own one app's physical connections while retaining its logical SDK port. */
export function getHostedFirestore(target: {
  url: string;
  projectKey: string;
  retryInitialConnection?: boolean;
  onConnection?: (state: HostedConnectionState) => void;
  onError?: (error: FirebaseError) => void;
  /** The page's session token, which authorizes its own reads on the host's byte route. */
  sessionToken?: () => Promise<string | null>;
  /** Present outside a page; see {@link HostedSocketRealm}. */
  realm?: HostedSocketRealm;
  /** Host boot identity baked into the served HTML / module at compile time. */
  initialHostInstanceId?: string;
  /**
   * Reads the boot id of the host now serving the url, before a reattach. A
   * Node process passes it: it reads init.json again, so after a host restart
   * it presents the new boot and the host holds its config as verified. A page
   * passes nothing and presents the boot it was served by (#1153).
   */
  currentHostInstanceId?: () => Promise<string | undefined>;
  /**
   * Resolves the socket url again before a reattach. A Node process passes it:
   * a host that stopped may come back on another port, which its
   * `.pyric/serve.json` names. A page passes nothing and redials its own origin.
   */
  currentUrl?: () => Promise<string>;
}, existingPort?: ClientPort): ClientDb {
  const connectionId = `socket-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  /** The url the next socket dials; a reattach may resolve it again. */
  let socketUrl = target.url;
  const report = (phase: DiagnosticEvent['phase'], code?: number) => {
    recordDiagnostic({ phase, connectionId, endpoint: socketUrl, code });
  };
  const connectionListeners = new Set<(connected: boolean) => void>();
  let state: HostedConnectionState = 'connecting';
  let socket: WebSocket | undefined;
  let resumeToken: string | undefined;
  let hostInstanceId: string | undefined = target.initialHostInstanceId;
  let fromPriorHost = false;
  let appConfig: Extract<InboundMessage, { t: 'appConfig' }> | undefined;
  let needsSessionRestore = false;
  let hasEverAttached = false;
  let reconnectAttempt = 0;
  let interruptedAt: number | undefined;
  let attachDeadline: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReceivedAt = 0;
  const realm = target.realm;
  // Settles once the first attachment says whether the host has a byte route,
  // or the connection ends without one; Storage waits on it before choosing.
  let byteRouteKnown = false;
  let resolveByteRoute: () => void = () => {};
  const byteRouteSettled = new Promise<void>(resolve => { resolveByteRoute = resolve; });
  const settleByteRoute = (): void => {
    byteRouteKnown = true;
    resolveByteRoute();
  };
  const armed = <T extends ReturnType<typeof setTimeout>>(timer: T): T => {
    realm?.releaseTimer(timer);
    return timer;
  };
  const noteTraffic = (event: { sent?: InboundMessage; closed?: boolean }): void => {
    realm?.traffic(port, event);
  };

  const port: ClientPort = Object.assign(existingPort ?? {}, {
    onmessage: existingPort?.onmessage ?? null,
    postMessage(message) {
      const isClosed = state === 'closed';
      if (isClosed) throw new FirebaseError('unavailable', CONNECTION_CLOSED);
      const configuresApp = message.t === 'appConfig';
      if (configuresApp) appConfig = message;
      noteTraffic({ sent: message });
      const isAttached = state === 'attached';
      const cancelsWhileDetached = !isAttached && message.t === 'disconnect';
      if (cancelsWhileDetached) {
        // The app is being deleted; its teardown fails the held operations.
        held.drop();
        deliver({ t: 'res', id: message.id, ok: true, value: undefined });
        return;
      }
      const isDetached = !isAttached;
      if (isDetached) {
        const isSettledOperation = (message.t === 'op' || message.t === 'tool') && !_pending.has(message.id);
        if (isSettledOperation) return;
        encodeRequest({ type: 'worker-message', message });
        held.hold(message);
        return;
      }
      const activeSocket = socket;
      const hasNoSocket = activeSocket === undefined;
      if (hasNoSocket) throw new FirebaseError('unavailable', CONNECTION_CLOSED);
      send(activeSocket, { type: 'worker-message', message });
    },
    start() {},
    withdrawSubscription(subId) {
      return held.forgetSubscription(subId);
    },
    byteRouteSettled() {
      return byteRouteKnown ? undefined : byteRouteSettled;
    },
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
      closePort(new FirebaseError('unavailable', CONNECTION_CLOSED));
    },
  } satisfies ClientPort);
  const held = createHeldMessages(port);

  function closePort(error: FirebaseError): void {
    const isAlreadyClosed = state === 'closed';
    if (isAlreadyClosed) return;
    state = 'closed';
    notifyConnectionChange();
    connectionListeners.clear();
    closeSendOrder(port);
    forgetOnDisconnectCalls(port);
    held.fail(error);
    rejectPendingRequests(port, error);
    endFailedPort(port, error);
    resumeToken = undefined;
    interruptedAt = undefined;
    hostInstanceId = undefined;
    fromPriorHost = false;
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
    settleByteRoute();
    noteTraffic({ closed: true });
  }

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
    noteTraffic({});
  }

  function failConnection(message: string): void {
    const isClosed = state === 'closed';
    if (isClosed) return;
    const error = new FirebaseError('unavailable', message);
    // Held, in-flight, and subscription listeners all end once with this error (D6).
    closePort(error);
    target.onError?.(error);
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
    // Only requests already handed to the socket are settled; held ones wait for the next attach.
    const lost = new FirebaseError('unavailable', CONNECTION_LOST);
    settleInFlightAtDrop(port, held, lost, id => !held.holdsRequest(id) && !waitsToSend(port, id));
    // An AI stream is not restored, so one the socket took fails like an operation in flight.
    failInFlightStreams(port, lost, subId => held.holdsSubscription({ t: 'unsub', subId }));
    noteTraffic({});
    connection.close();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    const delay = Math.min(5_000, 250 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    const jitter = Math.random() * Math.min(250, delay / 10);
    reconnectTimer = armed(setTimeout(connect, Math.min(5_000, delay + jitter)));
  }

  /** A reattach whose url could not be resolved (no host answers yet) tries again on the same backoff. */
  function retryResolution(): void {
    const isClosed = state === 'closed';
    if (isClosed) return;
    state = 'interrupted';
    notifyConnectionChange();
    scheduleReconnect();
  }

  function scheduleHeartbeat(connection: WebSocket): void {
    const remainingLiveness = HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - (performance.now() - lastReceivedAt);
    const delay = Math.max(0, Math.min(HOSTED_HEARTBEAT_INTERVAL_MS, remainingLiveness));
    heartbeatTimer = armed(setTimeout(() => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      const hasLostLiveness = performance.now() - lastReceivedAt >= HOSTED_CLIENT_LIVENESS_TIMEOUT_MS;
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
    }, delay));
  }

  async function finishAttachment(connection: WebSocket, isResume: boolean): Promise<void> {
    const needsMessagingRestore = isResume || reconnectAttempt > 0;
    const postMessage = (message: InboundMessage): void => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) throw new FirebaseError('unavailable', CONNECTION_LOST);
      send(connection, { type: 'worker-message', message });
    };
    // A subscription opened while detached is sent once, from the held messages.
    const replay = (message: InboundMessage): void => {
      const isHeldSubscription = held.holdsSubscription(message);
      if (isHeldSubscription) return;
      postMessage(message);
    };
    if (needsSessionRestore) {
      state = 'restoring';
      report(state);
      target.onConnection?.(state);
      const configuration = appConfig;
      const hasConfiguration = configuration !== undefined;
      if (hasConfiguration) {
        postMessage(fromPriorHost ? { ...configuration, fromPriorHost: true } : configuration);
      }
      await port.restoreAuth?.(message => rawRpc(port, message, postMessage));
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      restoreAuthSubscriptions(port, replay);
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
    if (isResume) {
      postMessage({ t: 'clock-subscribe' });
      restoreObservationSubscriptions(port, replay);
    }
    if (needsMessagingRestore) restoreMessagingSubscriptions(port, replay);
    // Held messages follow the whole restore, in the order the app issued them.
    held.flush(postMessage);
    notifyConnectionChange();
  }

  /** The boot to present on attach: the current one when it can be read on a reattach, else the last one attached. */
  async function presentHostIdentity(): Promise<string | undefined> {
    const readCurrent = target.currentHostInstanceId;
    const readsCurrentBoot = hasEverAttached && readCurrent !== undefined;
    if (!readsCurrentBoot) return hostInstanceId;
    try {
      return (await readCurrent()) ?? hostInstanceId;
    } catch {
      return hostInstanceId;
    }
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
    const resolveUrl = target.currentUrl;
    const resolvesAgain = hasEverAttached && resolveUrl !== undefined;
    if (!resolvesAgain) {
      openSocket(requestsFreshSession);
      return;
    }
    void resolveUrl().then(url => {
      const isClosedMeanwhile = state === 'closed';
      if (isClosedMeanwhile) return;
      socketUrl = url;
      openSocket(requestsFreshSession);
    }, retryResolution);
  }

  function openSocket(requestsFreshSession: boolean): void {
    let connection: WebSocket;
    try { connection = realm ? realm.createSocket(socketUrl) : new WebSocket(socketUrl); }
    catch (error) { report('socket-error'); throw error; }
    socket = connection;
    attachDeadline = armed(setTimeout(() => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      report('timeout');
      const shouldRetry = hasEverAttached || target.retryInitialConnection === true;
      if (shouldRetry) interruptConnection(connection);
      else failConnection('Timed out connecting to the hosted sandbox.');
    }, 5_000));

    connection.addEventListener('error', () => {
      const isActiveConnection = isCurrent(connection);
      if (isActiveConnection) report('socket-error');
    });
    let presentedHostInstanceId = hostInstanceId;
    connection.addEventListener('open', () => {
      const isStaleConnection = !isCurrent(connection);
      if (isStaleConnection) return;
      report('transport-open');
      void presentHostIdentity().then(presented => {
        const isStale = !isCurrent(connection);
        if (isStale) return;
        presentedHostInstanceId = presented;
        // A grant from another boot cannot resume on this one; attach for a fresh session.
        const presentsOtherBoot = presented !== hostInstanceId;
        if (presentsOtherBoot) resumeToken = undefined;
        send(connection, { type: 'attach', protocol: 1, transport: 'worker-port', resumeToken, hostInstanceId: presented, clientInfo: { platform: realm?.platform ?? 'browser' } });
      });
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
          // Storage bytes move over the host's HTTP byte route when it offers one.
          const offersByteRoute = capabilities.includes(STORAGE_BYTE_ROUTE_CAPABILITY);
          const sessionToken = target.sessionToken;
          const usesByteRoute = offersByteRoute && sessionToken !== undefined;
          if (usesByteRoute) port.byteRoute = { baseUrl: httpOriginOf(socketUrl), sessionToken };
          else delete port.byteRoute;
          settleByteRoute();
          realm?.attached?.(message);
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
          const presentedThisHost = hasHostIdentity && message.hostInstanceId === presentedHostInstanceId;
          if (changedHost && !presentedThisHost) fromPriorHost = true;
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
      const permitsRetry = hasEverAttached || target.retryInitialConnection === true;
      const canResume = permitsRetry && event.code !== 1008;
      if (canResume) {
        interruptConnection(connection);
      } else {
        failConnection(CONNECTION_LOST);
      }
    });
  }

  const db = { __kind: 'client-db', port } satisfies ClientDb;
  if (!existingPort) wirePort(port);
  connect();
  return db;
}
