import type { WebSocket } from 'ws';
import type { BridgeMessage } from '../protocol.js';
import { BRIDGE_FRAME_LIMIT_MESSAGE, encodeBridgeMessage } from '../frame-output.js';

/** Refuse oversized output before ws.send while preserving request correlation. */
export function sendBridgeMessage(socket: WebSocket, frame: BridgeMessage): void {
  const isClosed = socket.readyState !== socket.OPEN;
  if (isClosed) return;
  const payload = encodeBridgeMessage(frame);
  const exceedsFrameLimit = payload === undefined;
  if (exceedsFrameLimit) {
    socket.close(1009, BRIDGE_FRAME_LIMIT_MESSAGE);
    return;
  }
  socket.send(payload);
}
