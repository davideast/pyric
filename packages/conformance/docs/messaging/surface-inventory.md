# Ticket #44 Resolution: Public surface of firebase/messaging, firebase/messaging/sw, firebase-admin/messaging (from installed packages)

## Provenance
Enumerated from the packages installed in this repo, not from upstream source.
- `firebase@12.13.0` -> `firebase/messaging` and `firebase/messaging/sw` both re-export the bundled `@firebase/messaging@0.12.26`. The real typings resolve through `node_modules/.bun/@firebase+messaging@0.12.26+f3d6e4e088e70e1e/node_modules/@firebase/messaging/dist/` (`index-public.d.ts`, `sw/index-public.d.ts`, `src/interfaces/public-types.d.ts`, `src/util/errors.d.ts`, runtime index `src/index.d.ts` / `src/index.sw.d.ts`). The thin re-export shims are `node_modules/firebase/messaging/dist/messaging/index.d.ts` and `.../sw/index.d.ts`.
- `firebase-admin@13.10.0` -> `firebase-admin/messaging` at `node_modules/firebase-admin/lib/messaging/` (`index.d.ts`, `messaging.d.ts`, `messaging-api.d.ts`, `messaging-namespace.d.ts`) plus error codes at `node_modules/firebase-admin/lib/utils/error.d.ts`.

Behavior claims below are the one-liners the typings themselves state (paraphrased from the JSDoc). "Evidenced tonight" points at the committed observations under `packages/conformance/observations/`.

---

## Module: firebase/messaging (client) — mark: client
Runtime value exports (per `src/index.d.ts`): `getToken`, `deleteToken`, `onMessage`, `getMessaging`, `isSupported`. Everything else is a type-only export.

Functions:
- `getMessaging(app?: FirebaseApp): Messaging` — client — returns the FCM instance associated with the given (or default) FirebaseApp.
- `getToken(messaging: Messaging, options?: GetTokenOptions): Promise<string>` — client — subscribes the instance to push and resolves with an FCM registration token; asks for notification permission if not granted and rejects if denied. **Evidenced tonight** by `messaging-web-token-shape.json` (minted, length 142, colon-separated, suffix after colon starts `APA91b`, URL-safe).
- `deleteToken(messaging: Messaging): Promise<boolean>` — client — deletes the registration token and unsubscribes the instance from the push subscription.
- `onMessage(messaging: Messaging, nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>): Unsubscribe` — client — dispatched with the push payload when a message arrives while the user is viewing the page; returned fn stops listening. **Evidenced tonight** by `messaging-web-onmessage-foreground.json` (focused page -> delivered to onMessage, payload top-level keys data/from/messageId/notification).
- `isSupported(): Promise<boolean>` — client — resolves whether all required APIs exist in the browser (bound to `isWindowSupported`).

Types / option shapes:
- `interface Messaging { app: FirebaseApp }` — client — public interface of the FCM SDK.
- `interface GetTokenOptions { vapidKey?: string; serviceWorkerRegistration?: ServiceWorkerRegistration }` — client — options for `getToken`; both fields exercised by the token-shape probe.
- `interface MessagePayload { notification?: NotificationPayload; data?: {[key:string]:string}; fcmOptions?: FcmOptions; from: string; collapseKey: string; messageId: string }` — client — received message envelope (`from`/`collapseKey`/`messageId` are required). **Evidenced tonight**: onmessage/onbackgroundmessage observations confirm top-level keys `data`, `from`, `messageId`, `notification`.
- `interface NotificationPayload { title?: string; body?: string; image?: string; icon?: string }` — client — display notification details. **Evidenced tonight**: observation notificationKeys `body`, `title`.
- `interface FcmOptions { link?: string; analyticsLabel?: string }` — client — WebpushFcmOptions-style options.
- Re-exported from `@firebase/util`: `NextFn`, `Observer`, `Unsubscribe` — client — callback/observer/teardown types used by `onMessage`.
- `_FirebaseMessagingName` (type `'messaging'`) — client — marked `@internal` / excluded from release types; not part of the public surface.

---

## Module: firebase/messaging/sw (service worker) — mark: sw
Runtime value exports (per `src/index.sw.d.ts`): `onBackgroundMessage`, `getMessaging`, `experimentalSetDeliveryMetricsExportedToBigQueryEnabled`, `isSupported`. Type exports mirror the client module.

