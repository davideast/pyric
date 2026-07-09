import type { CompatibilityRow, CompatibilitySurfaceRegistry, Surface } from './types.ts';

/**
 * Messaging compatibility registry — the first surface authored under
 * Conformance Driven Development (CDD; see `docs/conformance/cdd.md`).
 *
 * ROW UNIVERSE. Every row below is signed off by
 * `docs/conformance/messaging/surface-inventory.md` (wayfinder #44), the v1
 * shape universe enumerated from the installed `firebase@12.13.0`
 * (`@firebase/messaging@0.12.26`, client + service-worker planes) and
 * `firebase-admin@13.10.0` (send plane) typings. Instance-method and
 * option-field completeness closes later with the tier-2 assignability census
 * (resolved decision #5); rows here are authored at export / method / named-type
 * granularity, not one row per option field.
 *
 * TWO SURFACES, ONE DOC. Client + service-worker rows carry surface
 * `'messaging'`; admin send-plane rows carry surface `'messaging-admin'`. Both
 * share this one registry file and one generated `COMPAT.md`, on the
 * `rtdb` / `rtdb-modular` precedent (resolved decision #4). Per-surface
 * conformance-suite paths live on the descriptors in `index.ts`.
 *
 * BORN UNVERIFIED. Every row lands `status: 'unverified'`,
 * `automation: 'unverified'`. Where a committed `messaging-*` observation
 * vouches for the behavior the row cites it in `oracleObservations` and states
 * the fact at observed strength — but the row stays `unverified`: citation is
 * not replay (glossary: observed vs conforms, cited vs replayed). No sandbox
 * exists yet, so nothing here can be `conforms`. Rows with no observation are
 * authored from upstream typings/JSDoc at documentation strength and carry a
 * riskReason marking them as probe candidates before implementation.
 */

type SurfacePlane = Extract<Surface, 'messaging' | 'messaging-admin'>;

interface RowSeed {
  surface: SurfacePlane;
  ref: number;
  section: string;
  api: string;
  behavior: string;
  evidence: string;
  /** Committed `messaging-*` observations that vouch for `behavior`. */
  observations?: string[];
  notes?: string;
  /**
   * CDD flip (Step 4): set at review time when the row's assertion set in the
   * conformance suite passes unweakened. The builder then emits
   * status 'conforms' with this automation tier and wires the surface's
   * suite into conformanceTests. Absent = still climbing (born unverified).
   */
  flipped?: 'oracle-backed' | 'unit-backed';
}

const SUITE: Record<SurfacePlane, string> = {
  messaging: 'packages/pyric/test/messaging/oracle-conformance.test.ts',
  'messaging-admin': 'packages/pyric-admin/test/messaging/oracle-conformance.test.ts',
};

const UNOBSERVED_REASON =
  'Behavior stated from upstream typings/JSDoc only (firebase 12.13.0 / firebase-admin 13.10.0); no committed observation yet — a probe candidate before implementation.';
const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited (see evidence), but not yet replayed offline against a sandbox; status stays unverified until the conformance suite replays it.';

function row(seed: RowSeed): CompatibilityRow {
  const observations = seed.observations ?? [];
  const observed = observations.length > 0;
  return {
    id: `${seed.surface}#${seed.ref}`,
    surface: seed.surface,
    aliases: [],
    rowRef: String(seed.ref),
    rowNumber: seed.ref,
    section: seed.section,
    api: seed.api,
    behavior: seed.behavior,
    status: seed.flipped ? 'conforms' : 'unverified',
    evidence: seed.evidence,
    risk: observed ? ['cited-not-replayed'] : ['unobserved'],
    riskScore: observed ? 1 : 2,
    riskReasons: [observed ? CITED_NOT_REPLAYED_REASON : UNOBSERVED_REASON],
    automation: seed.flipped ?? 'unverified',
    oracleObservations: observations,
    conformanceTests: seed.flipped ? [SUITE[seed.surface]] : [],
    ...(seed.notes ? { notes: seed.notes } : {}),
  };
}

