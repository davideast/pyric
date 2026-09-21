import type { WebSocket } from 'ws';
import { MAX_PENDING_OPERATIONS, MAX_QUEUED_OPERATION_BYTES, type BridgeMessage } from '../protocol.js';
import {
  BRIDGE_BACKLOG_CLOSE_MESSAGE,
  BRIDGE_BACKLOG_ERROR,
  BRIDGE_FRAME_LIMIT_MESSAGE,
  BRIDGE_REQUEST_LIMIT_ERROR,
  MAX_BACKLOG_REFUSAL_BYTES,
  encodeBridgeMessage,
  failBridgeResponse,
  refuseBridgeRequest,
} from '../frame-output.js';

/**
 * Bytes of refusals a socket may take on beyond its backlog limit before the
 * close is the only remaining bound: one bounded refusal for each operation a
 * client may hold open at once.
 */
const MAX_BACKLOG_OVERSHOOT_BYTES = MAX_PENDING_OPERATIONS * MAX_BACKLOG_REFUSAL_BYTES;

/** Refusal bytes each socket has taken on since its backlog last had room. */
const backlogOvershoot = new WeakMap<WebSocket, number>();

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
    const refusal = refuseBridgeRequest(frame, BRIDGE_REQUEST_LIMIT_ERROR);
    const canRefuseRequest = refusal !== undefined && receiveRefusal !== undefined;
    if (canRefuseRequest) {
      receiveRefusal(refusal);
      return;
    }
    socket.close(1009, BRIDGE_FRAME_LIMIT_MESSAGE);
    return;
  }
  const exceedsBacklog = socket.bufferedAmount + Buffer.byteLength(payload) > MAX_QUEUED_OPERATION_BYTES;
  if (exceedsBacklog) {
    refuseBacklogFrame(socket, frame, receiveRefusal);
    return;
  }
  backlogOvershoot.delete(socket);
  socket.send(payload);
}

/**
 * Fail the one operation a backlogged frame belongs to, so the other
 * operations on this connection keep running. A frame with no operation behind
 * it — a pushed snapshot or observation batch — leaves the close as the only
 * bound on a reader that is not draining.
 */
function refuseBacklogFrame(
  socket: WebSocket,
  frame: BridgeMessage,
  receiveRefusal?: (response: BridgeMessage) => void,
): void {
  const requestRefusal = refuseBridgeRequest(frame, BRIDGE_BACKLOG_ERROR);
  const canRefuseRequest = requestRefusal !== undefined && receiveRefusal !== undefined;
  if (canRefuseRequest) {
    receiveRefusal(requestRefusal);
    return;
  }
  const errorResponse = failBridgeResponse(frame, BRIDGE_BACKLOG_ERROR);
  const hasNoCorrelatedResponse = errorResponse === undefined;
  if (hasNoCorrelatedResponse) {
    socket.close(1013, BRIDGE_BACKLOG_CLOSE_MESSAGE);
    return;
  }
  const refusalPayload = encodeBridgeMessage(errorResponse);
  // This write lands on a socket already past the limit, so it is admitted
  // only while each refusal and their running total stay bounded.
  const exceedsRefusalBound =
    refusalPayload === undefined || Buffer.byteLength(refusalPayload) > MAX_BACKLOG_REFUSAL_BYTES;
  if (exceedsRefusalBound) {
    socket.close(1013, BRIDGE_BACKLOG_CLOSE_MESSAGE);
    return;
  }
  const overshoot = (backlogOvershoot.get(socket) ?? 0) + Buffer.byteLength(refusalPayload);
  const exceedsOvershootBound = overshoot > MAX_BACKLOG_OVERSHOOT_BYTES;
  if (exceedsOvershootBound) {
    socket.close(1013, BRIDGE_BACKLOG_CLOSE_MESSAGE);
    return;
  }
  backlogOvershoot.set(socket, overshoot);
  socket.send(refusalPayload);
}
