/**
 * Calls the lazy Node remote client holds while it has lost its connection
 * (ADR-0019 decision 7, as amended for #1107).
 *
 * A call issued while the client is not attached is held for at most 10
 * seconds from the moment it was issued, then fails once, unsent. An RTDB
 * call in flight at the drop is held again ahead of every call held now, with
 * no deadline, as the Realtime Database SDK re-sends its outstanding writes
 * and reads on reconnect. `flush` sends every held call once, on the next
 * connection, in that order.
 *
 * Each deadline timer is ref'd: a held call keeps the process alive until it
 * is sent or fails.
 */
import type { RemoteByteRoute } from 'pyric/storage/internal';
import type { WorkerOpPayload } from '../bridge/protocol.js';

const HOLD_DEADLINE_MS = 10_000;
const HOLD_EXPIRED = 'The remote sandbox connection was not restored within 10 seconds. The request was not sent.';

let holdDeadlineMs = HOLD_DEADLINE_MS;

/**
 * Test-only: shortens the hold deadline, and `undefined` restores it. The
 * deadline is fixed at 10 seconds by ADR-0019; this is not a user setting and
 * no public entry point exports it.
 */
export function setHoldDeadlineForTesting(ms: number | undefined): void {
  holdDeadlineMs = ms ?? HOLD_DEADLINE_MS;
}

/** The connection a flush sends on. */
export interface HeldCallTarget {
  op(payload: WorkerOpPayload): Promise<unknown>;
  byteRoute?(): Promise<RemoteByteRoute | undefined>;
}

/** A call the next connection sends again; settling it settles the caller's promise. */
export interface ReleasedOp {
  payload: WorkerOpPayload;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface HeldCall {
  send: (target: HeldCallTarget) => Promise<unknown>;
  /** The op to send; absent for a byte route lookup. */
  payload?: WorkerOpPayload;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Present for a call issued while lost; it fails when this fires. */
  deadline?: ReturnType<typeof setTimeout>;
}

export interface HeldCalls {
  /** Hold an op issued at `issuedAt` (ms since the epoch) until the next flush or its deadline. */
  hold(payload: WorkerOpPayload, issuedAt: number): Promise<unknown>;
  /** Hold a byte route lookup issued at `issuedAt`, under the same deadline. */
  holdByteRoute(issuedAt: number): Promise<RemoteByteRoute | undefined>;
  /** Hold calls a dropped connection took, in their issue order, ahead of every call held now, with no deadline. */
  holdAgain(calls: readonly ReleasedOp[]): void;
  /** Send every held call once on `target`: the held-again calls, then the rest in issue order. */
  flush(target: HeldCallTarget): void;
  /** Fail every held call once with `error`; none is sent. */
  fail(error: Error): void;
  /**
   * Close: forget each held op `isForgotten` picks, unsettled, and fail every
   * other held call once with `error`; none is sent.
   */
  close(error: Error, isForgotten: (payload: WorkerOpPayload) => boolean): void;
  /** How many calls are held. */
  readonly size: number;
}

/** `lastAttempt` names why the last connect attempt failed, for the deadline error. */
export function createHeldCalls(options: { lastAttempt: () => string | undefined }): HeldCalls {
  const held: HeldCall[] = [];

  function take(): HeldCall[] {
    const taken = held.splice(0);
    for (const call of taken) clearTimeout(call.deadline);
    return taken;
  }

  function expiredError(): Error & { code: string } {
    const reason = options.lastAttempt();
    const hasReason = reason !== undefined && reason.length > 0;
    let message = HOLD_EXPIRED;
    if (hasReason) message += ` Last attempt: ${reason.replace(/\.$/, '')}.`;
    return Object.assign(new Error(message), { code: 'unavailable' });
  }

  function expire(call: HeldCall): void {
    const index = held.indexOf(call);
    const wasSent = index < 0;
    if (wasSent) return;
    held.splice(index, 1);
    call.reject(expiredError());
  }

  function admit(send: HeldCall['send'], issuedAt: number, payload?: WorkerOpPayload): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const call: HeldCall = { send, payload, resolve, reject };
      held.push(call);
      // The deadline counts from the call, not from when it reached the hold.
      const remaining = issuedAt + holdDeadlineMs - Date.now();
      call.deadline = setTimeout(() => expire(call), Math.max(0, remaining));
    });
  }

  return {
    hold(payload, issuedAt) {
      return admit((target) => target.op(payload), issuedAt, payload);
    },
    holdByteRoute(issuedAt) {
      return admit(async (target) => target.byteRoute?.(), issuedAt) as Promise<RemoteByteRoute | undefined>;
    },
    holdAgain(calls) {
      const reheld = calls.map((call): HeldCall => ({
        send: (target) => target.op(call.payload),
        payload: call.payload,
        resolve: call.resolve,
        reject: call.reject,
      }));
      held.unshift(...reheld);
    },
    flush(target) {
      for (const call of take()) call.send(target).then(call.resolve, call.reject);
    },
    fail(error) {
      for (const call of take()) call.reject(error);
    },
    close(error, isForgotten) {
      for (const call of take()) {
        const isForgottenOp = call.payload !== undefined && isForgotten(call.payload);
        if (!isForgottenOp) call.reject(error);
      }
    },
    get size() {
      return held.length;
    },
  };
}
