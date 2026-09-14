/**
 * Bridge transport helpers shared by the bridge mounts.
 *
 * `attachPeer` adapts a `ws` WebSocket into either a registered sandbox PEER
 * (the browser-side `connectBridge` is the other end — first message
 * `hello`) or a worker-relay CONSUMER (the Node-side `connectRemoteSandbox`
 * — first message `attach`); `collectBody` buffers a Node request body into
 * parsed JSON for the stateless MCP transport.
 *
 * Both are consumed by `serve/bridge-mount.ts` (the `pyric dev --bridge` and
 * `pyric({ bridge })` mount) and `serve/namespace.ts` (capture route).
 * They live here — not inline in a plugin file — so retiring the standalone
 * bridge Vite plugin doesn't drag its consumers with it.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { createBridge, type Bridge } from './bridge.js';
import {
  isBridgeMessage,
  PEER_REPLACED_CLOSE_CODE,
  PEER_REPLACED_CLOSE_REASON,
  type BridgeMessage,
  type RemoteSetLensAckFrame,
  type WorkerResFrame,
} from '../protocol.js';
import { cliVersion } from '../../pkg-version.js';
import type { WorkerSessionLease } from './worker-sessions.js';
import type { InboundMessage } from '../../serve/worker/protocol.js';

const workerMessageTypes: Record<InboundMessage['t'], true> = {
  op: true,
  sub: true,
  unsub: true,
  disconnect: true,
  appConfig: true,
  'clock-subscribe': true,
  tool: true,
};

/** Recognize the envelope before reading its tag; service handlers validate payloads. */
function isWorkerMessageEnvelope(message: unknown): boolean {
  const isMalformedObject = message === null || typeof message !== 'object' || Array.isArray(message);
  if (isMalformedObject) return false;
  const isMissingType = !('t' in message);
  if (isMissingType) return false;
  return typeof message.t === 'string' && Object.hasOwn(workerMessageTypes, message.t);
}

export function attachPeer(
  bridge: ReturnType<typeof createBridge>,
  ws: WebSocket,
  allowSandboxPeer = true,
): void {
  let disconnect: (() => void) | null = null;
  /** Peer generation captured at registration — tags every inbound frame so
   *  a replaced tab's socket can't resolve the NEW peer's calls or deliver
   *  stale subscription snaps (see Bridge.peerGeneration). */
  let peerGen = 0;
  let helloed = false;
  let consumer: ConsumerSession | null = null;

  ws.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const msg = parsed;
    const isUnrecognizedMessage = !isBridgeMessage(msg);
    if (isUnrecognizedMessage) return;
    const isWorkerMessage = msg.type === 'worker-message';
    if (isWorkerMessage) {
      const isMalformedMessage = !isWorkerMessageEnvelope(msg.message);
      if (isMalformedMessage) {
        ws.close(1002, 'Invalid worker message envelope.');
        return;
      }
    }
    const isAttach = msg.type === 'attach';
    if (isAttach) {
      // Worker-relay consumer (Node client). NOT a peer: attaching never
      // kicks the browser tab out of last-connection-wins.
      const isAlreadyAttached = helloed || consumer !== null;
      if (isAlreadyAttached) return;
      const ownsWorkerPort = msg.transport === 'worker-port';
      const requestedSessionId = ownsWorkerPort ? undefined : msg.clientSessionId ?? msg.sessionId;
      consumer = createConsumerSession(
        bridge,
        (out: BridgeMessage) => {
          try {
            ws.send(JSON.stringify(out));
          } catch {}
        },
        requestedSessionId,
      );
      try {
        consumer.handleMessage(msg); // acks with attach-ack
      } catch {
        consumer.dispose();
        ws.close(1008, 'Hosted session admission failed.');
      }
      return;
    }
    const currentConsumer = consumer;
    const hasConsumer = currentConsumer !== null;
    if (hasConsumer) {
      currentConsumer.handleMessage(msg);
      return;
    }
    const isHello = msg.type === 'hello';
    if (isHello) {
      const requiresNodeHost = !allowSandboxPeer;
      if (requiresNodeHost) {
        ws.close(1008, 'This bridge has an authoritative Node sandbox.');
        return;
      }
      if (helloed) return;
      helloed = true;
      const hasToolNames = Array.isArray(msg.tools);
      const tools = hasToolNames ? msg.tools : [];
      const hasCapabilities = Array.isArray(msg.capabilities);
      const capabilities = hasCapabilities ? msg.capabilities : [];
      disconnect = bridge.registerSandboxPeer(
        (out: BridgeMessage) => {
          try {
            ws.send(JSON.stringify(out));
          } catch {}
        },
        // Harden against a malformed hello: these fields come off the wire
        // and feed `new Set(...)` in the bridge core — a non-array value
        // (e.g. `capabilities: 42`) would throw inside this message
        // listener, escape uncaught, and crash the serve process.
        tools,
        msg.sandboxId,
        capabilities,
        // On replacement, close THIS socket: the browser side's onclose
        // handler tears down its relayed worker subscriptions, so a
        // replaced tab's SharedWorker listeners don't keep streaming
        // snaps the bridge drops as stale-generation until the tab closes.
        // The REPLACED close code tells that client to go STANDBY (health-
        // poll for a vacant slot) instead of re-helloing — an immediate
        // re-hello would kick the new peer right back, and two open tabs
        // would fight over the slot forever.
        () => {
          try {
            ws.close(PEER_REPLACED_CLOSE_CODE, PEER_REPLACED_CLOSE_REASON);
          } catch {}
        },
      );
      peerGen = bridge.peerGeneration();
      try {
        ws.send(
          JSON.stringify({
            type: 'hello-ack',
            protocol: 1,
            bridgeVersion: bridge.version,
          }),
        );
      } catch {
        // Socket died between hello and ack — the close handler unwinds.
      }
      bridge.broadcastConsumerPresence();
      return;
    }
    const isUnregistered = !helloed;
    if (isUnregistered) return;
    bridge.handleSandboxMessage(msg, peerGen);
  });

  ws.on('close', () => {
    disconnect?.();
    disconnect = null;
    consumer?.detach();
    consumer = null;
  });
  ws.on('error', () => {});
}

