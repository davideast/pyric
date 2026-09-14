import type { WebSocket } from 'ws';
import type { OutboundMessage } from '../../serve/worker/protocol.js';
import { MAX_BRIDGE_FRAME_BYTES, type BridgeMessage } from '../protocol.js';

const frameLimitError = {
  code: 'resource-exhausted',
  message: 'Bridge response exceeds the 12 MiB encoded frame limit.',
};

/** Refuse oversized output before ws.send while preserving request correlation. */
export function sendBridgeMessage(socket: WebSocket, frame: BridgeMessage): void {
  const isClosed = socket.readyState !== socket.OPEN;
  if (isClosed) return;
  let payload = JSON.stringify(frame);
  const exceedsFrameLimit = Buffer.byteLength(payload) > MAX_BRIDGE_FRAME_BYTES;
  if (exceedsFrameLimit) payload = JSON.stringify(reduceOversizedFrame(frame));
  const stillExceedsLimit = Buffer.byteLength(payload) > MAX_BRIDGE_FRAME_BYTES;
  if (stillExceedsLimit) {
    socket.close(1009, frameLimitError.message);
    return;
  }
  socket.send(payload);
}

function reduceOversizedFrame(frame: BridgeMessage): BridgeMessage {
  switch (frame.type) {
    case 'worker-message-result':
      return { ...frame, message: reduceOversizedWorkerMessage(frame.message) };
    case 'worker-res':
      return {
        type: 'worker-res', id: frame.id, clientSessionId: frame.clientSessionId,
        ok: false, error: frameLimitError,
      };
    case 'worker-snap':
      return { ...frame, value: { __error: frameLimitError } };
    default:
      return frame;
  }
}

function reduceOversizedWorkerMessage(message: OutboundMessage): OutboundMessage {
  switch (message.t) {
    case 'res':
      return {
        t: 'res', id: message.id, clientSessionId: message.clientSessionId,
        ok: false, error: frameLimitError,
      };
    case 'snap':
      return { ...message, value: { __error: frameLimitError } };
    case 'event': {
      // Snapshot samples are optional; retain every observation and its metadata.
      const events = message.events.map(event => {
        const isSnapshotDelivery = event.kind === 'snapshot_delivery';
        if (isSnapshotDelivery) {
          const summary = { ...event };
          delete summary.sample;
          return summary;
        }
        return event;
      });
      return { ...message, events };
    }
    default:
      return message;
  }
}