// ─── firebase/messaging (client) — surface 'messaging' ───────────────────────
const CLIENT = '`firebase/messaging` (client)';
const clientRows: CompatibilityRow[] = [
  row({
    surface: 'messaging',
    ref: 1,
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'getMessaging(app?): Messaging',
    behavior:
      'Returns the FCM `Messaging` instance associated with the given (or default) `FirebaseApp`. Bound to the client component registered under the name `messaging`.',
    evidence: 'Upstream typings/JSDoc (firebase 12.13.0, `@firebase/messaging` 0.12.26); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 2,
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'getToken(messaging, options?): Promise<string>',
    behavior:
      'Subscribes the instance to push and resolves with an FCM registration token; requests notification permission if not already granted and rejects if denied. Production tokens are colon-separated, URL-safe, ~142 chars, with the suffix after the colon beginning `APA91b`, and are stable across repeated `getToken` calls on the same service-worker registration (no per-call rotation).',
    evidence:
      'oracle: `messaging-web-token-shape.json` (minted, length 142, colon-separated, suffix starts `APA91b`, URL-safe) + `messaging-web-token-stability.json` (second `getToken` on the same registration returns the same token). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-web-token-shape', 'messaging-web-token-stability'],
  }),
  row({
    surface: 'messaging',
    ref: 3,
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'deleteToken(messaging): Promise<boolean>',
    behavior:
      'Deletes the registration token and unsubscribes the instance from its push subscription; resolves truthy. After deletion no message reaches the client on either route, and a server send to the now-dead token eventually surfaces the UNREGISTERED / 404-class error on the send plane (propagation is asynchronous — the first send after delete may still be accepted while delivery has already stopped).',
    evidence:
      'oracle: `messaging-web-deletetoken-unregistered.json` (deleteToken resolved truthy; no delivery to client; send plane eventually UNREGISTERED). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-web-deletetoken-unregistered'],
  }),
  row({
    surface: 'messaging',
    ref: 4,
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'onMessage(messaging, nextOrObserver): Unsubscribe',
    behavior:
      'Dispatched with the push payload when a message arrives while a window client is visible; the returned function stops listening. Routing keys on page VISIBILITY, not focus: a `visibilityState: "visible"` page receives `onMessage` even when unfocused, and when no window client is visible the message routes to the service-worker `onBackgroundMessage` instead.',
    evidence:
      'oracle: `messaging-web-onmessage-foreground.json` (focused page → onMessage) + `messaging-web-visibility-routing.json` (visible → onMessage, no visible client → onBackgroundMessage). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-web-onmessage-foreground', 'messaging-web-visibility-routing'],
  }),
  row({
    surface: 'messaging',
    ref: 5,
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'isSupported(): Promise<boolean>',
    behavior:
      'Resolves whether every API required by FCM exists in the current browser window context (bound to `isWindowSupported`).',
    evidence: 'Upstream typings/JSDoc (`@firebase/messaging` 0.12.26); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 6,
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'interface Messaging { app }',
    behavior: 'Public interface of the FCM client SDK; exposes the bound `FirebaseApp` as `app`.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 7,
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'interface GetTokenOptions { vapidKey?; serviceWorkerRegistration? }',
    behavior:
      'Options for `getToken`: an optional `vapidKey` (Web Push certificate public key) and an optional `serviceWorkerRegistration`.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 8,
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'interface MessagePayload { notification?; data?; fcmOptions?; from; collapseKey; messageId }',
    behavior:
      'Received message envelope delivered to `onMessage` / `onBackgroundMessage`. Production deliveries carry top-level keys `data`, `from`, `messageId`, and `notification`; `from` equals the project messaging sender id and `messageId` is present. (`from`, `collapseKey`, `messageId` are typed as required.)',
    evidence:
      'oracle: `messaging-web-onmessage-foreground.json` + `messaging-web-onbackgroundmessage.json` (top-level keys data/from/messageId/notification; from = sender id; messageId present). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-web-onmessage-foreground', 'messaging-web-onbackgroundmessage'],
  }),
  row({
    surface: 'messaging',
    ref: 9,
    flipped: 'oracle-backed',
    section: CLIENT,
    api: 'interface NotificationPayload { title?; body?; image?; icon? }',
    behavior:
      'Display-notification block inside a `MessagePayload`. Production foreground deliveries carry a `notification` object whose keys include `title` and `body`.',
    evidence:
      'oracle: `messaging-web-onmessage-foreground.json` (notificationKeys body, title). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-web-onmessage-foreground'],
  }),
  row({
    surface: 'messaging',
    ref: 10,
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'interface FcmOptions { link?; analyticsLabel? }',
    behavior: 'WebpushFcmOptions-style options carried on a client `MessagePayload` (`link`, `analyticsLabel`).',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 11,
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'NextFn, Observer, Unsubscribe (re-exported from @firebase/util)',
    behavior:
      'The callback, observer, and teardown types consumed by `onMessage` / `onBackgroundMessage` are re-exported from `@firebase/util`.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 re-exports); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 12,
    flipped: 'unit-backed',
    section: CLIENT,
    api: 'const enum ErrorCode (client)',
    behavior:
      'Client failures surface as thrown `FirebaseError`s carrying one of the 18 documented `ErrorCode` values (`missing-app-config-values`, `only-available-in-window`, `only-available-in-sw`, `permission-default`, `permission-blocked`, `unsupported-browser`, `indexed-db-unsupported`, `failed-service-worker-registration`, `token-subscribe-failed`, `token-subscribe-no-token`, `token-unsubscribe-failed`, `token-update-failed`, `token-update-no-token`, `invalid-bg-handler`, `use-sw-after-get-token`, `invalid-sw-registration`, `use-vapid-key-after-get-token`, `invalid-vapid-key`). The enum itself is `@internal`, not a public export.',
    evidence:
      'Upstream typings (`@firebase/messaging` 0.12.26 `src/util/errors`); no client-error observation among the committed set.',
  }),
];