// ── Worker-relay consumer session (transport-agnostic) ───────────────────

/**
 * One attached worker-relay consumer (the Node `connectRemoteSandbox`
 * client). Transport-agnostic — `attachPeer` adapts it onto a `ws` socket;
 * tests drive `handleMessage` directly.
 */
export interface ConsumerSession {
  /** The assigned client session ID for this consumer. */
  readonly clientSessionId: string;
  /** Handle one parsed message from the consumer. */
  handleMessage(msg: BridgeMessage): void;
  /** Detach transport-level subscriptions on temporary socket close without tombstoning the session. */
  detach(): void;
  /** Tear down every subscription this consumer registered. */
  dispose(): void;
}

/**
 * Create a consumer session over `send`. Correlation ids/subIds on this leg
 * are CONSUMER-minted and echoed verbatim; the bridge core mints its own ids
 * for the peer leg (`dispatchWorkerOp` / `subscribeWorker`), so the two legs'
 * id spaces never mix.
 */
export function createConsumerSession(
  bridge: Bridge,
  send: (msg: BridgeMessage) => void,
  initialSessionId?: string,
): ConsumerSession {
  let clientSessionId = initialSessionId ?? randomUUID();
  let disposed = false;
  let ownsWorkerPort = false;
  let workerSession: WorkerSessionLease | null = null;
  /** consumer subId → bridge-side unsubscribe. */
  const subs = new Map<string, () => void>();

  function detach(): void {
    const retainedSession = workerSession;
    const hasRetainedSession = retainedSession !== null;
    if (hasRetainedSession) {
      disposed = true;
      retainedSession.detach();
      return;
    }
    for (const unsubscribe of subs.values()) unsubscribe();
    subs.clear();
    bridge.detachConsumer(clientSessionId);
    bridge.consumers.unregister(clientSessionId);
    bridge.broadcastConsumerPresence();
  }

  function dispose(): void {
    disposed = true;
    const retainedSession = workerSession;
    const hasRetainedSession = retainedSession !== null;
    if (hasRetainedSession) {
      retainedSession.close();
      return;
    }
    for (const unsubscribe of subs.values()) unsubscribe();
    subs.clear();
    bridge.disconnectConsumer(clientSessionId);
    bridge.consumers.unregister(clientSessionId);
    bridge.broadcastConsumerPresence();
  }

  function handleMessage(msg: BridgeMessage): void {
    const isStaleConnection = workerSession !== null && !workerSession.isCurrent();
    if (isStaleConnection) return;
    if (disposed) {
      const isOperation = msg.type === 'worker-op';
      if (isOperation) {
        send({
          type: 'worker-res',
          id: msg.id,
          clientSessionId,
          ok: false,
          error: { code: 'app/app-deleted', message: 'Firebase App was deleted' },
        });
      }
      return;
    }
    bridge.consumers.touch(clientSessionId);
    switch (msg.type) {
      case 'attach': {
        const attachMsg = msg;
        ownsWorkerPort = attachMsg.transport === 'worker-port';
        if (ownsWorkerPort) {
          const hasHostIdentity = typeof attachMsg.hostInstanceId === 'string' && attachMsg.hostInstanceId.length > 0;
          const changedHost = hasHostIdentity && attachMsg.hostInstanceId !== bridge.instanceId;
          let resumeToken = attachMsg.resumeToken;
          if (changedHost) resumeToken = undefined;
          workerSession = bridge.workerSessions.attach(resumeToken);
          clientSessionId = workerSession.clientSessionId;
        }
        const requestedClientId = attachMsg.clientSessionId;
        const requestedAlias = attachMsg.sessionId;
        const mayResumeClientId = !ownsWorkerPort && requestedClientId !== undefined;
        const mayResumeAlias = !ownsWorkerPort && requestedAlias !== undefined;
        if (mayResumeClientId) {
          clientSessionId = requestedClientId;
        } else if (mayResumeAlias) {
          clientSessionId = requestedAlias;
        }
        bridge.consumers.register({
          clientSessionId,
          platform: attachMsg.clientInfo?.platform ?? 'node',
          deviceLabel: attachMsg.clientInfo?.deviceLabel,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
          activeLens: { mode: 'app-session' },
          send,
        });
        send({
          type: 'attach-ack',
          protocol: 1,
          capabilities: bridge.peerCapabilities(),
          projectKey: bridge.projectKey,
          bridgeVersion: bridge.version,
          peerConnected: bridge.isSandboxConnected(),
          sandboxConnected: bridge.isSandboxConnected(),
          serveVersion: cliVersion(),
          clientSessionId,
          sessionId: clientSessionId,
          resumeToken: workerSession?.resumeToken,
          hostInstanceId: bridge.instanceId,
        });
        bridge.broadcastConsumerPresence();
        return;
      }
      case 'remote-set-lens': {
        const frame = msg;
        const ok = bridge.consumers.setLens(frame.clientSessionId, frame.lens);
        bridge.broadcastConsumerPresence();
        const needsAcknowledgement = Boolean(frame.id);
        if (needsAcknowledgement) {
          const acknowledgement: RemoteSetLensAckFrame = {
            type: 'remote-set-lens-ack',
            id: frame.id,
            clientSessionId: frame.clientSessionId,
            ok,
          };
          const wasNotFound = !ok;
          if (wasNotFound) acknowledgement.error = { code: 'not-found', message: 'Client session not found' };
          send(acknowledgement);
        }
        return;
      }
      case 'worker-op': {
        const opSessionId = msg.clientSessionId ?? clientSessionId;
        const opPayload = {
          ...msg.op,
          resumeSession: true,
        };
        bridge.dispatchWorkerOp(opPayload, opSessionId).then(
          (value) => send({ type: 'worker-res', id: msg.id, clientSessionId: opSessionId, ok: true, value }),
          (err: Error & { code?: string; denialContext?: unknown; envelope?: unknown }) => {
            const error: WorkerResFrame['error'] = { code: err.code ?? 'unknown', message: err.message };
            const hasDenialContext = err.denialContext !== undefined;
            if (hasDenialContext) error.denialContext = err.denialContext;
            const hasEnvelope = err.envelope !== undefined;
            if (hasEnvelope) error.envelope = err.envelope;
            send({
              type: 'worker-res',
              id: msg.id,
              clientSessionId: opSessionId,
              ok: false,
              error,
            });
          },
        );
        return;
      }
      case 'worker-message': {
        const usesLegacyRelay = !ownsWorkerPort;
        if (usesLegacyRelay) return;
        const deletesApp = msg.message.t === 'disconnect';
        if (deletesApp) workerSession?.retire();
        bridge.forwardWorkerMessage(msg.message, clientSessionId);
        return;
      }
      case 'worker-sub': {
        const isAlreadySubscribed = subs.has(msg.subId);
        if (isAlreadySubscribed) return;
        const subSessionId = msg.clientSessionId ?? clientSessionId;
        const subPayload = {
          ...msg.sub,
          resumeSession: true,
        };
        const unsubscribe = bridge.subscribeWorker(
          subPayload,
          (value) => send({ type: 'worker-snap', subId: msg.subId, clientSessionId: subSessionId, value }),
          subSessionId,
        );
        subs.set(msg.subId, unsubscribe);
        return;
      }
      case 'worker-unsub': {
        const unsubscribe = subs.get(msg.subId);
        const isUnsubscribed = unsubscribe === undefined;
        if (isUnsubscribed) return;
        subs.delete(msg.subId);
        unsubscribe();
        return;
      }
      case 'worker-client-disconnect': {
        dispose();
        return;
      }
      case 'ping': {
        send({ type: 'pong', id: msg.id });
        return;
      }
      default:
        return; // peer-only or unknown frames — ignore
    }
  }

  return {
    get clientSessionId() {
      return clientSessionId;
    },
    handleMessage,
    detach,
    dispose,
  };
}

/** Thrown by {@link collectBody} when a body exceeds the caller's limit. The
 *  code lets a route answer 413 instead of treating it as malformed JSON. */
export const BODY_TOO_LARGE_CODE = 'PYRIC_BODY_TOO_LARGE';

/**
 * Read a request body and parse it as JSON.
 *
 * `limitBytes` caps how much is buffered. A route that is reachable by
 * anything other than a trusted local caller must pass one: without it a
 * single request can grow the string until the process dies.
 */
export async function collectBody(
  req: IncomingMessage,
  limitBytes?: number,
): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  return await new Promise<unknown>((resolve, reject) => {
    let raw = '';
    let overLimit = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      // Past the limit the rest of the upload is read and discarded rather
      // than the socket being destroyed. Destroying resets the connection, so
      // the caller's 413 would never reach the client.
      if (overLimit) return;
      raw += chunk;
      if (limitBytes === undefined || Buffer.byteLength(raw) <= limitBytes) return;
      overLimit = true;
      raw = '';
      reject(Object.assign(new Error('request body too large'), { code: BODY_TOO_LARGE_CODE }));
    });
    req.on('end', () => {
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
