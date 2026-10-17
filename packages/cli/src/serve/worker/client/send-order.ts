/**
 * Call order for a client port (ADR-0019, 2026-10-17 amendment, D1 and D2).
 *
 * Most operations build their frame at the call and post it at once. A few
 * need data that only arrives asynchronously: a Blob's bytes, or the Messaging
 * registration id before it has settled. Such an operation reserves its place
 * at the call. While a reservation on a port is open, every later frame the
 * client posts on that port waits behind it, in call order, and the queue
 * drains as soon as the head is released. A frame waiting here counts as held:
 * its fate is decided at the call, and it reaches the transport in order.
 *
 * With no reservation open, a frame goes straight to `port.postMessage`, which
 * throws synchronously as it always has.
 */
import { FirebaseError } from 'pyric/app';
import type { InboundMessage } from '../protocol.js';
import type { ClientPort } from './handles.js';

type Failed = (error: unknown) => void;

interface QueuedFrame {
  message: InboundMessage;
  failed: Failed | undefined;
}

interface Entry {
  frames: QueuedFrame[];
  /** False while a reservation may still add frames to this place. */
  released: boolean;
}

interface PortOrder {
  entries: Entry[];
  closed: boolean;
}

/** A place in a port's call order, claimed at the call. */
export interface SendReservation {
  /** When the operation was issued; a hold deadline counts from here. */
  readonly issuedAt: number;
  /** Posts `message` in this place. `failed` reports a post that throws. */
  send(message: InboundMessage, failed: Failed): void;
  /** Gives up the place; later frames may go. Calling it again does nothing. */
  release(): void;
}

const orders = new WeakMap<ClientPort, PortOrder>();

function orderOf(port: ClientPort): PortOrder {
  let order = orders.get(port);
  if (order === undefined) {
    order = { entries: [], closed: false };
    orders.set(port, order);
  }
  return order;
}

function appDeleted(): FirebaseError {
  return new FirebaseError('app/app-deleted', 'Firebase App was deleted');
}

function post(port: ClientPort, frame: QueuedFrame): void {
  try {
    port.postMessage(frame.message);
  } catch (error) {
    frame.failed?.(error);
  }
}

/** Posts every frame that is no longer behind an open reservation. */
function drain(port: ClientPort, order: PortOrder): void {
  while (order.entries.length > 0) {
    const head = order.entries[0]!;
    const frames = head.frames.splice(0);
    for (const frame of frames) post(port, frame);
    const isOpen = !head.released;
    if (isOpen) return;
    order.entries.shift();
  }
}

const monotonicClock = (): number => performance.now();
let issueClock = monotonicClock;

/**
 * Test-only: replaces the clock that stamps when an operation was issued, and
 * `undefined` restores it. No public entry point exports it.
 */
export function setIssueClockForTesting(clock: (() => number) | undefined): void {
  issueClock = clock ?? monotonicClock;
}

/** The current time on a monotonic clock, as hold deadlines measure it. */
export function issueTime(): number {
  return issueClock();
}

/**
 * Posts `message` in call order. With nothing reserved ahead of it, this is
 * `port.postMessage` and throws as it does; behind a reservation, it waits
 * and `failed` reports a later post that throws.
 */
export function postInOrder(port: ClientPort, message: InboundMessage, failed?: Failed): void {
  const order = orders.get(port);
  const waits = order !== undefined && order.entries.length > 0;
  if (!waits) {
    port.postMessage(message);
    return;
  }
  order.entries.push({ frames: [{ message, failed }], released: true });
}

/** Claims the next place in the port's call order. */
export function reserveSend(port: ClientPort): SendReservation {
  const order = orderOf(port);
  const entry: Entry = { frames: [], released: false };
  const isClosed = order.closed;
  if (!isClosed) order.entries.push(entry);
  return {
    issuedAt: issueTime(),
    send(message, failed) {
      const isHead = order.entries[0] === entry;
      if (order.closed) { failed(appDeleted()); return; }
      if (isHead) { post(port, { message, failed }); return; }
      entry.frames.push({ message, failed });
    },
    release() {
      if (entry.released) return;
      entry.released = true;
      const isHead = order.entries[0] === entry;
      if (isHead) drain(port, order);
    },
  };
}

/**
 * Forgets every frame waiting on the port and refuses later reservations.
 * The caller settles the waiting operations, as an app's teardown does.
 */
export function closeSendOrder(port: ClientPort): void {
  const order = orderOf(port);
  order.closed = true;
  order.entries.length = 0;
}
