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
import type { ObservedCall, Sandbox } from 'pyric/sandbox';
import type { VerifyLiveCallValues } from '../../../verify/fixture.js';
import type { ObserveMessage } from '../protocol.js';
import { ok, fail, type HostCtx, type PortLike } from '../host-context.js';
import { callerOf } from './caller.js';
import { localVerdict } from './observe-local-verdict.js';

/** Each sandbox's live call values, by event id: host memory, read only by the capture. */
const LIVE_CALL_VALUES = new WeakMap<Sandbox, Map<string, VerifyLiveCallValues>>();

/**
 * The values each live call in `sandbox` carried, by event id, for the
 * capture file to hold beside the events. Emails are already left out.
 */
export function liveCallValues(sandbox: Sandbox): ReadonlyMap<string, VerifyLiveCallValues> {
  return LIVE_CALL_VALUES.get(sandbox) ?? new Map();
}

/** A token's claims without the account's email, top level or among its sign-in identities. */
function claimsWithoutEmail(claims: Record<string, unknown>): Record<string, unknown> {
  const { email: _email, ...rest } = claims;
  const firebase = rest.firebase;
  const hasIdentities = isRecord(firebase) && isRecord(firebase.identities);
  if (!hasIdentities) return rest;
  const { email: _identityEmail, ...identities } = firebase.identities as Record<string, unknown>;
  return { ...rest, firebase: { ...firebase, identities } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The values a call carried for the local rules, or `undefined` for none. */
function valuesOf(call: ObservedCall): VerifyLiveCallValues | undefined {
  const claims = call.account?.claims;
  const values: VerifyLiveCallValues = {
    ...(claims === undefined ? {} : { claims: claimsWithoutEmail(claims) }),
    ...(call.writeData === undefined ? {} : { writeData: call.writeData }),
    ...(call.document === undefined ? {} : { document: call.document }),
  };
  return Object.keys(values).length === 0 ? undefined : values;
}

function rememberValues(sandbox: Sandbox, eventId: string, call: ObservedCall): void {
  const values = valuesOf(call);
  if (values === undefined) return;
  const byEvent = LIVE_CALL_VALUES.get(sandbox) ?? new Map<string, VerifyLiveCallValues>();
  byEvent.set(eventId, values);
  LIVE_CALL_VALUES.set(sandbox, byEvent);
}

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
    // Before the emit, so the capture its event schedules finds them.
    rememberValues(ctx.sandbox, event.id, call);
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
