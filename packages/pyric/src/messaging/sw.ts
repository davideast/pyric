/**
 * `pyric/messaging/sw` — the `firebase/messaging/sw` (service-worker) mirror
 * over the sandbox {@link MessagingBroker}. Surface `messaging`, rows
 * `messaging#13`–`messaging#17` in `scripts/compat/registry/messaging.ts`.
 *
 * MODULE BOUNDARY (row messaging#17): this entry exports
 * `onBackgroundMessage` / `getMessaging` / the BigQuery metrics toggle /
 * `isSupported` and does NOT export `getToken` / `deleteToken` / `onMessage`
 * — those live in `pyric/messaging`, the mirror image. Both entries
 * re-export identical shared type declarations, and both bind to the SAME
 * per-sandbox broker (production's one-service-worker-per-origin model), so
 * routing between the two planes is a single visibility decision.
 */
import type { PyricApp } from '../app/index.js';
import {
  defaultRegistration,
  deliverToMessaging,
  resolveMessaging,
  stateOf,
  type DeliverSpec,
  type Messaging,
  type SimulatedServiceWorkerRegistration,
} from './instance.js';
import type { DeliveredPayload, DeliveryResult } from './broker/index.js';
import type {
  FcmOptions,
  GetTokenOptions,
  MessagePayload,
  NextFn,
  NotificationPayload,
  Observer,
  Unsubscribe,
} from './index.js';

// Shared type parity with the client entry (row messaging#17).
export type {
  FcmOptions,
  GetTokenOptions,
  MessagePayload,
  Messaging,
  NextFn,
  NotificationPayload,
  Observer,
  Unsubscribe,
};

/**
 * Return the FCM `Messaging` instance for the given (or default) app —
 * service-worker plane (upstream: `getMessagingInSw`, component name
 * `messaging-sw`).
 */
export function getMessaging(app?: PyricApp): Messaging {
  return resolveMessaging('sw', app);
}

/**
 * Called when a message arrives while the app has NO visible window client
 * (oracle: `messaging-web-onbackgroundmessage`,
 * `messaging-web-visibility-routing`). A DATA-ONLY message still fires with
 * no `notification` key (oracle: `messaging-web-data-only-background`), and
 * registering a handler suppresses the SDK auto-display — the sandbox has
 * no display plane, so suppression is the (only) modeled behavior.
 */
export function onBackgroundMessage(
  messaging: Messaging,
  nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>,
): Unsubscribe {
  const state = stateOf(messaging);
  const next = typeof nextOrObserver === 'function' ? nextOrObserver : nextOrObserver.next;
  return state.broker.onBackgroundMessage((payload: DeliveredPayload) => {
    next(payload as unknown as MessagePayload);
  });
}

const bigQueryExport = new WeakMap<Messaging, boolean>();

/**
 * Toggle delivery-metrics export to BigQuery at runtime; default off. The
 * sandbox records the flag (observable via repeated calls) but exports
 * nothing — there is no BigQuery plane to export to.
 */
export function experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
  messaging: Messaging,
  enable: boolean,
): void {
  stateOf(messaging); // validate the instance came from this module family
  bigQueryExport.set(messaging, enable);
}

/** Whether every API FCM requires exists in this (simulated) sw context — always true. */
export async function isSupported(): Promise<boolean> {
  return true;
}

// ── Sandbox-only driver namespace (no upstream counterpart) ──────────────────

export const sandbox = {
  /** Same driver as the client entry — see `pyric/messaging`'s `sandbox.deliver`. */
  deliver(messaging: Messaging, spec: DeliverSpec): Promise<DeliveryResult> {
    return deliverToMessaging(messaging, spec);
  },
  /** The module-default simulated service-worker registration. */
  registration(): SimulatedServiceWorkerRegistration {
    return defaultRegistration();
  },
};

export type { DeliverSpec, DeliveryResult, SimulatedServiceWorkerRegistration };