Functions:
- `getMessaging(app?: FirebaseApp): Messaging` — sw — returns the FCM instance (bound to `getMessagingInSw`).
- `onBackgroundMessage(messaging: Messaging, nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>): Unsubscribe` — sw — called when a message is received while the app is in the background (no active window displayed). **Evidenced tonight** by `messaging-web-onbackgroundmessage.json` (no visible client -> delivered to onBackgroundMessage rather than onMessage).
- `experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging: Messaging, enable: boolean): void` — sw — enables/disables delivery-metrics export to BigQuery at runtime (default off). Not evidenced tonight.
- `isSupported(): Promise<boolean>` — sw — resolves whether required APIs exist within the SW context (bound to `isSwSupported`).

Types / option shapes (identical declarations to client): `Messaging`, `GetTokenOptions`, `MessagePayload`, `NotificationPayload`, `FcmOptions`, plus re-exported `NextFn`, `Observer`, `Unsubscribe`. Note: `getToken`/`deleteToken`/`onMessage` are NOT exported from the sw module; `onBackgroundMessage` and the metrics toggle are NOT exported from the client module. The two modules register under different component names (`'messaging'` vs `'messaging-sw'`).

Client error codes (const enum `ErrorCode` in `src/util/errors.d.ts`, surfaced through thrown `FirebaseError`s, not exported as public API): `missing-app-config-values`, `only-available-in-window`, `only-available-in-sw`, `permission-default`, `permission-blocked`, `unsupported-browser`, `indexed-db-unsupported`, `failed-service-worker-registration`, `token-subscribe-failed`, `token-subscribe-no-token`, `token-unsubscribe-failed`, `token-update-failed`, `token-update-no-token`, `invalid-bg-handler`, `use-sw-after-get-token`, `invalid-sw-registration`, `use-vapid-key-after-get-token`, `invalid-vapid-key`. Not evidenced tonight (no client-error observation among the committed set).

---

## Module: firebase-admin/messaging — mark: admin
Runtime value exports (per `lib/messaging/index.d.ts`): `getMessaging`, the `Messaging` class, `FirebaseMessagingError`, `MessagingClientErrorCode`. All the `*Config`/`*Message`/payload interfaces are type-only. `messaging-namespace.d.ts` additionally exposes the legacy `messaging(app?)` callable + `namespace messaging` type aliases for the compat/namespaced entry.

Entry functions:
- `getMessaging(app?: App): Messaging` — admin — returns the `Messaging` service for the default or given app.
- `messaging(app?: App): messaging.Messaging` — admin — namespaced/legacy accessor equivalent of `getMessaging`.

Class `Messaging` (methods in `messaging.d.ts`):
- `get app(): App` — admin — the App this instance is bound to.
- `send(message: Message, dryRun?: boolean): Promise<string>` — admin — sends one message via FCM, resolves with a unique message ID string. **Evidenced tonight** by `messaging-send-topic-accepted.json` (returns `projects/<projectId>/messages/<numeric id>`; dryRun returns same shape so validation is indistinguishable from acceptance by shape) and by the error-envelope observations `messaging-send-invalid-token-error-envelope.json` and `messaging-send-no-target-error-envelope.json` (HTTP 400 INVALID_ARGUMENT, google.rpc envelope carrying both google.rpc.BadRequest fieldViolations and google.firebase.fcm.v1.FcmError errorCode; detail ordering non-contractual).
- `sendEach(messages: Message[], dryRun?: boolean): Promise<BatchResponse>` — admin — one RPC per message (up to 500); responses ordered to match input; total failure signalled by throw or all-failure BatchResponse. Not evidenced tonight.
- `sendEachForMulticast(message: MulticastMessage, dryRun?: boolean): Promise<BatchResponse>` — admin — fans a multicast (up to 500 tokens) out through `sendEach`. Not evidenced tonight.
- `subscribeToTopic(registrationTokenOrTokens: string | string[], topic: string): Promise<MessagingTopicManagementResponse>` — admin — subscribes one or many tokens to a topic. Not evidenced tonight.
- `unsubscribeFromTopic(registrationTokenOrTokens: string | string[], topic: string): Promise<MessagingTopicManagementResponse>` — admin — unsubscribes one or many tokens from a topic. Not evidenced tonight.
- `enableLegacyHttpTransport(): void` — admin — forces HTTP/1.1 transport for `sendEach`/`sendEachForMulticast`; marked `@deprecated`. Not evidenced tonight.
- (private: `parseSendResponses`, `getUrlPath`, `sendTopicManagementRequest`, `validateRegistrationTokensType`, `validateRegistrationTokens`, `validateTopicType`, `validateTopic`, `normalizeTopic` — not public surface.)

