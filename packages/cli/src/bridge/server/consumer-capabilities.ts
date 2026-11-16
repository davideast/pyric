import {
  DOC_VALUE_ENCODING_CAPABILITY,
  type WorkerOpPayload,
  type WorkerSubPayload,
} from '../protocol.js';
import type { InboundMessage, SubMessage } from '../../serve/worker/protocol.js';
import {
  DOC_VALUE_ENCODING,
  type FirestoreSubMessage,
  type ResponseDocValueEncoding,
} from '../../serve/worker/protocol/firestore.js';

/** Resolve the Firestore response encoding a consumer negotiated at attach. */
export function resolveConsumerDocEncoding(
  capabilities: readonly string[] | undefined,
): ResponseDocValueEncoding {
  if (capabilities !== undefined && capabilities.includes(DOC_VALUE_ENCODING_CAPABILITY)) {
    return DOC_VALUE_ENCODING;
  }
  return 'legacy';
}

/** Stamp bridge-owned session and encoding metadata onto a relayed worker op. */
export function stampWorkerOpPayload(
  op: WorkerOpPayload,
  docValueEncoding: ResponseDocValueEncoding,
): WorkerOpPayload {
  return { ...op, resumeSession: true, docValueEncoding };
}

/** Stamp bridge-owned session and encoding metadata onto a relayed worker sub. */
export function stampWorkerSubPayload(
  sub: WorkerSubPayload,
  docValueEncoding: ResponseDocValueEncoding,
): WorkerSubPayload {
  return { ...sub, resumeSession: true, docValueEncoding };
}

function isFirestoreSubMessage(message: SubMessage): message is FirestoreSubMessage {
  return (
    typeof message.target === 'object' &&
    message.target !== null &&
    '__ref' in message.target
  );
}

/** Stamp bridge-owned host-admission and encoding metadata onto a worker-port frame. */
export function stampWorkerPortMessage(
  message: InboundMessage,
  context: {
    docValueEncoding: ResponseDocValueEncoding;
    attachedFromPriorHost: boolean;
    verifiedCurrentHost: boolean;
  },
): InboundMessage {
  if (message.t === 'appConfig') {
    if (context.attachedFromPriorHost) return { ...message, fromPriorHost: true };
    if (context.verifiedCurrentHost) return { ...message, hostVerified: true };
    return message;
  }
  if (message.t === 'op') {
    return { ...message, docValueEncoding: context.docValueEncoding };
  }
  if (message.t === 'sub' && isFirestoreSubMessage(message)) {
    return { ...message, docValueEncoding: context.docValueEncoding };
  }
  return message;
}
