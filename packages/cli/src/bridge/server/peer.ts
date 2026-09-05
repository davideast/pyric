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
  type AttachFromConsumer,
  type BridgeMessage,
  type RemoteSetLensFrame,
  type WorkerOpFrame,
  type WorkerSubFrame,
} from '../protocol.js';
import { cliVersion } from '../../pkg-version.js';

export function attachPeer(
  bridge: ReturnType<typeof createBridge>,
  ws: WebSocket,
): void {
  let disconnect: (() => void) | null = null;
  /** Peer generation captured at registration — tags every inbound frame so
   *  a replaced tab's socket can't resolve the NEW peer's calls or deliver
   *  stale subscription snaps (see Bridge.peerGeneration). */
  let peerGen = 0;
  let helloed = false;
  let consumer: ConsumerSession | null = null;

  ws.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!isBridgeMessage(msg)) return;
    if (msg.type === 'attach') {
      // Worker-relay consumer (Node client). NOT a peer: attaching never
      // kicks the browser tab out of last-connection-wins.
      if (helloed || consumer) return;
      consumer = createConsumerSession(
        bridge,
        (out: BridgeMessage) => {
          try {
            ws.send(JSON.stringify(out));
          } catch {}
        },
        msg.clientSessionId ?? msg.sessionId,
      );
      consumer.handleMessage(msg); // acks with attach-ack
      return;
    }
    if (consumer) {
      consumer.handleMessage(msg);
      return;
    }
    if (msg.type === 'hello') {
      if (helloed) return;
      helloed = true;
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
        Array.isArray(msg.tools) ? msg.tools : [],
        msg.sandboxId,
        Array.isArray(msg.capabilities) ? msg.capabilities : [],
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
    if (!helloed) return;
    bridge.handleSandboxMessage(msg, peerGen);
  });

  ws.on('close', () => {
    if (disconnect) disconnect();
    disconnect = null;
    if (consumer) consumer.detach();
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
  /** consumer subId → bridge-side unsubscribe. */
  const subs = new Map<string, () => void>();

  function detach(): void {
    for (const unsubscribe of subs.values()) unsubscribe();
    subs.clear();
    bridge.detachConsumer(clientSessionId);
    bridge.consumers.unregister(clientSessionId);
    bridge.broadcastConsumerPresence();
  }

  function dispose(): void {
    disposed = true;
    for (const unsubscribe of subs.values()) unsubscribe();
    subs.clear();
    bridge.disconnectConsumer(clientSessionId);
    bridge.consumers.unregister(clientSessionId);
    bridge.broadcastConsumerPresence();
  }

  function handleMessage(msg: BridgeMessage): void {
    if (disposed) {
      if (msg.type === 'worker-op') {
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
        const attachMsg = msg as AttachFromConsumer;
        if (attachMsg.clientSessionId) {
          clientSessionId = attachMsg.clientSessionId;
        } else if (attachMsg.sessionId) {
          clientSessionId = attachMsg.sessionId;
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
          bridgeVersion: bridge.version,
          peerConnected: bridge.isSandboxConnected(),
          sandboxConnected: bridge.isSandboxConnected(),
          serveVersion: cliVersion(),
          clientSessionId,
          sessionId: clientSessionId,
        });
        bridge.broadcastConsumerPresence();
        return;
      }
      case 'remote-set-lens': {
        const frame = msg as RemoteSetLensFrame;
        const ok = bridge.consumers.setLens(frame.clientSessionId, frame.lens);
        bridge.broadcastConsumerPresence();
        if (frame.id) {
          send({
            type: 'remote-set-lens-ack',
            id: frame.id,
            clientSessionId: frame.clientSessionId,
            ok,
            ...(ok ? {} : { error: { code: 'not-found', message: 'Client session not found' } }),
          });
        }
        return;
      }
      case 'worker-op': {
        const opSessionId = (msg as WorkerOpFrame).clientSessionId ?? clientSessionId;
        const opPayload = {
          ...(msg as WorkerOpFrame).op,
          resumeSession: true,
        };
        bridge.dispatchWorkerOp(opPayload, opSessionId).then(
          (value) => send({ type: 'worker-res', id: msg.id, clientSessionId: opSessionId, ok: true, value }),
          (err: Error & { code?: string; denialContext?: unknown; envelope?: unknown }) =>
            send({
              type: 'worker-res',
              id: msg.id,
              clientSessionId: opSessionId,
              ok: false,
              error: {
                code: err.code ?? 'unknown',
                message: err.message,
                ...(err.denialContext !== undefined ? { denialContext: err.denialContext } : {}),
                ...(err.envelope !== undefined ? { envelope: err.envelope } : {}),
              },
            }),
        );
        return;
      }
      case 'worker-sub': {
        if (subs.has(msg.subId)) return; // idempotent
        const subSessionId = (msg as WorkerSubFrame).clientSessionId ?? clientSessionId;
        const subPayload = {
          ...(msg as WorkerSubFrame).sub,
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
        if (!unsubscribe) return;
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
