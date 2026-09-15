import type { WebSocket } from 'ws';
import type { BridgeMessage } from '../protocol.js';
import { BRIDGE_FRAME_LIMIT_MESSAGE, encodeBridgeMessage, refuseBridgeRequest } from '../frame-output.js';

/** Refuse oversized output before ws.send while preserving request correlation. */
export function sendBridgeMessage(
  socket: WebSocket,
  frame: BridgeMessage,
  receiveRefusal?: (response: BridgeMessage) => void,
): void {
  const isClosed = socket.readyState !== socket.OPEN;
  if (isClosed) return;
  const payload = encodeBridgeMessage(frame);
  const exceedsFrameLimit = payload === undefined;
  if (exceedsFrameLimit) {
    const refusal = refuseBridgeRequest(frame);
    const canRefuseRequest = refusal !== undefined && receiveRefusal !== undefined;
    if (canRefuseRequest) {
      receiveRefusal(refusal);
      return;
    }
    socket.close(1009, BRIDGE_FRAME_LIMIT_MESSAGE);
    return;
  }
  const exceedsBacklog = socket.bufferedAmount + Buffer.byteLength(payload) > 24 * 1024 * 1024;
  if (exceedsBacklog) {
    socket.close(1013, 'Client output backlog exceeds 24 MiB; reconnect to resume.');
    return;
  }
  socket.send(payload);
}
