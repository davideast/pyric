import type { DeliveryStage, DeliveredPayload } from 'pyric/messaging/internal';
/**
 * SharedWorker and Node host — messaging subsystem: the broker's documented
 * worker-host seam, wired (see `pyric/src/messaging/broker/broker.ts`
 * header — each public broker method is one `messaging.*` op here).
 *
 * ONE broker per sandbox (`getMessagingBroker`), shared by every port —
 * each recipient owns its registrations and observers. Two seams cross the
 * transport:
 *
 *   OPS   token lifecycle (`getToken`/`deleteToken`), the send plane
 *         (`send`, topic management), the delivery driver (`deliver`), and
 *         visibility (`setVisibility`). Send-plane rejections carry the
 *         broker's captured google.rpc envelope VERBATIM on
 *         `error.envelope` (plain JSON, structured-clone-safe).
 *
 *   SUBS  `messaging.foreground` / `messaging.background` register real
 *         broker handlers whose payloads forward to the subscribing port as
 *         snaps. Unsubs ride the ordinary `ctx.subs` registry, so
 *         `cleanupPort` tears them down like Firestore listeners.
 *
 * PER-PORT VISIBILITY — the captured routing rule crossing the transport:
 * each port that reports `messaging.setVisibility` is ONE window client in
 * the broker (`setClientVisibility(portId, state)` on the page's
 * `visibilitychange`). A hidden tab's port marks its client not-visible;
 * routing is foreground iff a visible client belongs to the recipient (oracle:
 * `messaging-web-visibility-routing` — visibility, never focus). Port close
 * removes the client so a dead tab cannot pin foreground routing.
 *
 * HOST CAPABILITY GATE: ops exist only when the ctx was built with
 * `messagingEnabled: true`. Both serve producers enable it because Messaging
 * is part of the canonical Firebase SDK swap. The disabled path remains for
 * standalone host construction and focused tests.
 *
 * Imports only from `./host-context.js` + external packages (host-auth
 * precedent — no circular imports).
 */

import { getMessagingBroker, BrokerSendError } from 'pyric/messaging/internal';
import type { MessagingBroker } from 'pyric/messaging/internal';

import { type HostCtx, type PortLike, post, ok, fail, bestEffortFlush } from './host-context.js';
import type { OpMessage, MessagingSubMessage } from './protocol.js';

/** Registration id used when a `messaging.getToken`/`deleteToken` op names
 *  none — the transport twin of the mirrors' module-default registration. */
export const DEFAULT_WIRE_REGISTRATION_ID = 'swreg-port-default';

const MESSAGING_METHODS = new Set([
  'messaging.getToken',
  'messaging.deleteToken',
  'messaging.send',
  'messaging.subscribeToTopic',
  'messaging.unsubscribeFromTopic',
  'messaging.deliver',
  'messaging.setVisibility',
  'messaging.acknowledge',
]);

/** Is this op method part of the messaging surface? (Routing predicate for
 *  handleMessage — the auth-op precedent.) */
export function isMessagingOp(method: string): boolean {
  return MESSAGING_METHODS.has(method);
}

/** The error every messaging op/sub answers on a host without the capability. */
function disabledError(): { code: string; message: string } {
  return {
    code: 'messaging/disabled',
    message:
      'pyric worker: this host was created without Messaging enabled. ' +
      'Build the worker host ctx with `messagingEnabled: true`.',
  };
}

function broker(ctx: HostCtx): MessagingBroker {
  return getMessagingBroker(ctx.sandbox);
}

// Module-level mint so client ids never collide across delete/re-add on one
// broker (a ctx-map-size mint would reuse ids after removal).
let clientSeq = 0;

/** The port's broker client id, minted on first visibility report. */
function clientIdFor(ctx: HostCtx, port: PortLike): string {
  const clients = (ctx.messagingClients ??= new Map());
  let id = clients.get(port);
  if (id === undefined) {
    id = `port-client-${++clientSeq}`;
    clients.set(port, id);
  }
  return id;
}

/**
 * Fail a messaging op. A `BrokerSendError` crosses the wire as its captured
 * envelope (the seam contract): `code` is the envelope's google.rpc status
 * (`INVALID_ARGUMENT`, `NOT_FOUND`, …), `envelope` the full pinned value.
 */
function failMessaging(port: PortLike, id: string, err: unknown): void {
  if (err instanceof BrokerSendError) {
    post(port, {
      t: 'res',
      id,
      ok: false,
      error: {
        code: err.envelope.error.status,
        message: err.envelope.error.message,
        envelope: err.envelope,
      },
    });
    return;
  }
  fail(port, id, err);
}

