import { FirebaseError } from 'pyric/app';
import {
  BRIDGE_FRAME_LIMIT_MESSAGE,
  BROWSER_FRAME_LIMIT_CLOSE_CODE,
} from '../../../bridge/frame-output.js';
import {
  isBridgeMessage,
  MAX_BRIDGE_FRAME_BYTES,
  type BridgeMessage,
} from '../../../bridge/protocol.js';
import { hasValidOutboundEnvelope, hasValidReplyOutcome } from '../outbound-validation.js';
import type { OutboundMessage } from '../protocol.js';

const utf8 = new TextEncoder();

type ParsedInboundFrame =
  | { ok: true; message: BridgeMessage }
  | { ok: false; error: string; closeCode?: number; closeReason?: string };

export function parseInboundBridgeFrame(rawData: string): ParsedInboundFrame {
  const exceedsFrameLimit = utf8.encode(rawData).byteLength > MAX_BRIDGE_FRAME_BYTES;
  if (exceedsFrameLimit) {
    return {
      ok: false,
      error: BRIDGE_FRAME_LIMIT_MESSAGE,
      closeCode: BROWSER_FRAME_LIMIT_CLOSE_CODE,
      closeReason: BRIDGE_FRAME_LIMIT_MESSAGE,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return {
      ok: false,
      error:
        'The hosted sandbox sent invalid JSON. Requests already sent may have completed; check state before retrying.',
    };
  }
  if (!isBridgeMessage(parsed)) {
    return {
      ok: false,
      error:
        'The hosted sandbox sent an invalid message. Requests already sent may have completed; check state before retrying.',
    };
  }
  return { ok: true, message: parsed };
}

export function extractPersistenceError(response: OutboundMessage): FirebaseError | undefined {
  const isResponse = hasValidOutboundEnvelope(response) && response.t === 'res';
  const hasError = isResponse && hasValidReplyOutcome(response) && response.ok === false;
  if (!hasError) return undefined;
  const isPersistenceFailure =
    response.error.code === 'committed-but-not-durable' ||
    response.error.code === 'persistence-unhealthy';
  if (!isPersistenceFailure) return undefined;
  return new FirebaseError(response.error.code, response.error.message);
}
