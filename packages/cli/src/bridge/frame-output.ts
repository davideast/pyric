import type { OutboundMessage } from '../serve/worker/protocol.js';
import { MAX_BRIDGE_FRAME_BYTES, type BridgeMessage } from './protocol.js';

export const BRIDGE_FRAME_LIMIT_MESSAGE = 'Bridge response exceeds the 12 MiB encoded frame limit.';
/** Browser WebSocket.close permits application codes, not protocol code 1009. */
export const BROWSER_FRAME_LIMIT_CLOSE_CODE = 4009;

const frameLimitError = { code: 'resource-exhausted', message: BRIDGE_FRAME_LIMIT_MESSAGE };
const requestLimitError = { code: 'resource-exhausted', message: 'Bridge request exceeds the 12 MiB encoded frame limit.' };
const utf8 = new TextEncoder();

/** Refuse an unsent request through its existing correlated reply owner. */
export function refuseBridgeRequest(frame: BridgeMessage): BridgeMessage | undefined {
  const isToolCall = frame.type === 'tool-call';
  if (isToolCall) {
    return { type: 'tool-result', id: frame.id, ok: false, error: requestLimitError };
  }
  const isWorkerOperation = frame.type === 'worker-op';
  if (isWorkerOperation) {
    return {
      type: 'worker-res', id: frame.id, clientSessionId: frame.clientSessionId, ok: false,
      error: requestLimitError,
    };
  }
  const isWorkerSubscription = frame.type === 'worker-sub';
  if (isWorkerSubscription) {
    return {
      type: 'worker-snap', subId: frame.subId, clientSessionId: frame.clientSessionId,
      value: { __error: requestLimitError },
    };
  }
}

/** Encode bounded output, retaining correlation when an oversized result can be refused. */
export function encodeBridgeMessage(frame: BridgeMessage): string | undefined {
  const payload = JSON.stringify(frame);
  const fitsFrameLimit = utf8.encode(payload).byteLength <= MAX_BRIDGE_FRAME_BYTES;
  if (fitsFrameLimit) return payload;
  const reducedFrame = reduceOversizedFrame(frame);
  const reduced = JSON.stringify(reducedFrame);
  const stillExceedsLimit = utf8.encode(reduced).byteLength > MAX_BRIDGE_FRAME_BYTES;
  if (stillExceedsLimit) return encodeObservationGap(reducedFrame);
  return reduced;
}

/** Keep an undeliverable observation batch from closing the operation connection. */
function encodeObservationGap(frame: BridgeMessage): string | undefined {
  const isOtherFrame = frame.type !== 'worker-message-result';
  if (isOtherFrame) return;
  const message = frame.message;
  const isOtherMessage = message.t !== 'event';
  if (isOtherMessage) return;
  const first = message.events[0];
  const last = message.events.at(-1);
  const isEmptyBatch = first === undefined || last === undefined;
  if (isEmptyBatch) return;
  const refusal: BridgeMessage = {
    ...frame,
    message: {
      ...message,
      events: [{
        kind: 'observation_gap', id: `observation-gap:${first.id}:${last.id}`, at: first.at,
        reason: 'frame-limit', omittedCount: message.events.length,
        firstEventId: first.id, lastEventId: last.id,
      }],
    },
  };
  const payload = JSON.stringify(refusal);
  const fitsFrameLimit = utf8.encode(payload).byteLength <= MAX_BRIDGE_FRAME_BYTES;
  if (fitsFrameLimit) return payload;
}

function reduceOversizedFrame(frame: BridgeMessage): BridgeMessage {
  switch (frame.type) {
    case 'tool-result':
      return { type: 'tool-result', id: frame.id, ok: false, error: frameLimitError };
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
