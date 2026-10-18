/**
 * What becomes of an operation the web hosted client's socket took when that
 * socket drops (ADR-0019 decision 7, amended for #1088).
 *
 * Realtime Database operations follow `@firebase/database` 1.1.3. On a drop
 * it clears the response callbacks but keeps its outstanding writes and reads,
 * and `restoreState_` sends them again after it reconnects. An onDisconnect it
 * already sent lives only in those callbacks, so its promise never settles. A
 * sent transaction is cancelled and `runTransaction` rejects with
 * `Error('disconnect')`. Every other operation fails once with `unavailable`.
 */
import type { InboundMessage } from '../protocol.js';
import { forgetPendingRequest, pendingRequestsOn, reissuePendingRequests, rejectPendingRequest } from './core.js';
import type { ClientPort } from './handles.js';
import type { HeldMessages } from './held-messages.js';

type Fate = 'resend' | 'forget' | 'disconnect' | 'fail';

const RTDB_FATES: Readonly<Record<string, Fate>> = {
  'rtdb.set': 'resend',
  'rtdb.setPriority': 'resend',
  'rtdb.setWithPriority': 'resend',
  'rtdb.update': 'resend',
  'rtdb.remove': 'resend',
  'rtdb.push': 'resend',
  'rtdb.get': 'resend',
  'rtdb.onDisconnectSet': 'forget',
  'rtdb.onDisconnectUpdate': 'forget',
  'rtdb.onDisconnectRemove': 'forget',
  'rtdb.onDisconnectCancel': 'forget',
  'rtdb.transactionCommit': 'disconnect',
};

function fateOf(message: InboundMessage): Fate {
  const isOperation = message.t === 'op';
  if (!isOperation) return 'fail';
  return RTDB_FATES[message.method] ?? 'fail';
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
  for (const { id, message } of pendingRequestsOn(port, wasSent)) {
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