// ─── firebase/messaging/sw (service worker) — surface 'messaging' ─────────────
const SW = '`firebase/messaging/sw` (service worker)';
const swRows: CompatibilityRow[] = [
  row({
    surface: 'messaging',
    ref: 13,
    flipped: 'unit-backed',
    section: SW,
    api: 'getMessaging(app?): Messaging (sw)',
    behavior:
      'Returns the FCM instance within a service-worker context (bound to `getMessagingInSw`); registers under the component name `messaging-sw`.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 14,
    flipped: 'oracle-backed',
    section: SW,
    api: 'onBackgroundMessage(messaging, nextOrObserver): Unsubscribe',
    behavior:
      'Called when a message arrives while the app has no visible window client. Production routes background deliveries here rather than to `onMessage`; the delivered payload carries `data` / `from` / `messageId` and, for notification messages, a `notification` block. A DATA-ONLY message still fires `onBackgroundMessage` with no `notification` key, and a registered handler suppresses the SDK auto-display.',
    evidence:
      'oracle: `messaging-web-onbackgroundmessage.json` (no visible client → onBackgroundMessage) + `messaging-web-visibility-routing.json` + `messaging-web-data-only-background.json` (data-only fires, no notification key). Cited, not yet replayed (surface climbing under CDD).',
    observations: [
      'messaging-web-onbackgroundmessage',
      'messaging-web-visibility-routing',
      'messaging-web-data-only-background',
    ],
  }),
  row({
    surface: 'messaging',
    ref: 15,
    flipped: 'unit-backed',
    section: SW,
    api: 'experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging, enable): void',
    behavior: 'Enables or disables delivery-metrics export to BigQuery at runtime; default off.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 16,
    flipped: 'unit-backed',
    section: SW,
    api: 'isSupported(): Promise<boolean> (sw)',
    behavior:
      'Resolves whether every API required by FCM exists within the service-worker context (bound to `isSwSupported`).',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`); no observation yet.',
  }),
  row({
    surface: 'messaging',
    ref: 17,
    flipped: 'unit-backed',
    section: SW,
    api: 'firebase/messaging/sw module boundary + shared type parity',
    behavior:
      'The sw entry exports `onBackgroundMessage`, `getMessaging`, `experimentalSetDeliveryMetricsExportedToBigQueryEnabled`, and `isSupported`, but NOT `getToken` / `deleteToken` / `onMessage`; the client entry exports the latter but NOT `onBackgroundMessage` / the metrics toggle. The two modules register under different component names (`messaging` vs `messaging-sw`) and re-export identical `Messaging` / `GetTokenOptions` / `MessagePayload` / `NotificationPayload` / `FcmOptions` type declarations.',
    evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `index.d.ts` / `index.sw.d.ts`); no observation yet.',
  }),
];

// ─── firebase-admin/messaging (send plane) — surface 'messaging-admin' ────────
const ADMIN_ENTRY = '`firebase-admin/messaging` — entry + `Messaging` class';
const adminEntryRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 1,
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'getMessaging(app?): Messaging',
    behavior: 'Returns the `Messaging` service for the default or given admin `App`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `lib/messaging/index`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 2,
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'messaging(app?): messaging.Messaging',
    behavior:
      'Namespaced / legacy accessor equivalent of `getMessaging`, exposed by the compat entry alongside the `namespace messaging` type aliases.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-namespace`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 3,
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.get app(): App',
    behavior: 'The admin `App` this `Messaging` instance is bound to.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 4,
    flipped: 'oracle-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.send(message, dryRun?): Promise<string>',
    behavior:
      'Sends one message via FCM v1 and resolves with the resource name `projects/<projectId>/messages/<numeric id>`. `dryRun=true` returns the SAME shape (fake id), so callers cannot distinguish validation from acceptance by shape. Topic, condition, token, notification-only, data-only, and webpush-config sends are all accepted. Malformed sends fail server-side validation with HTTP 4xx `google.rpc` error envelopes carrying both a `google.rpc.BadRequest` (fieldViolations) and a `google.firebase.fcm.v1.FcmError` (errorCode); detail ordering is not contractual. The documented data-payload cap is 4096 bytes.',
    evidence:
      'oracle: 10 send-plane observations — accept paths `messaging-send-topic-accepted`, `messaging-send-condition-accepted`, `messaging-send-notification-only-vs-data-only-accepted`, `messaging-send-webpush-config-accepted`; error envelopes `messaging-send-no-target-error-envelope`, `messaging-send-invalid-token-error-envelope`, `messaging-send-invalid-condition-error-envelope`, `messaging-send-invalid-topic-name-error-envelope`, `messaging-send-oversized-payload-error-envelope`, `messaging-send-webpush-invalid-ttl-error-envelope`. Cited, not yet replayed (surface climbing under CDD).',
    observations: [
      'messaging-send-topic-accepted',
      'messaging-send-condition-accepted',
      'messaging-send-notification-only-vs-data-only-accepted',
      'messaging-send-webpush-config-accepted',
      'messaging-send-no-target-error-envelope',
      'messaging-send-invalid-token-error-envelope',
      'messaging-send-invalid-condition-error-envelope',
      'messaging-send-invalid-topic-name-error-envelope',
      'messaging-send-oversized-payload-error-envelope',
      'messaging-send-webpush-invalid-ttl-error-envelope',
    ],
  }),
  row({
    surface: 'messaging-admin',
    ref: 5,
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.sendEach(messages, dryRun?): Promise<BatchResponse>',
    behavior:
      'Sends an array of up to 500 messages, one RPC per message; resolves a `BatchResponse` whose `responses` are ordered to match the input. Total failure is signalled by a throw or an all-failure `BatchResponse`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 6,
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.sendEachForMulticast(message, dryRun?): Promise<BatchResponse>',
    behavior: 'Fans a `MulticastMessage` (up to 500 tokens) out through `sendEach`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 7,
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.subscribeToTopic(tokenOrTokens, topic): Promise<MessagingTopicManagementResponse>',
    behavior: 'Subscribes one or many registration tokens to a topic; resolves a `MessagingTopicManagementResponse`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 8,
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.unsubscribeFromTopic(tokenOrTokens, topic): Promise<MessagingTopicManagementResponse>',
    behavior: 'Unsubscribes one or many registration tokens from a topic; resolves a `MessagingTopicManagementResponse`.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 9,
    flipped: 'unit-backed',
    section: ADMIN_ENTRY,
    api: 'Messaging.enableLegacyHttpTransport(): void',
    behavior: 'Forces HTTP/1.1 transport for `sendEach` / `sendEachForMulticast`; deprecated.',
    evidence: 'Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`, `@deprecated`); no observation yet.',
  }),
];

