/**
 * Broker-side messaging types — the sandbox FCM model every plane consumes
 * (client mirror, sw mirror, admin mirror, and later the worker host's
 * `messaging.*` op handlers).
 *
 * These are intentionally the broker's OWN shapes, not re-exports of
 * `firebase-admin/messaging` typings: the admin mirror maps its public
 * `Message` union onto `BrokerMessage` at the boundary, and the client
 * mirrors map `DeliveredPayload` onto their public `MessagePayload`.
 */

/**
 * The intake shape the broker validates and routes. Structurally a
 * permissive superset of `firebase-admin/messaging`'s `Message` union:
 * exactly one of `token` / `topic` / `condition` must be set (enforced by
 * `validateMessage`, per the captured no-target envelope).
 */
export interface BrokerMessage {
  token?: string;
  topic?: string;
  condition?: string;
  data?: Record<string, string>;
  notification?: { title?: string; body?: string; imageUrl?: string };
  webpush?: {
    headers?: Record<string, string>;
    data?: Record<string, string>;
    notification?: Record<string, unknown>;
    fcmOptions?: { link?: string };
  };
  android?: Record<string, unknown>;
  apns?: Record<string, unknown>;
  fcmOptions?: { analyticsLabel?: string };
}

/** A validated send target. `condition.topics` is populated by the parser. */
export type ResolvedTarget =
  | { kind: 'token'; token: string }
  | { kind: 'topic'; topic: string }
  | { kind: 'condition'; condition: string; topics: string[] };

/**
 * An accepted send. `name` is the FCM message resource name:
 * `projects/<projectId>/messages/<id>` where `<id>` is NUMERIC for topic and
 * condition targets and UUID-form for token targets (per-target formats are
 * part of the captured/spec'd contract). Shape-identical for dryRun — the
 * capture pins that callers cannot distinguish validation from acceptance
 * by shape (`dryRunSameShapeAsReal`).
 */
export interface AcceptedSend {
  name: string;
  messageId: string;
  target: ResolvedTarget;
  validateOnly: boolean;
}

/**
 * The envelope delivered to a client plane handler — the mirror of the
 * received `MessagePayload` captured in `messaging-web-onmessage-foreground`
 * / `messaging-web-onbackgroundmessage`: top-level keys are exactly
 * `data` / `from` / `messageId` (+ `notification` for notification
 * messages). A data-only message carries NO `notification` key
 * (`messaging-web-data-only-background`).
 */
export interface DeliveredPayload {
  data?: Record<string, string>;
  notification?: { title?: string; body?: string; image?: string };
  from: string;
  messageId: string;
}

/** How a delivery was routed (the captured visibility rule). */
export type DeliveryRoute = 'foreground' | 'background';

export interface DeliveryResult {
  route: DeliveryRoute;
  /** Handlers actually invoked on the chosen route. */
  handlerCount: number;
  payload: DeliveredPayload;
}

/** Window-client visibility, the ONLY input to routing (never focus). */
export type ClientVisibilityState = 'visible' | 'hidden';

/** Result of a topic subscribe/unsubscribe batch (admin mirror shapes it). */
export interface TopicManagementOutcome {
  successCount: number;
  failureCount: number;
  errors: Array<{ index: number; reason: 'invalid-token' | 'unregistered-token' }>;
}

export interface MessagingBrokerConfig {
  /** Project id minted into message resource names. */
  projectId?: string;
  /**
   * Messaging sender id — the value delivered as `from` on every client
   * payload (`fromEqualsSenderId` is pinned by the foreground/background
   * captures). Defaults to a fixed 12-digit numeric string, matching the
   * project-number shape production uses.
   */
  senderId?: string;
}

/** Handler registered on a client plane. */
export type PayloadHandler = (payload: DeliveredPayload) => void;
