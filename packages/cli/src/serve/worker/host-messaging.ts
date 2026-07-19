/**
 * SharedWorker host — messaging subsystem: the broker's documented
 * worker-host seam, wired (see `pyric/src/messaging/broker/broker.ts`
 * header — each public broker method is one `messaging.*` op here).
 *
 * ONE broker per sandbox (`getMessagingBroker`), shared by every port —
 * production's one-service-worker-per-origin model. Two seams cross the
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
 * routing is foreground iff ANY visible client (oracle:
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

import { type HostCtx, type PortLike, post, ok, fail } from './host-context.js';
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
        const token = broker(ctx).getTokenFor(msg.registrationId ?? DEFAULT_WIRE_REGISTRATION_ID);
        ok(port, msg.id, { token });
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.deleteToken': {
      // Resolves truthy either way (oracle: `messaging-web-deletetoken-unregistered`).
      try {
        ok(port, msg.id, broker(ctx).deleteTokenFor(msg.registrationId ?? DEFAULT_WIRE_REGISTRATION_ID));
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
        ok(port, msg.id, broker(ctx).subscribeToTopic(msg.tokens, msg.topic));
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.unsubscribeFromTopic': {
      try {
        ok(port, msg.id, broker(ctx).unsubscribeFromTopic(msg.tokens, msg.topic));
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
          broker(ctx).setClientVisibility(clientIdFor(ctx, port), visibilityState);
        }
        ok(port, msg.id, broker(ctx).deliver(payload));
      } catch (e) { failMessaging(port, msg.id, e); }
      break;
    }

    case 'messaging.setVisibility': {
      // THE routing input crossing the transport: this port's tab is one
      // window client; its visibility report updates the broker state the
      // captured rule routes on.
      try {
        broker(ctx).setClientVisibility(clientIdFor(ctx, port), msg.state);
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
  const forward = (payload: unknown): void =>
    post(port, { t: 'snap', subId: msg.subId, value: payload });
  const unsub =
    msg.target === 'messaging.foreground'
      ? b.onForegroundMessage(forward)
      : b.onBackgroundMessage(forward);
  portSubs.set(msg.subId, unsub);
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
