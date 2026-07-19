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
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { createBridge, type Bridge } from './bridge.js';
import {
  isBridgeMessage,
  PEER_REPLACED_CLOSE_CODE,
  PEER_REPLACED_CLOSE_REASON,
  type BridgeMessage,
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
      consumer = createConsumerSession(bridge, (out: BridgeMessage) => {
        try {
          ws.send(JSON.stringify(out));
        } catch {}
      });
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
      return;
    }
    if (!helloed) return;
    bridge.handleSandboxMessage(msg, peerGen);
  });

  ws.on('close', () => {
    if (disconnect) disconnect();
    disconnect = null;
    if (consumer) consumer.dispose();
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
  /** Handle one parsed message from the consumer. */
  handleMessage(msg: BridgeMessage): void;
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
): ConsumerSession {
  /** consumer subId → bridge-side unsubscribe. */
  const subs = new Map<string, () => void>();

  return {
    handleMessage(msg: BridgeMessage): void {
      switch (msg.type) {
        case 'attach': {
          // Idempotent re-attach: just re-ack. `serveVersion` is the
          // version-skew stamp (bridge/protocol.ts) — this process's own
          // @pyric/cli version, compared client-side at attach.
          send({
            type: 'attach-ack',
            protocol: 1,
            bridgeVersion: bridge.version,
            peerConnected: bridge.isSandboxConnected(),
            serveVersion: cliVersion(),
          });
          return;
        }
        case 'worker-op': {
          bridge.dispatchWorkerOp(msg.op).then(
            (value) => send({ type: 'worker-res', id: msg.id, ok: true, value }),
            (err: Error & { code?: string; denialContext?: unknown }) =>
              send({
                type: 'worker-res',
                id: msg.id,
                ok: false,
                error: {
                  code: err.code ?? 'unknown',
                  message: err.message,
                  // Structured denial context (spike gap 6) — plain JSON,
                  // relayed verbatim so the Node side re-attaches it.
                  ...(err.denialContext !== undefined ? { denialContext: err.denialContext } : {}),
                },
              }),
          );
          return;
        }
        case 'worker-sub': {
          if (subs.has(msg.subId)) return; // idempotent
          const unsubscribe = bridge.subscribeWorker(msg.sub, (value) =>
            send({ type: 'worker-snap', subId: msg.subId, value }),
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
        case 'ping': {
          send({ type: 'pong', id: msg.id });
          return;
        }
        default:
          return; // peer-only or unknown frames — ignore
      }
    },
    dispose(): void {
      for (const unsubscribe of subs.values()) unsubscribe();
      subs.clear();
    },
  };
}

export async function collectBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  return await new Promise<unknown>((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
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
