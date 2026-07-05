/**
 * Bridge transport helpers shared by the bridge mounts.
 *
 * `attachPeer` adapts a `ws` WebSocket into a registered sandbox peer (the
 * browser-side `connectBridge` is the other end); `collectBody` buffers a
 * Node request body into parsed JSON for the stateless MCP transport.
 *
 * Both are consumed by `serve/bridge-mount.ts` (the `pyric serve --bridge` and
 * `pyricSandbox({ bridge })` mount) and `serve/namespace.ts` (capture route).
 * They live here — not inline in a plugin file — so retiring the standalone
 * bridge Vite plugin doesn't drag its consumers with it.
 */
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { createBridge } from './bridge.js';
import { isBridgeMessage, type BridgeMessage } from '../protocol.js';

export function attachPeer(
  bridge: ReturnType<typeof createBridge>,
  ws: WebSocket,
): void {
  let disconnect: (() => void) | null = null;
  let helloed = false;

  ws.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!isBridgeMessage(msg)) return;
    if (msg.type === 'hello') {
      if (helloed) return;
      helloed = true;
      disconnect = bridge.registerSandboxPeer(
        (out: BridgeMessage) => {
          try {
            ws.send(JSON.stringify(out));
          } catch {}
        },
        msg.tools,
        msg.sandboxId,
      );
      ws.send(
        JSON.stringify({
          type: 'hello-ack',
          protocol: 1,
          bridgeVersion: bridge.version,
        }),
      );
      return;
    }
    if (!helloed) return;
    bridge.handleSandboxMessage(msg);
  });

  ws.on('close', () => {
    if (disconnect) disconnect();
    disconnect = null;
  });
  ws.on('error', () => {});
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
