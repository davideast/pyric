import { isBridgeMessage, type BridgeMessage } from '../protocol.js';
import { validateAuthState } from 'pyric/sandbox';
import type { InboundMessage } from '../../serve/worker/protocol.js';

const workerMessageTypes: Record<InboundMessage['t'], true> = {
  op: true,
  sub: true,
  unsub: true,
  disconnect: true,
  appConfig: true,
  'clock-subscribe': true,
  tool: true,
};

function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkerMessageEnvelope(message: unknown): boolean {
  const isMalformedObject = !isProtocolRecord(message);
  if (isMalformedObject) return false;
  const isKnownType = typeof message.t === 'string' && Object.hasOwn(workerMessageTypes, message.t);
  const isUnknownType = !isKnownType;
  if (isUnknownType) return false;
  const needsRequestId = message.t === 'op' || message.t === 'tool' || message.t === 'disconnect';
  if (needsRequestId) return typeof message.id === 'string';
  const needsSubscriptionId = message.t === 'sub' || message.t === 'unsub';
  if (needsSubscriptionId) return typeof message.subId === 'string';
  return true;
}

function isOperationPayload(payload: unknown): boolean {
  const isMalformedObject = !isProtocolRecord(payload);
  if (isMalformedObject) return false;
  return typeof payload.method === 'string';
}

function isSubscriptionPayload(payload: unknown): boolean {
  const isMalformedObject = !isProtocolRecord(payload);
  if (isMalformedObject) return false;
  const isNamedTarget = typeof payload.target === 'string';
  const isDescriptor = isProtocolRecord(payload.target);
  return isNamedTarget || isDescriptor;
}

function isIdentityLens(value: unknown): boolean {
  const isMalformedObject = !isProtocolRecord(value);
  if (isMalformedObject) return false;
  switch (value.mode) {
    case 'admin':
    case 'anon':
    case 'app-session':
      return true;
    case 'as':
      try {
        validateAuthState(value);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Validate request envelopes before dispatch; service handlers own argument semantics. */
export function requestEnvelopeError(frame: BridgeMessage): string | undefined {
  switch (frame.type) {
    case 'hello': {
      const hasMalformedTools = !isStringList(frame.tools);
      const hasMalformedIdentity = typeof frame.sandboxId !== 'string';
      const hasValidCapabilities = frame.capabilities === undefined || isStringList(frame.capabilities);
      const isMalformedHandshake = hasMalformedTools || hasMalformedIdentity || !hasValidCapabilities;
      if (isMalformedHandshake) return 'Invalid sandbox peer handshake.';
      return;
    }
    case 'remote-set-lens': {
      const hasSessionId = typeof frame.clientSessionId === 'string';
      const hasValidRequestId = frame.id === undefined || typeof frame.id === 'string';
      const hasIdentityLens = isIdentityLens(frame.lens);
      const isMalformedLens = !hasSessionId || !hasValidRequestId || !hasIdentityLens;
      if (isMalformedLens) return 'Invalid remote identity lens envelope.';
      return;
    }
    case 'worker-message': {
      const isMalformedMessage = !isWorkerMessageEnvelope(frame.message);
      if (isMalformedMessage) return 'Invalid worker message envelope.';
      return;
    }
    case 'worker-op': {
      const hasRequestId = typeof frame.id === 'string';
      const hasOperation = isOperationPayload(frame.op);
      const isMalformedOperation = !hasRequestId || !hasOperation;
      if (isMalformedOperation) return 'Invalid worker relay operation envelope.';
      return;
    }
    case 'worker-sub': {
      const hasSubscriptionId = typeof frame.subId === 'string';
      const hasSubscription = isSubscriptionPayload(frame.sub);
      const isMalformedSubscription = !hasSubscriptionId || !hasSubscription;
      if (isMalformedSubscription) return 'Invalid worker relay subscription envelope.';
      return;
    }
    case 'worker-unsub': {
      const hasNoSubscriptionId = typeof frame.subId !== 'string';
      if (hasNoSubscriptionId) return 'Invalid worker relay unsubscribe envelope.';
      return;
    }
    default:
      return;
  }
}

/** Handshake versions share one admission policy across mounted and standalone bridges. */
export function requestProtocolError(frame: BridgeMessage): string | undefined {
  const isHandshake = frame.type === 'attach' || frame.type === 'hello';
  if (isHandshake) {
    const isUnsupportedProtocol = frame.protocol !== 1;
    if (isUnsupportedProtocol) return 'Unsupported bridge protocol. Expected version 1.';
  }
}

type ParsedBridgeMessage =
  | { kind: 'message'; message: BridgeMessage }
  | { kind: 'invalid'; reason: string };

/** Decode the outer JSON envelope; request validators check its specific fields. */
export function parseBridgeMessage(raw: string): ParsedBridgeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'Invalid bridge message JSON.' };
  }
  const message = parsed;
  const isKnownMessage = isBridgeMessage(message);
  if (isKnownMessage) return { kind: 'message', message };
  return { kind: 'invalid', reason: 'Unrecognized bridge message envelope.' };
}
