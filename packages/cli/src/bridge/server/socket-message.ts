import type { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import {
  BRIDGE_BACKLOG_CLOSE_MESSAGE,
  BRIDGE_BACKLOG_UNDELIVERED_ERROR,
  BRIDGE_BACKLOG_UNSENT_ERROR,
  BRIDGE_FRAME_LIMIT_MESSAGE,
  BRIDGE_REQUEST_LIMIT_ERROR,
  ConsumerObservationQueue,
  MAX_BACKLOG_REFUSAL_BYTES,
  MAX_PENDING_OBSERVATION_BYTES,
  MAX_PENDING_OBSERVATION_EVENTS,
  OBSERVATION_SOCKET_HIGH_WATER_BYTES,
  encodeBridgeMessage,
  failBridgeResponse,
  isObservationBridgeFrame,
  prepareObservationBridgeFrame,
  refuseBridgeRequest,
} from '../frame-output.js';
import {
  MAX_PENDING_OPERATIONS,
  MAX_QUEUED_OPERATION_BYTES,
  type BridgeMessage,
} from '../protocol.js';

/**
 * Bytes a socket may take on beyond its backlog limit before the close is the
 * only remaining bound: one bounded frame for each operation a client may hold
 * open at once.
 */
const MAX_BACKLOG_OVERSHOOT_BYTES = MAX_PENDING_OPERATIONS * MAX_BACKLOG_REFUSAL_BYTES;

const OBSERVATION_DRAIN_POLL_MS = 15;

/** Bytes each socket has taken on past its limit since its backlog last had room. */
const backlogOvershoot = new WeakMap<WebSocket, number>();

interface SocketObservationState {
  readonly queue: ConsumerObservationQueue;
  pollTimer: ReturnType<typeof setTimeout> | undefined;
  closeAttached: boolean;
  drainTarget: EventEmitter | undefined;
  readonly onClose: () => void;
  readonly onDrain: () => void;
}

/** Active non-empty observation queues keyed by consumer socket; deleted on drain or close. */
const activeObservationQueues = new Map<WebSocket, SocketObservationState>();

function underlyingTransportStream(socket: WebSocket): EventEmitter | undefined {
  const candidate = (socket as unknown as { _socket?: unknown })._socket;
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const emitter = candidate as Partial<EventEmitter>;
  if (typeof emitter.on !== 'function' || typeof emitter.off !== 'function') return undefined;
  return candidate as EventEmitter;
}

function canListenOnSocket(socket: WebSocket): socket is WebSocket & EventEmitter {
  const candidate = socket as unknown as Partial<EventEmitter>;
  return typeof candidate.on === 'function' && typeof candidate.off === 'function';
}

function cleanupSocketObservations(socket: WebSocket): void {
  const state = activeObservationQueues.get(socket);
  if (state === undefined) return;
  activeObservationQueues.delete(socket);
  state.queue.clear();
  if (state.pollTimer !== undefined) {
    clearTimeout(state.pollTimer);
    state.pollTimer = undefined;
  }
  if (state.closeAttached && canListenOnSocket(socket)) {
    socket.off('close', state.onClose);
    state.closeAttached = false;
  }
  if (state.drainTarget !== undefined) {
    state.drainTarget.off('drain', state.onDrain);
    state.drainTarget = undefined;
  }
}

function closeSocketCleanly(socket: WebSocket, code: number, reason: string): void {
  cleanupSocketObservations(socket);
  socket.close(code, reason);
}

function scheduleObservationDrainPoll(socket: WebSocket, state: SocketObservationState): void {
  if (state.pollTimer !== undefined) return;
  const timer = setTimeout(() => {
    state.pollTimer = undefined;
    drainSocketObservations(socket);
  }, OBSERVATION_DRAIN_POLL_MS);
  timer.unref?.();
  state.pollTimer = timer;
}

function attachObservationWatchers(socket: WebSocket, state: SocketObservationState): void {
  if (!state.closeAttached && canListenOnSocket(socket)) {
    socket.on('close', state.onClose);
    state.closeAttached = true;
  }
  if (state.drainTarget === undefined) {
    const stream = underlyingTransportStream(socket);
    if (stream !== undefined) {
      stream.on('drain', state.onDrain);
      state.drainTarget = stream;
    }
  }
  scheduleObservationDrainPoll(socket, state);
}

function hasSocketRoomForObservation(socket: WebSocket, frameBytes: number): boolean {
  if (socket.bufferedAmount > OBSERVATION_SOCKET_HIGH_WATER_BYTES) return false;
  if (socket.bufferedAmount + frameBytes > MAX_PENDING_OBSERVATION_BYTES) return false;
  return socket.bufferedAmount + frameBytes <= MAX_QUEUED_OPERATION_BYTES;
}

function drainSocketObservations(socket: WebSocket): void {
  const state = activeObservationQueues.get(socket);
  if (state === undefined) return;
  if (socket.readyState !== socket.OPEN) {
    cleanupSocketObservations(socket);
    return;
  }
  if (state.drainTarget !== undefined) {
    state.drainTarget.off('drain', state.onDrain);
    state.drainTarget = undefined;
  }
  while (!state.queue.isEmpty) {
    const head = state.queue.peek();
    if (head === undefined) break;
    if (!hasSocketRoomForObservation(socket, head.bytes)) break;
    const next = state.queue.shift();
    if (next === undefined) break;
    backlogOvershoot.delete(socket);
    try {
      socket.send(next.payload);
    } catch {
      cleanupSocketObservations(socket);
      return;
    }
    if (socket.readyState !== socket.OPEN) {
      cleanupSocketObservations(socket);
      return;
    }
  }
  if (state.queue.isEmpty) {
    cleanupSocketObservations(socket);
    return;
  }
  attachObservationWatchers(socket, state);
}

function ensureObservationState(socket: WebSocket): SocketObservationState {
  const existing = activeObservationQueues.get(socket);
  if (existing !== undefined) return existing;
  const state: SocketObservationState = {
    queue: new ConsumerObservationQueue(
      MAX_PENDING_OBSERVATION_EVENTS,
      MAX_PENDING_OBSERVATION_BYTES,
    ),
    pollTimer: undefined,
    closeAttached: false,
    drainTarget: undefined,
    onClose: () => cleanupSocketObservations(socket),
    onDrain: () => drainSocketObservations(socket),
  };
  activeObservationQueues.set(socket, state);
  return state;
}

function sendObservationFrame(
  socket: WebSocket,
  frame: Extract<BridgeMessage, { type: 'worker-message-result' }> & {
    message: Extract<BridgeMessage, { type: 'worker-message-result' }>['message'] & { t: 'event' };
  },
): void {
  const prepared = prepareObservationBridgeFrame(frame);
  if (prepared === undefined) {
    closeSocketCleanly(socket, 1009, BRIDGE_FRAME_LIMIT_MESSAGE);
    return;
  }
  const existingState = activeObservationQueues.get(socket);
  if (existingState === undefined && hasSocketRoomForObservation(socket, prepared.bytes)) {
    backlogOvershoot.delete(socket);
    socket.send(prepared.payload);
    return;
  }
  if (prepared.kind === 'empty') return;
  const state = ensureObservationState(socket);
  state.queue.enqueue(prepared);
  drainSocketObservations(socket);
}

/** Refuse oversized output before ws.send while preserving request correlation. */
export function sendBridgeMessage(
  socket: WebSocket,
  frame: BridgeMessage,
  receiveRefusal?: (response: BridgeMessage) => void,
): void {
  const isClosed = socket.readyState !== socket.OPEN;
  if (isClosed) {
    cleanupSocketObservations(socket);
    return;
  }
  if (isObservationBridgeFrame(frame)) {
    sendObservationFrame(socket, frame);
    return;
  }
  const payload = encodeBridgeMessage(frame);
  const exceedsFrameLimit = payload === undefined;
  if (exceedsFrameLimit) {
    const refusal = refuseBridgeRequest(frame, BRIDGE_REQUEST_LIMIT_ERROR);
    const canRefuseRequest = refusal !== undefined && receiveRefusal !== undefined;
    if (canRefuseRequest) {
      receiveRefusal(refusal);
      return;
    }
    closeSocketCleanly(socket, 1009, BRIDGE_FRAME_LIMIT_MESSAGE);
    return;
  }
  const exceedsBacklog =
    socket.bufferedAmount + Buffer.byteLength(payload) > MAX_QUEUED_OPERATION_BYTES;
  if (exceedsBacklog) {
    refuseBacklogFrame(socket, frame, payload, receiveRefusal);
    return;
  }
  backlogOvershoot.delete(socket);
  socket.send(payload);
}

/**
 * Fail the one operation a backlogged frame belongs to, so the other
 * operations on this connection keep running. A frame with no operation behind
 * it -- a pushed snapshot -- leaves the close as the only bound on a reader
 * that is not draining.
 */
function refuseBacklogFrame(
  socket: WebSocket,
  frame: BridgeMessage,
  payload: string,
  receiveRefusal?: (response: BridgeMessage) => void,
): void {
  const requestRefusal = refuseBridgeRequest(frame, BRIDGE_BACKLOG_UNSENT_ERROR);
  const canRefuseRequest = requestRefusal !== undefined && receiveRefusal !== undefined;
  if (canRefuseRequest) {
    receiveRefusal(requestRefusal);
    return;
  }
  const errorResponse = failBridgeResponse(frame, BRIDGE_BACKLOG_UNDELIVERED_ERROR);
  const hasNoCorrelatedResponse = errorResponse === undefined;
  if (hasNoCorrelatedResponse) {
    closeSocketCleanly(socket, 1013, BRIDGE_BACKLOG_CLOSE_MESSAGE);
    return;
  }
  // A response no larger than its replacement costs the backlog the same, so
  // it is delivered: the acknowledgment of a finished write must not turn into
  // a failure its caller retries.
  const deliversResponse = Buffer.byteLength(payload) <= MAX_BACKLOG_REFUSAL_BYTES;
  const refusalPayload = deliversResponse ? payload : encodeBridgeMessage(errorResponse);
  // This write lands on a socket already past the limit, so it is admitted
  // only while each frame and their running total stay bounded.
  const exceedsRefusalBound =
    refusalPayload === undefined || Buffer.byteLength(refusalPayload) > MAX_BACKLOG_REFUSAL_BYTES;
  if (exceedsRefusalBound) {
    closeSocketCleanly(socket, 1013, BRIDGE_BACKLOG_CLOSE_MESSAGE);
    return;
  }
  const overshoot = (backlogOvershoot.get(socket) ?? 0) + Buffer.byteLength(refusalPayload);
  const exceedsOvershootBound = overshoot > MAX_BACKLOG_OVERSHOOT_BYTES;
  if (exceedsOvershootBound) {
    closeSocketCleanly(socket, 1013, BRIDGE_BACKLOG_CLOSE_MESSAGE);
    return;
  }
  backlogOvershoot.set(socket, overshoot);
  socket.send(refusalPayload);
}
