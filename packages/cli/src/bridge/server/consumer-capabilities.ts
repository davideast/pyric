import {
  DOC_VALUE_ENCODING_CAPABILITY,
  type WorkerOpPayload,
  type WorkerSubPayload,
} from '../protocol.js';
import {
  DOC_VALUE_ENCODING,
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
