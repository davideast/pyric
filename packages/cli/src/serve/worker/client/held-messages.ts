/**
 * Messages the web hosted client holds while it is not attached (ADR-0019
 * decision 7). An operation is held for at most 10 seconds from the moment it
 * was issued; a subscription frame has no deadline. Held messages are sent
 * once, after the client's restore traffic: subscription frames first, then
 * operations, each in issue order (ADR-0019, 2026-10-17 amendment, D5). A
 * page's held session restore that leads the held operations counts as
 * restore traffic and goes first (ADR-0019, 2026-11-03 amendment).
 * An RTDB operation the dropped socket took is held again, ahead of every
 * later operation and with no deadline, as the Realtime Database SDK re-sends
 * its outstanding writes and reads on reconnect (#1088).
 */
import { FirebaseError } from 'pyric/app';
import type { InboundMessage } from '../protocol.js';
import { _pending, rejectPendingRequests } from './core.js';
import type { ClientPort } from './handles.js';
import { issueTime } from './send-order.js';

const HOLD_DEADLINE_MS = 10_000;
const HOLD_EXPIRED = 'The hosted sandbox connection was not restored within 10 seconds. The request was not sent.';
const REMOTE_PAGE_NOTE = ' The host answers clients on its own machine only, so a page opened from another machine cannot connect.';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The hold error; a page not addressed as this machine also hears the likely reason. */
function holdExpiredMessage(): string {
  const hostname = globalThis.location?.hostname;
  const isPageOnThisMachine = hostname === undefined || LOCAL_HOSTNAMES.has(hostname);
  return isPageOnThisMachine ? HOLD_EXPIRED : `${HOLD_EXPIRED}${REMOTE_PAGE_NOTE}`;
}

let holdDeadlineMs = HOLD_DEADLINE_MS;

/**
 * Test-only: shortens the hold deadline for unit tests, and `undefined`
 * restores it. The deadline is fixed at 10 seconds; this is not a user setting
 * and no public entry point exports it.
 */
export function setHoldDeadlineForTesting(ms: number | undefined): void {
  holdDeadlineMs = ms ?? HOLD_DEADLINE_MS;
}

/**
 * Waits, as a held message does, for `settled`, and fails with the hold
 * error once the deadline passes first.
 */
export function withinHoldDeadline(settled: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new FirebaseError('unavailable', holdExpiredMessage())), holdDeadlineMs);
  });
  return Promise.race([settled, expired]).finally(() => clearTimeout(timer));
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

function restoresPortSession(message: InboundMessage): boolean {
  return message.t === 'op' && message.method === 'auth.restorePortSession';
}

function awaitsReply(message: InboundMessage): boolean {
  return message.t === 'op' || message.t === 'tool';
}

/**
 * How many of the held frames that are not subscriptions, in admission
 * order, end with a session restore issued before any other operation. A page
 * restores its persisted sign-in when it first calls `getAuth`, before it can
 * register an observer, so that restore is restore traffic: it goes, with the
 * app configuration posted ahead of it, before the held subscriptions. An
 * `onAuthStateChanged` opened before the first attach then hears the restored
 * user first, as production's first callback waits for the persisted user
 * (#1837). A restore issued after another operation keeps its place.
 */
function sessionRestoreLength(others: HeldMessage[]): number {
  let length = 0;
  for (const [index, entry] of others.entries()) {
    const isRestore = restoresPortSession(entry.message);
    if (isRestore) {
      length = index + 1;
      continue;
    }
    const isOtherOperation = awaitsReply(entry.message);
    if (isOtherOperation) break;
  }
  return length;
}

export interface HeldMessages {
  hold(message: InboundMessage): void;
  /**
   * Holds operations a dropped socket took, in their issue order, ahead of
   * every message held now. They have no deadline: they wait for the next
   * attach, or fail when the client closes.
   */
  holdAgain(messages: InboundMessage[]): void;
  /** True while the operation with this correlation id has not been sent. */
  holdsRequest(id: string): boolean;
  /** True for a restore frame of a subscription that is itself still held. */
  holdsSubscription(message: InboundMessage): boolean;
  /**
   * Forgets the held `sub` frame of a subscription cancelled before it was
   * sent. True when one was held: the host never hears of the subscription.
   */
  forgetSubscription(subId: string): boolean;
  /**
   * Sends every held message once: held session restores that lead the
   * operations, then subscription frames in issue order, then the other held
   * operations in the order they were admitted (D5).
   */
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
    rejectPendingRequests(port, new FirebaseError('unavailable', holdExpiredMessage()), pendingId => pendingId === id);
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
      held.push(entry);
      const isSubscriptionFrame = id === undefined;
      if (isSubscriptionFrame) return;
      const request = _pending.get(id);
      const awaitsReply = request !== undefined && request.port === port;
      if (!awaitsReply) return;
      // The deadline counts from the call, not from when the frame reached the hold.
      const remaining = request.issuedAt + holdDeadlineMs - issueTime();
      const hasExpired = remaining <= 0;
      if (hasExpired) { expire(entry, id); return; }
      entry.deadline = setTimeout(() => expire(entry, id), remaining);
    },
    holdAgain(messages) {
      held.unshift(...messages.map(message => ({ message })));
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
    forgetSubscription(subId) {
      const index = held.findIndex(entry => entry.message.t === 'sub' && entry.message.subId === subId);
      const isHeld = index >= 0;
      if (isHeld) held.splice(index, 1);
      return isHeld;
    },
    flush(send) {
      const taken = take();
      const isSubscriptionEntry = (entry: HeldMessage): boolean => subscriptionId(entry.message) !== undefined;
      const others = taken.filter(entry => !isSubscriptionEntry(entry));
      const restoreCount = sessionRestoreLength(others);
      for (const entry of others.slice(0, restoreCount)) send(entry.message);
      for (const entry of taken.filter(isSubscriptionEntry)) send(entry.message);
      for (const entry of others.slice(restoreCount)) send(entry.message);
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