const ADMIN_TARGETS = '`Message` union + targets';
const adminTargetRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 10,
    flipped: 'unit-backed',
    section: ADMIN_TARGETS,
    api: 'type Message = TokenMessage | TopicMessage | ConditionMessage',
    behavior: 'A send payload carrying exactly one of token, topic, or condition.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 11,
    flipped: 'oracle-backed',
    section: ADMIN_TARGETS,
    api: 'interface BaseMessage { data?; notification?; android?; webpush?; apns?; fcmOptions? }',
    behavior:
      'Common message fields shared by every target variant. Production accepts a message carrying ONLY a `notification` block and, separately, ONLY a `data` block — neither is individually required.',
    evidence:
      'oracle: `messaging-send-notification-only-vs-data-only-accepted.json` (both accepted). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-send-notification-only-vs-data-only-accepted'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 12,
    flipped: 'oracle-backed',
    section: ADMIN_TARGETS,
    api: 'interface TokenMessage extends BaseMessage { token: string }',
    behavior:
      'A device-token target. A syntactically invalid token is rejected with HTTP 400 INVALID_ARGUMENT whose fieldViolations name `message.token`.',
    evidence:
      'oracle: `messaging-send-invalid-token-error-envelope.json` (fieldViolations names message.token). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-send-invalid-token-error-envelope'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 13,
    flipped: 'oracle-backed',
    section: ADMIN_TARGETS,
    api: 'interface TopicMessage extends BaseMessage { topic: string }',
    behavior:
      'A topic target. A well-formed topic send is accepted and returns the standard resource name (no subscribers required); a topic name containing characters outside the documented `[a-zA-Z0-9-_.~%]` set is rejected with an INVALID_ARGUMENT error envelope.',
    evidence:
      'oracle: `messaging-send-topic-accepted.json` (accepted) + `messaging-send-invalid-topic-name-error-envelope.json` (bad name rejected). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-send-topic-accepted', 'messaging-send-invalid-topic-name-error-envelope'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 14,
    flipped: 'oracle-backed',
    section: ADMIN_TARGETS,
    api: 'interface ConditionMessage extends BaseMessage { condition: string }',
    behavior:
      'A condition target. A well-formed condition of the form `"\'a\' in topics && \'b\' in topics"` is accepted with the standard resource-name shape (no subscribers required); a malformed condition (dangling operator) is rejected with an error envelope.',
    evidence:
      'oracle: `messaging-send-condition-accepted.json` (accepted) + `messaging-send-invalid-condition-error-envelope.json` (malformed rejected). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-send-condition-accepted', 'messaging-send-invalid-condition-error-envelope'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 15,
    flipped: 'unit-backed',
    section: ADMIN_TARGETS,
    api: 'interface MulticastMessage extends BaseMessage { tokens: string[] }',
    behavior: 'A multicast target of up to 500 tokens, fanned out by `sendEachForMulticast`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
];

