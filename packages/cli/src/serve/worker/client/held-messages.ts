/**
 * Messages the web hosted client holds while it is not attached (ADR-0019
 * decision 7). An operation is held for at most 10 seconds from the moment it
 * was issued; a subscription frame has no deadline. Held messages are sent
 * once, in issue order, after the client's restore traffic.
 */
import { FirebaseError } from 'pyric/app';
import type { InboundMessage } from '../protocol.js';
import { _pending, rejectPendingRequests } from './core.js';
import type { ClientPort } from './handles.js';

const HOLD_DEADLINE_MS = 10_000;
const HOLD_EXPIRED = 'The hosted sandbox connection was not restored within 10 seconds. The request was not sent.';

let holdDeadlineMs = HOLD_DEADLINE_MS;

/**
 * Test-only: shortens the hold deadline for unit tests, and `undefined`
 * restores it. The deadline is fixed at 10 seconds; this is not a user setting
 * and no public entry point exports it.
 */
export function setHoldDeadlineForTesting(ms: number | undefined): void {
  holdDeadlineMs = ms ?? HOLD_DEADLINE_MS;
}

interface HeldMessage {
  message: InboundMessage;
  /** Present for an operation awaiting a reply; it fails when this fires. */
  deadline?: ReturnType<typeof setTimeout>;
}

function requestId(message: InboundMessage): string | undefined {
  const hasId = 'id' in message && typeof message.id === 'string';
  if (hasId) return message.id;
  return undefined;
}

function subscriptionId(message: InboundMessage): string | undefined {
  const isSubscriptionFrame = message.t === 'sub' || message.t === 'unsub';
  if (isSubscriptionFrame) return message.subId;
  return undefined;
}

export interface HeldMessages {
  hold(message: InboundMessage): void;
  /** True while the operation with this correlation id has not been sent. */
  holdsRequest(id: string): boolean;
  /** True for a restore frame of a subscription that is itself still held. */
  holdsSubscription(message: InboundMessage): boolean;
  /** Sends every held message once, in issue order. */
  flush(send: (message: InboundMessage) => void): void;
  /** Forgets every held message without settling it. */
  drop(): void;
  /** Fails every held operation once with `error`, then forgets every held message. */
  fail(error: FirebaseError): void;
}

export function createHeldMessages(port: ClientPort): HeldMessages {
  const held: HeldMessage[] = [];

  function expire(entry: HeldMessage, id: string): void {
    const index = held.indexOf(entry);
    const wasSent = index < 0;
    if (wasSent) return;
    held.splice(index, 1);
    rejectPendingRequests(port, new FirebaseError('unavailable', HOLD_EXPIRED), pendingId => pendingId === id);
  }

  function take(): HeldMessage[] {
    const taken = held.splice(0);
    for (const entry of taken) clearTimeout(entry.deadline);
    return taken;
  }

  return {
    hold(message) {
      const entry: HeldMessage = { message };
      const id = requestId(message);
      const awaitsReply = id !== undefined && _pending.get(id)?.port === port;
      if (awaitsReply) entry.deadline = setTimeout(() => expire(entry, id), holdDeadlineMs);
      held.push(entry);
    },
    holdsRequest(id) {
      return held.some(entry => requestId(entry.message) === id);
    },
    holdsSubscription(message) {
      const subId = subscriptionId(message);
      const isSubscriptionFrame = subId !== undefined;
      if (!isSubscriptionFrame) return false;
      return held.some(entry => entry.message.t === 'sub' && entry.message.subId === subId);
    },
    flush(send) {
      for (const entry of take()) send(entry.message);
    },
    drop() {
      take();
    },
    fail(error) {
      const ids = new Set(take().map(entry => requestId(entry.message)));
      rejectPendingRequests(port, error, id => ids.has(id));
    },
  };
}
