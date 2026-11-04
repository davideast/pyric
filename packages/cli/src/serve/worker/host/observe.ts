/**
 * Observed calls: a client reports what production answered a call the app
 * made, and the host writes it to the event stream every traffic view reads.
 *
 * Both hosts reach this through `handleMessage`, which has already refused a
 * malformed record (`inbound-validation.ts`) and bound the frame's caller from
 * the connection (`caller.ts`). The record is read again here so the event is
 * built from a fresh copy that holds only the known fields, never from the
 * frame itself. Pyric runs nothing: no Rules evaluation, no sandbox state.
 */
import { emitSandboxEvent, observedCallEvent, readObservedCall } from 'pyric/sandbox/internal';
import type { ObserveMessage } from '../protocol.js';
import { ok, fail, type HostCtx, type PortLike } from '../host-context.js';
import { callerOf } from './caller.js';

/** Write one observed call to the event stream with its caller, then answer the frame. */
export function handleObserve(ctx: HostCtx, port: PortLike, msg: ObserveMessage): void {
  try {
    const event = observedCallEvent(readObservedCall(msg.call));
    const caller = callerOf(msg);
    emitSandboxEvent(ctx.sandbox, event, {
      actor: { kind: 'app' },
      authLens: { mode: 'app-session' },
      ...(caller === undefined ? {} : { caller }),
    });
    ok(port, msg.id, undefined);
  } catch (error) {
    fail(port, msg.id, error);
  }
}