const ADMIN_CONFIG = 'Payload / config option shapes';
const adminConfigRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 16,
    flipped: 'oracle-backed',
    section: ADMIN_CONFIG,
    api: 'interface Notification { title?; body?; imageUrl? }',
    behavior:
      'Top-level, platform-independent notification block. Production accepts a notification-only message (no data block).',
    evidence:
      'oracle: `messaging-send-notification-only-vs-data-only-accepted.json`. Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-send-notification-only-vs-data-only-accepted'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 17,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface FcmOptions { analyticsLabel? }',
    behavior: 'Platform-independent FCM options (`analyticsLabel`).',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 18,
    flipped: 'oracle-backed',
    section: ADMIN_CONFIG,
    api: 'interface WebpushConfig { headers?; data?; notification?; fcmOptions? }',
    behavior:
      'Webpush overrides. Production accepts a webpush config carrying `headers.TTL` and `fcmOptions.link`; a non-numeric `headers.TTL` is rejected with an error envelope.',
    evidence:
      'oracle: `messaging-send-webpush-config-accepted.json` (accepted) + `messaging-send-webpush-invalid-ttl-error-envelope.json` (bad TTL rejected). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-send-webpush-config-accepted', 'messaging-send-webpush-invalid-ttl-error-envelope'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 19,
    flipped: 'oracle-backed',
    section: ADMIN_CONFIG,
    api: 'interface WebpushFcmOptions { link? }',
    behavior: 'Webpush FCM options (`link`, HTTPS required). Production accepts `fcmOptions.link` on a webpush send.',
    evidence:
      'oracle: `messaging-send-webpush-config-accepted.json` (link accepted). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-send-webpush-config-accepted'],
  }),
  row({
    surface: 'messaging-admin',
    ref: 20,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface WebpushNotification { title?; actions?; badge?; body?; dir?; icon?; image?; renotify?; requireInteraction?; silent?; tag?; vibrate?; [key] }',
    behavior: 'Web Notification API-shaped options, including an open-ended index signature.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 21,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface ApnsConfig { liveActivityToken?; headers?; payload?; fcmOptions? }',
    behavior: 'APNs overrides.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 22,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface ApnsPayload { aps; [customData] }',
    behavior: 'APNs payload wrapper carrying the required `aps` dictionary plus arbitrary custom keys.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 23,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface Aps { alert?; badge?; sound?; contentAvailable?; mutableContent?; category?; threadId?; [customData] }',
    behavior: 'APNs `aps` dictionary; `alert` is a string or an `ApsAlert`, `sound` a string or a `CriticalSound`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 24,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface ApsAlert { title?; subtitle?; body?; locKey?; locArgs?; ...; launchImage? }',
    behavior: 'APNs alert object with title/subtitle/body and localization keys.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 25,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface CriticalSound { critical?; name; volume? }',
    behavior: 'APNs critical sound — `name` required; `volume` in the range 0.0–1.0.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 26,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface ApnsFcmOptions { analyticsLabel?; imageUrl? }',
    behavior: 'APNs FCM options (`analyticsLabel`, `imageUrl`).',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 27,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface AndroidConfig { collapseKey?; priority?; ttl?; restrictedPackageName?; data?; notification?; fcmOptions?; ... }',
    behavior: 'Android overrides; `ttl` is in milliseconds and `priority` is `high` | `normal`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 28,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface AndroidNotification { title?; body?; icon?; color?; sound?; tag?; imageUrl?; channelId?; priority?; visibility?; lightSettings?; ... }',
    behavior: 'Android notification options, including localization keys, LED light settings, and delivery-proxy controls.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 29,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface LightSettings { color; lightOnDurationMillis; lightOffDurationMillis }',
    behavior: 'Android LED light settings — all three fields required.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 30,
    flipped: 'unit-backed',
    section: ADMIN_CONFIG,
    api: 'interface AndroidFcmOptions { analyticsLabel? }',
    behavior: 'Android FCM options (`analyticsLabel`).',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
];

const ADMIN_LEGACY = 'Legacy payload shapes';
const adminLegacyRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 31,
    flipped: 'unit-backed',
    section: ADMIN_LEGACY,
    api: 'interface DataMessagePayload { [key]: string }',
    behavior: 'Legacy data payload — up to 4KB; the keys `from` and `google.*` are reserved.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 32,
    flipped: 'unit-backed',
    section: ADMIN_LEGACY,
    api: 'interface NotificationMessagePayload { tag?; body?; icon?; badge?; color?; sound?; title?; ...; [key] }',
    behavior: 'Legacy notification payload with localization keys, a `clickAction`, and arbitrary string keys.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 33,
    flipped: 'unit-backed',
    section: ADMIN_LEGACY,
    api: 'interface MessagingPayload { data?; notification? }',
    behavior: 'Legacy combined payload — one or both of `data` / `notification` required.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 34,
    flipped: 'unit-backed',
    section: ADMIN_LEGACY,
    api: 'interface MessagingOptions { dryRun?; priority?; timeToLive?; collapseKey?; mutableContent?; contentAvailable?; restrictedPackageName?; [key] }',
    behavior:
      'Legacy send options; documented defaults are dryRun false, ttl 2419200s (4 weeks), priority high for notifications / normal for data.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
];

