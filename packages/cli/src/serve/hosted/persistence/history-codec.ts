import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DOC_VALUE_ENCODING, encodeDocValue, rehydrateEncodedDocValue } from 'pyric/firestore/internal/value-codec';
const envelope = z.object({ version: z.literal(1), encoding: z.literal(DOC_VALUE_ENCODING), value: z.unknown() });
export function historyChecksum(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}
export function encodeHistory(value: unknown): string {
  return JSON.stringify({ version: 1, encoding: DOC_VALUE_ENCODING, value: encodeDocValue(value) });
}
export function decodeHistory(payload: string, checksum: string): unknown {
  const corrupt = historyChecksum(payload) !== checksum;
  if (corrupt)
    throw new Error('History payload checksum mismatch.');
  const data = envelope.parse(JSON.parse(payload));
  return rehydrateEncodedDocValue(data.value, data.encoding);
}
