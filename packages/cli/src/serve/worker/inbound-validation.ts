import { validateAuthState } from 'pyric/sandbox';
import { readNodeUnobservedLists, readObservedCall } from 'pyric/sandbox/internal';
import { readObservedSessionDelta } from '../observed-session/delta-validation.js';
import type { PortLike } from './host-context.js';
import type { OutboundMessage } from './protocol.js';
import { assertOperationArguments } from './inbound-validation/operation-arguments.js';
import { assertSubscription } from './inbound-validation/subscription.js';
import { isMessageRecord, requireRecord, requireShape, requireString, requireOptionalString,
  requireOptionalBoolean, requireOptionalLabel } from './inbound-validation/fields.js';

/**
 * An observe frame's `sessionData` is optional data riding on a call, not part
 * of the call: one the host cannot read is removed, never a reason to refuse
 * the call. The live host has already counted it as skipped
 * (`live-host-state.ts`), and the call is still answered, counted and printed.
 */
function dropUnreadableSessionData(message: Record<string, unknown>): void {
  if (message.sessionData === undefined) return;
  try {
    readObservedSessionDelta(message.sessionData);
  } catch {
    delete message.sessionData;
  }
}

function assertInboundFields(message: Record<string, unknown>): void {
  requireOptionalString(message.clientSessionId, 'clientSessionId');
  requireOptionalBoolean(message.resumeSession, 'resumeSession');
  const lens = message.actAs;
  const hasLens = lens !== undefined;
  if (hasLens) {
    requireRecord(lens, 'actAs');
    switch (lens.mode) {
      case 'admin': case 'anon': case 'app-session':
        break;
      case 'as':
        validateAuthState(lens);
        break;
      default:
        requireShape(false, 'actAs.mode');
    }
  }
  switch (message.t) {
    case 'op':
      requireString(message.id, 'id');
      requireString(message.method, 'method');
      assertOperationArguments(message);
      return;
    case 'sub':
      requireString(message.subId, 'subId');
      assertSubscription(message);
      return;
    case 'unsub':
      requireString(message.subId, 'subId');
      return;
    case 'disconnect':
      requireString(message.id, 'id');
      return;
    case 'appConfig':
      requireRecord(message.options, 'options');
      requireOptionalBoolean(message.fromPriorHost, 'fromPriorHost');
      requireOptionalBoolean(message.hostVerified, 'hostVerified');
      requireOptionalString(message.origin, 'origin');
      requireOptionalString(message.tabId, 'tabId');
      requireOptionalString(message.clientId, 'clientId');
      return;
    case 'clock-subscribe':
      return;
    case 'tool':
      requireString(message.id, 'id');
      requireString(message.name, 'name');
      requireRecord(message.args, 'args');
      return;
    case 'observe':
      requireString(message.id, 'id');
      readObservedCall(message.call);
      requireOptionalLabel(message.nodeClient, 'nodeClient');
      dropUnreadableSessionData(message);
      return;
    case 'unobserved':
      requireString(message.id, 'id');
      requireShape(readNodeUnobservedLists(message) !== null, 'unobserved');
      return;
    default:
      requireShape(false, 't');
  }
}

/** Refuse malformed calls before routing or allocating execution ownership. */
export function refuseInvalidInboundMessage(port: PortLike, message: unknown): boolean {
  const isRecord = isMessageRecord(message);
  const isNotRecord = !isRecord;
  if (isNotRecord) return true;
  try {
    assertInboundFields(message);
    return false;
  } catch (cause) {
    const isError = cause instanceof Error;
    const error = { code: 'invalid-argument', message: isError ? cause.message : 'Invalid sandbox message.' };
    let reply: OutboundMessage | undefined;
    const subId = message.subId;
    const isSubscription = message.t === 'sub' && typeof subId === 'string';
    if (isSubscription) {
      reply = { t: 'snap', subId, value: { __error: error } };
    } else {
      const id = message.id;
      const hasRequestId = typeof id === 'string';
      if (hasRequestId) reply = { t: 'res', id, ok: false, error };
    }
    const response = reply;
    const hasResponse = response !== undefined;
    if (hasResponse) {
      const clientSessionId = message.clientSessionId;
      const hasClientSessionId = typeof clientSessionId === 'string';
      if (hasClientSessionId) response.clientSessionId = clientSessionId;
      port.postMessage(response);
    }
    return true;
  }
}
