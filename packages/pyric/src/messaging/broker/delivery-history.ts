import type { Sandbox } from '../../sandbox/types/service.js';
import type { ServiceMutationEvent } from '../../sandbox/types/events.js';
import type { DeliveredPayload, DeliveryLogEntry, DeliveryRoute, DeliveryStage, DeliveryAcknowledgment } from './types.js';

/**
 * Rebuild one delivery entry from the event that reported the delivery. The
 * event carries everything the entry reports, so this reads fields rather than
 * recomputing any of them.
 */
function toDeliveryLogEntry(event: ServiceMutationEvent): DeliveryLogEntry {
  const detail = event.detail ?? {};
  return {
    messageId: String(detail.messageId),
    recipientId: String(detail.recipientId ?? 'sandbox-default'),
    receipt: 'unconfirmed',
    acknowledgments: [],
    route: detail.route as DeliveryRoute,
    handled: detail.handled === true,
    at: event.at,
    payload: detail.payload as DeliveredPayload,
  };
}

/** Reuse the retained event stream; acknowledgments have no separate persistent store. */
export function deliveryHistory(history: ReturnType<Sandbox['history']>, since?: number): DeliveryLogEntry[] {
  const events = history.filter((event): event is ServiceMutationEvent =>
    event.kind === 'service_mutation' && event.service === 'messaging');
  const evidence = new Map<string, DeliveryAcknowledgment[]>();
  const key = (messageId: unknown, recipientId: unknown) => JSON.stringify([messageId, recipientId]);
  for (const event of events) {
    const unrelated = event.op !== 'delivery_acknowledged';
    if (unrelated) continue;
    const detail = event.detail ?? {};
    const id = key(detail.messageId, detail.recipientId);
    const acknowledgments = evidence.get(id) ?? [];
    acknowledgments.push({ observerId: String(detail.observerId), stage: detail.stage as DeliveryStage, at: event.at });
    evidence.set(id, acknowledgments);
  }
  const entries = events.filter(event => event.op === 'message_delivered').map(event => {
    const entry = toDeliveryLogEntry(event);
    entry.acknowledgments = evidence.get(key(entry.messageId, entry.recipientId)) ?? [];
    const received = entry.acknowledgments.some(ack => ack.stage === 'received');
    entry.receipt = received ? 'received' : 'unconfirmed';
    return entry;
  });
  const allRetained = since === undefined;
  if (allRetained) return entries;
  return entries.filter(entry => entry.at >= since);
}