const ADMIN_RESPONSES = 'Response shapes';
const adminResponseRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 35,
    flipped: 'unit-backed',
    section: ADMIN_RESPONSES,
    api: 'interface MessagingTopicManagementResponse { failureCount; successCount; errors }',
    behavior: 'Topic subscribe / unsubscribe result carrying per-index errors as `FirebaseArrayIndexError[]`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 36,
    flipped: 'unit-backed',
    section: ADMIN_RESPONSES,
    api: 'interface BatchResponse { responses; successCount; failureCount }',
    behavior: 'Batch send result; `responses` is a `SendResponse[]`.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 37,
    flipped: 'unit-backed',
    section: ADMIN_RESPONSES,
    api: 'interface SendResponse { success; messageId?; error? }',
    behavior: 'Per-message batch entry — on success `messageId` is set, on failure `error` is set.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
  }),
];

const ADMIN_ERRORS = 'Errors';
const adminErrorRows: CompatibilityRow[] = [
  row({
    surface: 'messaging-admin',
    ref: 38,
    flipped: 'unit-backed',
    section: ADMIN_ERRORS,
    api: 'class FirebaseMessagingError extends PrefixedFirebaseError',
    behavior: 'The exported admin messaging error type.',
    evidence: 'Upstream typings (firebase-admin 13.10.0 `lib/messaging/index`); no observation yet.',
  }),
  row({
    surface: 'messaging-admin',
    ref: 39,
    flipped: 'oracle-backed',
    section: ADMIN_ERRORS,
    api: 'class MessagingClientErrorCode',
    behavior:
      'Exported static `{ code, message }` members (`INVALID_ARGUMENT`, `INVALID_RECIPIENT`, `INVALID_PAYLOAD`, … `UNKNOWN_ERROR`). The wire-level `INVALID_ARGUMENT` FcmError returned by malformed sends maps to `MessagingClientErrorCode.INVALID_ARGUMENT`.',
    evidence:
      'oracle: `messaging-send-no-target-error-envelope.json` + `messaging-send-invalid-token-error-envelope.json` (both carry the INVALID_ARGUMENT FcmError). Cited, not yet replayed (surface climbing under CDD).',
    observations: ['messaging-send-no-target-error-envelope', 'messaging-send-invalid-token-error-envelope'],
  }),
];

