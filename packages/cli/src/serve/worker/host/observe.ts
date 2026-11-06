/**
 * Observed calls: a client reports what production answered a call the app
 * made, and the host writes it to the event stream every traffic view reads.
 *
 * Both hosts reach this through `handleMessage`, which has already refused a
 * malformed record (`inbound-validation.ts`) and bound the frame's caller from
 * the connection (`caller.ts`). The record is read again here so the event is
 * built from a fresh copy that holds only the known fields, never from the
 * frame itself. Pyric serves nothing and changes no sandbox state. For a
 * Firestore or RTDB call it evaluates the same request against the local
 * rules files and records that verdict as `production.local`; production's
 * answer stays the event's result (`observe-local-verdict.ts`).
 */
import { emitSandboxEvent, observedCallEvent, readObservedCall } from 'pyric/sandbox/internal';
import type { ObserveMessage } from '../protocol.js';
import { ok, fail, type HostCtx, type PortLike } from '../host-context.js';
import { callerOf } from './caller.js';
import { localVerdict } from './observe-local-verdict.js';

/** Write one observed call to the event stream with its caller, then answer the frame. */
export function handleObserve(ctx: HostCtx, port: PortLike, msg: ObserveMessage): void {
  try {
    const call = readObservedCall(msg.call);
    const observed = observedCallEvent(call);
    const local = localVerdict(ctx, call);
    const production = observed.production;
    const hasLocal = local !== undefined && production !== undefined;
    const event = hasLocal ? { ...observed, production: { ...production, local } } : observed;
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