Message union / targets:
- `type Message = TokenMessage | TopicMessage | ConditionMessage` — admin — send payload with exactly one of token/topic/condition.
- `interface BaseMessage { data?; notification?; android?; webpush?; apns?; fcmOptions? }` — admin — common fields.
- `interface TokenMessage extends BaseMessage { token: string }` — admin. **Evidenced tonight** (invalid-token error envelope, fieldViolations names `message.token`).
- `interface TopicMessage extends BaseMessage { topic: string }` — admin. **Evidenced tonight** (topic-accepted).
- `interface ConditionMessage extends BaseMessage { condition: string }` — admin. Not evidenced among committed set (an untracked `messaging-send-condition-accepted.json` exists but is not committed).
- `interface MulticastMessage extends BaseMessage { tokens: string[] }` — admin — up to 500 tokens.

Payload / config option shapes (all admin):
- `interface Notification { title?; body?; imageUrl? }` — top-level notification.
- `interface FcmOptions { analyticsLabel? }` — platform-independent FCM options.
- `interface WebpushConfig { headers?; data?; notification?: WebpushNotification; fcmOptions?: WebpushFcmOptions }`.
- `interface WebpushFcmOptions { link? }` — HTTPS required for link.
- `interface WebpushNotification { title?; actions?: {action; icon?; title}[]; badge?; body?; data?; dir?: 'auto'|'ltr'|'rtl'; icon?; image?; lang?; renotify?; requireInteraction?; silent?; tag?; timestamp?; vibrate?: number|number[]; [key:string]: any }`.
- `interface ApnsConfig { liveActivityToken?; headers?; payload?: ApnsPayload; fcmOptions?: ApnsFcmOptions }`.
- `interface ApnsPayload { aps: Aps; [customData:string]: any }`.
- `interface Aps { alert?: string|ApsAlert; badge?; sound?: string|CriticalSound; contentAvailable?; mutableContent?; category?; threadId?; [customData:string]: any }`.
- `interface ApsAlert { title?; subtitle?; body?; locKey?; locArgs?; titleLocKey?; titleLocArgs?; subtitleLocKey?; subtitleLocArgs?; actionLocKey?; launchImage? }`.
- `interface CriticalSound { critical?; name: string; volume? }` — volume 0.0–1.0.
- `interface ApnsFcmOptions { analyticsLabel?; imageUrl? }`.
- `interface AndroidConfig { collapseKey?; priority?: 'high'|'normal'; ttl?; restrictedPackageName?; data?; notification?: AndroidNotification; fcmOptions?: AndroidFcmOptions; directBootOk?; bandwidthConstrainedOk?; restrictedSatelliteOk? }` — ttl in ms.
- `interface AndroidNotification { title?; body?; icon?; color?; sound?; tag?; imageUrl?; clickAction?; bodyLocKey?; bodyLocArgs?; titleLocKey?; titleLocArgs?; channelId?; ticker?; sticky?; eventTimestamp?: Date; localOnly?; priority?: 'min'|'low'|'default'|'high'|'max'; vibrateTimingsMillis?: number[]; defaultVibrateTimings?; defaultSound?; lightSettings?: LightSettings; defaultLightSettings?; visibility?: 'private'|'public'|'secret'; notificationCount?; proxy?: 'allow'|'deny'|'if_priority_lowered' }`.
- `interface LightSettings { color: string; lightOnDurationMillis: number; lightOffDurationMillis: number }` — all required.
- `interface AndroidFcmOptions { analyticsLabel? }`.

