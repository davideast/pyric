import { z } from 'zod';
import { decodeHistory } from './history-codec.js';
export const durableUndoEventSchema = z.object({ id: z.number().int(), timestamp: z.string(), type: z.enum(['single', 'batch', 'transaction']),
  method: z.string(), path: z.string(), allowed: z.boolean(), auth: z.object({ uid: z.string() }).nullable(),
  priorDocs: z.record(z.record(z.unknown()).nullable()).optional(), nextDocs: z.record(z.record(z.unknown()).nullable()).optional(),
  debugMessages: z.array(z.string()) }).passthrough();
export const durableUndoRecordSchema = durableUndoEventSchema.extend({
  allowed: z.literal(true),
  priorDocs: z.record(z.record(z.unknown()).nullable()),
  nextDocs: z.record(z.record(z.unknown()).nullable()),
});
export const historyKindSchema = z.enum(['observation', 'mutation', 'undo', 'boundary', 'engine']);
export const historyRecordSchema = z.object({ sequence: z.number().int().positive(), session: z.string(),
  kind: historyKindSchema, service: z.string(), encodedPayload: z.string(), checksum: z.string(), payload: z.unknown() });
export type HistoryRecord = z.infer<typeof historyRecordSchema>;
export const historyPageSchema = z.object({ storeId: z.string().uuid(), through: z.number().int().nonnegative(),
  next: z.number().int().nonnegative(), records: z.array(historyRecordSchema) });
export const historyStatusSchema = z.object({ storeId: z.string().uuid(), session: z.string(), durableSequence: z.number().int().nonnegative(),
  pendingEvents: z.number().int().nonnegative(), pendingBytes: z.number().int().nonnegative(), unrecorded: z.number().int().nonnegative(),
  lastFlushAt: z.number().nullable(), healthy: z.boolean(), previousShutdownClean: z.boolean(),
  undo: z.object({ undoCount: z.number(), redoCount: z.number(), cacheBytes: z.number(), cachedRecords: z.number(), pendingBytes: z.number(), pendingLinkBytes: z.number() }) });
export const observationSchema = z.object({ kind: z.string(), id: z.string(), at: z.number() }).passthrough();
const boundarySchema = z.object({ reason: z.string() }).passthrough();
const mutationSchema = z.union([
  z.object({ namespace: z.string(), changed: z.array(z.string()), removed: z.array(z.string()) }),
  z.object({ operation: z.enum(['put', 'metadata', 'delete', 'reset']), bucket: z.string().nullable(), path: z.string().optional() }),
]);
const undoPosition = z.object({ action: z.enum(['position', 'boundary']), next: z.number().int().positive(),
  undo: z.number().int().nonnegative(), redo: z.number().int().nonnegative(), undoCount: z.number().int().nonnegative(), redoCount: z.number().int().nonnegative(), links: z.array(z.tuple([z.number().int(), z.number().int()])) });
export const undoAppendSchema = z.object({ action: z.literal('append'), id: z.number().int().positive(), previous: z.number().int().nonnegative(), redo: z.number().int().nonnegative(), payload: z.string(), checksum: z.string() });
/** Decode only requested history, with the same validation on disk and in backups. */
export function decodeHistoryRecord(record: Pick<HistoryRecord, 'kind' | 'encodedPayload' | 'checksum'>): unknown {
  const value = decodeHistory(record.encodedPayload, record.checksum);
  switch (record.kind) {
    case 'observation':
      observationSchema.parse(value);
      break;
    case 'engine':
      durableUndoEventSchema.parse(value);
      break;
    case 'boundary':
      boundarySchema.parse(value);
      break;
    case 'mutation':
      mutationSchema.parse(value);
      break;
    case 'undo': {
      const append = undoAppendSchema.safeParse(value);
      const isAppend = append.success;
      if (isAppend)
        durableUndoRecordSchema.parse(decodeHistory(append.data.payload, append.data.checksum));
      else
        undoPosition.parse(value);
      break;
    }
  }
  return value;
}
