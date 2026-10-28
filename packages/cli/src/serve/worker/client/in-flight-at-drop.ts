/**
 * What becomes of an operation the web hosted client's socket took when that
 * socket drops (ADR-0019 decision 7, amended for #1088).
 *
 * Realtime Database operations follow the table in `../rtdb-drop-fates.ts`,
 * which the Node remote client shares. Every other operation fails once with
 * `unavailable`.
 */
import type { InboundMessage } from '../protocol.js';
import { rtdbFateAtDrop, type DropFate } from '../rtdb-drop-fates.js';
import { forgetPendingRequest, pendingRequestsOn, reissuePendingRequests, rejectPendingRequest } from './core.js';
import type { ClientPort } from './handles.js';
import type { HeldMessages } from './held-messages.js';
import { waitsToSend } from './send-order.js';

function fateOf(message: InboundMessage): DropFate {
  const isOperation = message.t === 'op';
  if (!isOperation) return 'fail';
  return rtdbFateAtDrop(message.method);
}

/**
 * Settles or re-holds every operation the dropped socket took, in issue
 * order. `wasSent` excludes the ones still held, which wait for the attach.
 */
export function settleInFlightAtDrop(
  port: ClientPort,
  held: HeldMessages,
  lost: Error & { code: string },
  wasSent: (id: string) => boolean,
): void {
  const resent: string[] = [];
  for (const { id, message } of pendingRequestsOn(port, id => wasSent(id) && !waitsToSend(port, id))) {
    const fate = fateOf(message);
    if (fate === 'resend') resent.push(id);
    else if (fate === 'forget') forgetPendingRequest(id);
    else if (fate === 'disconnect') rejectPendingRequest(id, new Error('disconnect'));
    else rejectPendingRequest(id, lost);
  }
  // Each goes again under a new id, so a late reply to the copy the dropped
  // socket took settles nothing.
  held.holdAgain(reissuePendingRequests(resent));
}