const INTRO = [
  '# `pyric` messaging compatibility matrix',
  '',
  '> ⚠ **CLIMBING UNDER CDD — nothing is guaranteed yet.** This surface is being',
  '> built Conformance-Driven: the rows below were authored *before* any mirror',
  '> implementation and every one is born `?` (unverified). A row that cites an',
  '> `oracle:` observation states a fact production was **observed** to do — but',
  '> that fact has not yet been **replayed** offline against a sandbox, so the row',
  '> is not a conformance guarantee. See `docs/conformance/cdd.md`.',
  '',
  'The single readable contract for "what `pyric` will guarantee vs the production',
  'Firebase Cloud Messaging surface" — the client (`firebase/messaging`) and',
  'service-worker (`firebase/messaging/sw`) receive planes, and the admin',
  '(`firebase-admin/messaging`) send plane. The signed row universe is',
  '`docs/conformance/messaging/surface-inventory.md` (wayfinder #44).',
  '',
  '## Status legend',
  '',
  '| Status | Meaning |',
  '|---|---|',
  '| ✓ | **Conforming** — sandbox matches prod, locked by a passing probe |',
  '| ⚠ | **Diverged (documented)** — intentional difference with a written reason |',
  '| ✗ | **Bug** — should match prod but doesn\'t; failing probe pins it |',
  '| — | **Unsupported** — not implemented (deliberately or pending) |',
  '| ? | **Unverified** — a target with a derived failing test, not a guarantee |',
  '',
  'Probe references: `oracle:<name>` cites an observation under',
  '`scripts/oracle/observations/<name>.json`. Under CDD a citation records that',
  'production was consulted; it does not certify the sandbox matches — that waits',
  'on the conformance suite replaying it.',
  '',
  '---',
].join('\n');

const rows: CompatibilityRow[] = [
  ...clientRows,
  ...swRows,
  ...adminEntryRows,
  ...adminTargetRows,
  ...adminConfigRows,
  ...adminLegacyRows,
  ...adminResponseRows,
  ...adminErrorRows,
];

export const messagingRegistry: CompatibilitySurfaceRegistry = {
  surface: 'messaging',
  compatPath: 'packages/pyric/docs/messaging/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO + '\n' },
    { kind: 'table', prefix: `## ${CLIENT}\n`, rows: clientRows },
    { kind: 'table', prefix: `## ${SW}\n`, rows: swRows },
    { kind: 'table', prefix: `## ${ADMIN_ENTRY}\n`, rows: adminEntryRows },
    { kind: 'table', prefix: `## ${ADMIN_TARGETS}\n`, rows: adminTargetRows },
    { kind: 'table', prefix: `## ${ADMIN_CONFIG}\n`, rows: adminConfigRows },
    { kind: 'table', prefix: `## ${ADMIN_LEGACY}\n`, rows: adminLegacyRows },
    { kind: 'table', prefix: `## ${ADMIN_RESPONSES}\n`, rows: adminResponseRows },
    { kind: 'table', prefix: `## ${ADMIN_ERRORS}\n`, rows: adminErrorRows },
  ],
};

/** All messaging rows in doc order (client + sw + admin). */
export const messagingRows = rows;