export async function handleMessagingOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  if (ctx.messagingEnabled !== true) {
    post(port, { t: 'res', id: msg.id, ok: false, error: disabledError() });
    return;
  }

  switch (msg.method) {
    case 'messaging.getToken': {
      // Stable per registration (oracle: `messaging-web-token-stability`).
      try {
        const token = broker(ctx).getTokenFor(msg.registrationId ?? DEFAULT_WIRE_REGISTRATION_ID, msg.recipientId);
        await bestEffortFlush(ctx);
        ok(port, msg.id, { token });
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.deleteToken': {
      // Resolves truthy either way (oracle: `messaging-web-deletetoken-unregistered`).
      try {
        const deleted = broker(ctx).deleteTokenFor(msg.registrationId ?? DEFAULT_WIRE_REGISTRATION_ID);
        await bestEffortFlush(ctx);
        ok(port, msg.id, deleted);
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.send': {
      // AcceptedSend is plain JSON — replies verbatim. Rejections carry the
      // captured envelope (see failMessaging).
      try {
        const accepted = broker(ctx).send(msg.message, {
          ...(msg.validateOnly !== undefined ? { validateOnly: msg.validateOnly } : {}),
        });
        ok(port, msg.id, accepted);
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.subscribeToTopic': {
      try {
        const outcome = broker(ctx).subscribeToTopic(msg.tokens, msg.topic);
        await bestEffortFlush(ctx);
        ok(port, msg.id, outcome);
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.unsubscribeFromTopic': {
      try {
        const outcome = broker(ctx).unsubscribeFromTopic(msg.tokens, msg.topic);
        await bestEffortFlush(ctx);
        ok(port, msg.id, outcome);
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.deliver': {
      // Test/Studio driver — DeliveryResult { route, handlerCount, payload }
      // is plain JSON. `visibilityState` (the in-page driver's twin) sets THIS
      // port's client visibility before routing, so `pyric/messaging`'s
      // `sandbox.deliver(spec)` picks foreground/background over the transport
      // exactly as in-page: visible → onMessage, hidden → onBackgroundMessage.
      try {
        const { visibilityState, ...payload } = msg.spec;
        if (visibilityState !== undefined) {
          broker(ctx).setClientVisibility(clientIdFor(ctx, port), visibilityState, msg.recipientId);
        }
        ok(port, msg.id, broker(ctx).deliver(payload, msg.recipientId));
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.acknowledge': {
      const acknowledge = ctx.messagingAcknowledgments?.get(port)?.get(msg.subId);
      const accepted = acknowledge?.(msg.messageId, msg.stage) === true;
      if (accepted) ok(port, msg.id, null);
      else fail(port, msg.id, new Error('Messaging acknowledgment has no matching delivery on this subscription.'));
      break;
    }

    case 'messaging.setVisibility': {
      // THE routing input crossing the transport: this port's tab is one
      // window client; its visibility report updates the broker state the
      // captured rule routes on.
      try {
        broker(ctx).setClientVisibility(clientIdFor(ctx, port), msg.state, msg.recipientId);
        ok(port, msg.id, null);
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    default:
      fail(port, msg.id, new Error(`Unknown messaging method: ${String(msg.method)}`));
  }
}

/**
 * Register a foreground/background delivery listener for this port. The
 * broker handler's unsub goes into the ordinary `ctx.subs` registry, so the
 * generic unsub path and `cleanupPort` both tear it down. Payloads are plain
 * JSON (`DeliveredPayload`) — no codec round-trip.
 */
export function handleMessagingSub(ctx: HostCtx, port: PortLike, msg: MessagingSubMessage): void {
  if (ctx.messagingEnabled !== true) {
    // Mirror handleSub's error path: deliver the gate as a snap-error so the
    // client's error callback fires instead of the sub silently dying.
    post(port, { t: 'snap', subId: msg.subId, value: { __error: disabledError() } });
    return;
  }

  if (!ctx.subs.has(port)) ctx.subs.set(port, new Map());
  const portSubs = ctx.subs.get(port)!;
  if (portSubs.has(msg.subId)) return; // idempotent

  const b = broker(ctx);
  const reports: NonNullable<HostCtx['messagingAcknowledgments']> = ctx.messagingAcknowledgments ??= new Map();
  const portReports = reports.get(port) ?? new Map<string, (messageId: string, stage: DeliveryStage) => boolean>();
  reports.set(port, portReports);
  // Bounded by the latest deliveries of this live subscription; cleared on unsubscribe.
  const pending = new Map<string, Set<string>>();
  const observerId = `${clientIdFor(ctx, port)}:${msg.subId}`;
  portReports.set(msg.subId, (messageId, stage) => {
    const stages = pending.get(messageId);
    const unknownMessage = stages === undefined;
    if (unknownMessage) return false;
    const alreadyReported = stages.has(stage);
    if (alreadyReported) return true;
    stages.add(stage);
    b.acknowledge(messageId, msg.recipientId ?? 'sandbox-default', observerId, stage);
    return true;
  });
  const forward = (payload: DeliveredPayload): void => {
    pending.set(payload.messageId, new Set());
    const oldest = pending.keys().next();
    const overCapacity = pending.size > 32 && !oldest.done;
    if (overCapacity) pending.delete(oldest.value);
    post(port, { t: 'snap', subId: msg.subId, value: payload });
  };
  const unsub =
    msg.target === 'messaging.foreground'
      ? b.onForegroundMessage(forward, msg.recipientId)
      : b.onBackgroundMessage(forward, msg.recipientId);
  portSubs.set(msg.subId, () => {
    unsub();
    pending.clear();
    portReports.delete(msg.subId);
    const unusedPort = portReports.size === 0;
    if (unusedPort) reports.delete(port);
  });
}

/**
 * Drop a disconnected port's broker client so its last-reported visibility
 * stops feeding the routing rule (a closed visible tab must not pin
 * foreground routing forever). Handler subs are NOT touched here — they
 * live in `ctx.subs`, which `cleanupPort` already tears down.
 */
export function cleanupPortMessaging(ctx: HostCtx, port: PortLike): void {
  const id = ctx.messagingClients?.get(port);
  if (id === undefined) return;
  ctx.messagingClients!.delete(port);
  broker(ctx).removeClient(id);
}