Legacy (still exported) shapes, all admin:
- `interface DataMessagePayload { [key:string]: string }` — up to 4KB; keys `from` and `google.*` reserved.
- `interface NotificationMessagePayload { tag?; body?; icon?; badge?; color?; sound?; title?; bodyLocKey?; bodyLocArgs?; clickAction?; titleLocKey?; titleLocArgs?; [key:string]: string|undefined }`.
- `interface MessagingPayload { data?: DataMessagePayload; notification?: NotificationMessagePayload }` — one or both required.
- `interface MessagingOptions { dryRun?; priority?: string; timeToLive?; collapseKey?; mutableContent?; contentAvailable?; restrictedPackageName?; [key:string]: any }` — defaults: dryRun false, ttl 2419200s (4 weeks), priority high for notifications / normal for data.

Response shapes, all admin:
- `interface MessagingTopicManagementResponse { failureCount; successCount; errors: FirebaseArrayIndexError[] }`.
- `interface BatchResponse { responses: SendResponse[]; successCount; failureCount }`.
- `interface SendResponse { success: boolean; messageId?: string; error?: FirebaseError }` — on success messageId set, on failure error set.

Errors, admin:
- `class FirebaseMessagingError extends PrefixedFirebaseError` — exported.
- `class FirebaseMessagingSessionError extends FirebaseMessagingError { pendingBatchResponse?: Promise<BatchResponse>; toJSON(): object }` — declared in utils/error but not re-exported from the messaging entry.
- `class MessagingClientErrorCode` — exported; static `{code, message}` members: `INVALID_ARGUMENT`, `INVALID_RECIPIENT`, `INVALID_PAYLOAD`, `INVALID_DATA_PAYLOAD_KEY`, `PAYLOAD_SIZE_LIMIT_EXCEEDED`, `INVALID_OPTIONS`, `INVALID_REGISTRATION_TOKEN`, `REGISTRATION_TOKEN_NOT_REGISTERED`, `MISMATCHED_CREDENTIAL`, `INVALID_PACKAGE_NAME`, `DEVICE_MESSAGE_RATE_EXCEEDED`, `TOPICS_MESSAGE_RATE_EXCEEDED`, `MESSAGE_RATE_EXCEEDED`, `THIRD_PARTY_AUTH_ERROR`, `TOO_MANY_TOPICS`, `AUTHENTICATION_ERROR`, `SERVER_UNAVAILABLE`, `INTERNAL_ERROR`, `UNKNOWN_ERROR`. **Partially evidenced tonight**: the two error-envelope observations show the wire-level `INVALID_ARGUMENT` FcmError that maps to `MessagingClientErrorCode.INVALID_ARGUMENT`.

---

## Evidence coverage summary
Committed observations tonight touch 4 of the public entries: client `getToken` + `MessagePayload`/`NotificationPayload` (token-shape, onmessage-foreground), sw `onBackgroundMessage` (onbackgroundmessage), admin `Messaging.send` across `TopicMessage`/`TokenMessage` plus the `INVALID_ARGUMENT` error envelope (topic-accepted, invalid-token-envelope, no-target-envelope). Everything else in this inventory (client `deleteToken`/`onMessage`... wait onMessage is covered; `deleteToken`, `isSupported`, `getMessaging`; sw metrics toggle, `getMessaging`, `isSupported`; admin `sendEach`, `sendEachForMulticast`, `subscribeToTopic`, `unsubscribeFromTopic`, `enableLegacyHttpTransport`, and all option-field shapes and error codes beyond INVALID_ARGUMENT) is enumerated from typings only and is not yet evidenced by a committed observation.

## Gist for Decisions-so-far
Public messaging surface enumerated from installed firebase@12.13.0 (@firebase/messaging 0.12.26: client 5 fns + sw 4 fns over shared Messaging/GetTokenOptions/MessagePayload/NotificationPayload/FcmOptions and an 18-value client ErrorCode enum) and firebase-admin@13.10.0 (Messaging class with send/sendEach/sendEachForMulticast/subscribe/unsubscribe/enableLegacyHttpTransport plus ~25 config/payload interfaces and 19-member MessagingClientErrorCode); tonight's committed observations evidence only client getToken/onMessage, sw onBackgroundMessage, and admin send (topic + INVALID_ARGUMENT envelope).