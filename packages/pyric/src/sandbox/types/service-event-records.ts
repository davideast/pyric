/**
 * Every service's event declaration, in one place, so the sandbox core can
 * derive the stream's vocabulary instead of restating it.
 *
 * Why static imports rather than a registry the capabilities register into.
 * The operation enums have to exist as types: `ServiceMutationEvent.op` is
 * derived from them, and a value pushed into a registry at module load carries
 * no type a `.d.ts` can name. A registry would also make the vocabulary depend
 * on which surfaces a bundle happened to load, so the same event would be
 * well-typed in one entry point and untyped in another. These imports reach
 * six leaf files that declare data and import nothing but the record type, so
 * the edge costs the central runtime no capability code.
 */
import { AI_EVENT_RECORD } from '../../ai/events.js';
import { AUTH_EVENT_RECORD } from '../../auth/events.js';
import { RTDB_EVENT_RECORD } from '../../database/events.js';
import { FUNCTIONS_EVENT_RECORD } from '../../functions/events.js';
import { MESSAGING_EVENT_RECORD } from '../../messaging/events.js';
import { STORAGE_EVENT_RECORD } from '../../storage/events.js';
import type { ServiceEventRecord } from './service-event-record.js';

/** Keyed by the service name each record declares. */
export const SERVICE_EVENT_RECORDS = {
  auth: AUTH_EVENT_RECORD,
  storage: STORAGE_EVENT_RECORD,
  rtdb: RTDB_EVENT_RECORD,
  messaging: MESSAGING_EVENT_RECORD,
  ai: AI_EVENT_RECORD,
  functions: FUNCTIONS_EVENT_RECORD,
} as const satisfies Record<string, ServiceEventRecord>;

/** Every service that emits the cross-service mutation envelope. */
export type MutationEventService = keyof typeof SERVICE_EVENT_RECORDS;

/** The operations one service declared. */
export type ServiceEventOperation<Service extends MutationEventService> =
  (typeof SERVICE_EVENT_RECORDS)[Service]['operations'][number];

/** Every declared service name, as a runtime list. */
export const MUTATION_EVENT_SERVICES = Object.keys(
  SERVICE_EVENT_RECORDS,
) as MutationEventService[];
