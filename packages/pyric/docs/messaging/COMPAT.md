<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

> **Climb status: this surface is climbing under CDD.**
> Client + service-worker mirror: 17 of 17 rows conforming.
> Separately tracked Admin send plane: 39 of 39 rows conforming.
> A `?` row below is a target with a derived failing test, not a guarantee.

# `pyric` messaging compatibility matrix

<div class="compat-stat">
<p class="compat-stat-surface"><strong>Public surface:</strong> runtime 100% (5/5) <span aria-hidden="true">·</span> types 100% (8/8)</p>
<p class="compat-stat-figure">
<span class="compat-stat-pct">100%</span>
<span class="compat-stat-label">of tracked behaviors conform</span>
</p>
<p class="compat-stat-denom">17 of 17 tracked behaviors</p>
<div class="compat-stat-bar" role="img" aria-label="Behavior distribution: 17 conform, 0 documented divergences, 0 bugs, 0 unsupported, 0 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 17" aria-hidden="true"></span>
</div>
<ul class="compat-stat-key" aria-label="Behavior state counts">
<li class="compat-stat-item"><span class="compat-dot" data-status="ok" aria-hidden="true"></span><span><strong>17</strong> conform</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="diverged" aria-hidden="true"></span><span><strong>0</strong> documented divergences</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="bug" aria-hidden="true"></span><span><strong>0</strong> bugs</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unsupported" aria-hidden="true"></span><span><strong>0</strong> unsupported</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unverified" aria-hidden="true"></span><span><strong>0</strong> unverified</span></li>
</ul>
<p class="compat-stat-note">Public surface measures whether exports exist. Fidelity measures whether tracked behavior matches production.</p>
</div>
[Read how the axes differ.](../conformance/SCORES.md)

> **Published and conformance-held.** The client, service-worker, and admin
> messaging entry points ship in the published `pyric` and `pyric-admin`
> packages. Every row below is replayed by conformance suites that run in
> blocking CI, so the statuses are live guarantees against this repository.

The single readable contract for "what `pyric` will guarantee vs the production
Firebase Cloud Messaging surface" — the client (`firebase/messaging`) and
service-worker (`firebase/messaging/sw`) receive planes, and the admin
(`firebase-admin/messaging`) send plane. The signed row universe is
`packages/conformance/docs/messaging/surface-inventory.md` (wayfinder #44).

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — sandbox matches prod, locked by a passing probe |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match prod but doesn't; failing probe pins it |
| — | **Unsupported** — not implemented (deliberately or pending) |
| ? | **Unverified** — a target with a derived failing test, not a guarantee |

Probe references: `oracle:<name>` cites an observation under
`packages/conformance/observations/<name>.json`. Under CDD a citation records that
production was consulted; it does not certify the sandbox matches — that waits
on the conformance suite replaying it.

---

## `firebase/messaging` (client)

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getMessaging(app?): Messaging |  | Returns the FCM `Messaging` instance associated with the given (or default) `FirebaseApp`. Bound to the client component registered under the name `messaging`. | ✓ | Upstream typings/JSDoc (firebase 12.13.0, `@firebase/messaging` 0.12.26); in-process mirror suite plus canonical-import SharedWorker replay `messaging-app-boundary.pw.ts`. | 1 |
| getToken(messaging, options?): Promise<string> |  | Subscribes the instance to push and resolves with an FCM registration token; requests notification permission if not already granted and rejects if denied. Production tokens are colon-separated, URL-safe, ~142 chars, with the suffix after the colon beginning `APA91b`, and are stable across repeated `getToken` calls on the same service-worker registration (no per-call rotation). | ✓ | oracle: `messaging-web-token-shape.json` (minted, length 142, colon-separated, suffix starts `APA91b`, URL-safe) + `messaging-web-token-stability.json` (second `getToken` on the same registration returns the same token). Replayed by the conformance suite. | 2 |
| deleteToken(messaging): Promise<boolean> |  | Deletes the registration token and unsubscribes the instance from its push subscription; resolves truthy. After deletion no message reaches the client on either route, and a server send to the now-dead token eventually surfaces the UNREGISTERED / 404-class error on the send plane (propagation is asynchronous — the first send after delete may still be accepted while delivery has already stopped). | ✓ | oracle: `messaging-web-deletetoken-unregistered.json` (deleteToken resolved truthy; no delivery to client; send plane eventually UNREGISTERED). Replayed by the conformance suite. | 3 |
| onMessage(messaging, nextOrObserver): Unsubscribe |  | Dispatched with the push payload when a message arrives while a window client is visible; the returned function stops listening. Routing keys on page VISIBILITY, not focus: a `visibilityState: "visible"` page receives `onMessage` even when unfocused, and when no window client is visible the message routes to the service-worker `onBackgroundMessage` instead. | ✓ | oracle: `messaging-web-onmessage-foreground.json` (focused page → onMessage) + `messaging-web-visibility-routing.json` (visible → onMessage, no visible client → onBackgroundMessage). Replayed by the conformance suite. | 4 |
| isSupported(): Promise<boolean> |  | Resolves whether every API required by FCM exists in the current browser window context (bound to `isWindowSupported`). | ✓ | Upstream typings/JSDoc (`@firebase/messaging` 0.12.26); no observation yet. | 5 |
| interface Messaging { app } |  | Public interface of the FCM client SDK; exposes the bound `FirebaseApp` as `app`. | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet. | 6 |
| interface GetTokenOptions { vapidKey?; serviceWorkerRegistration? } |  | Options for `getToken`: an optional `vapidKey` (Web Push certificate public key) and an optional `serviceWorkerRegistration`. | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet. | 7 |
| interface MessagePayload { notification?; data?; fcmOptions?; from; collapseKey; messageId } |  | Received message envelope delivered to `onMessage` / `onBackgroundMessage`. Production deliveries carry top-level keys `data`, `from`, `messageId`, and `notification`; `from` equals the project messaging sender id and `messageId` is present. (`from`, `collapseKey`, `messageId` are typed as required.) | ✓ | oracle: `messaging-web-onmessage-foreground.json` + `messaging-web-onbackgroundmessage.json` (top-level keys data/from/messageId/notification; from = sender id; messageId present). Replayed by the conformance suite. | 8 |
| interface NotificationPayload { title?; body?; image?; icon? } |  | Display-notification block inside a `MessagePayload`. Production foreground deliveries carry a `notification` object whose keys include `title` and `body`. | ✓ | oracle: `messaging-web-onmessage-foreground.json` (notificationKeys body, title). Replayed by the conformance suite. | 9 |
| interface FcmOptions { link?; analyticsLabel? } |  | WebpushFcmOptions-style options carried on a client `MessagePayload` (`link`, `analyticsLabel`). | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet. | 10 |
| NextFn, Observer, Unsubscribe (re-exported from @firebase/util) |  | The callback, observer, and teardown types consumed by `onMessage` / `onBackgroundMessage` are re-exported from `@firebase/util`. | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 re-exports); no observation yet. | 11 |
| const enum ErrorCode (client) |  | Client failures surface as thrown `FirebaseError`s carrying one of the 18 documented `ErrorCode` values (`missing-app-config-values`, `only-available-in-window`, `only-available-in-sw`, `permission-default`, `permission-blocked`, `unsupported-browser`, `indexed-db-unsupported`, `failed-service-worker-registration`, `token-subscribe-failed`, `token-subscribe-no-token`, `token-unsubscribe-failed`, `token-update-failed`, `token-update-no-token`, `invalid-bg-handler`, `use-sw-after-get-token`, `invalid-sw-registration`, `use-vapid-key-after-get-token`, `invalid-vapid-key`). The enum itself is `@internal`, not a public export. | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 `src/util/errors`); no client-error observation among the committed set. | 12 |

## `firebase/messaging/sw` (service worker)

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getMessaging(app?): Messaging (sw) |  | Returns the FCM instance within a service-worker context (bound to `getMessagingInSw`); registers under the component name `messaging-sw`. | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`) plus real module-ServiceWorker served-entry replay `messaging-app-boundary.pw.ts`. | 13 |
| onBackgroundMessage(messaging, nextOrObserver): Unsubscribe |  | Called when a message arrives while the app has no visible window client. Production routes background deliveries here rather than to `onMessage`; the delivered payload carries `data` / `from` / `messageId` and, for notification messages, a `notification` block. A DATA-ONLY message still fires `onBackgroundMessage` with no `notification` key, and a registered handler suppresses the SDK auto-display. | ✓ | oracle: `messaging-web-onbackgroundmessage.json` (no visible client → onBackgroundMessage) + `messaging-web-visibility-routing.json` + `messaging-web-data-only-background.json` (data-only fires, no notification key). Replayed by the conformance suite and by a real module Service Worker connected to the canonical SharedWorker broker in `messaging-app-boundary.pw.ts`. | 14 |
| experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging, enable): void |  | Enables or disables delivery-metrics export to BigQuery at runtime; default off. | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`); no observation yet. | 15 |
| isSupported(): Promise<boolean> (sw) |  | Resolves whether every API required by FCM exists within the service-worker context (bound to `isSwSupported`). | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 `sw/index-public`); no observation yet. | 16 |
| firebase/messaging/sw module boundary + shared type parity |  | The sw entry exports `onBackgroundMessage`, `getMessaging`, `experimentalSetDeliveryMetricsExportedToBigQueryEnabled`, and `isSupported`, but NOT `getToken` / `deleteToken` / `onMessage`; the client entry exports the latter but NOT `onBackgroundMessage` / the metrics toggle. The two modules register under different component names (`messaging` vs `messaging-sw`) and re-export identical `Messaging` / `GetTokenOptions` / `MessagePayload` / `NotificationPayload` / `FcmOptions` type declarations. | ✓ | Upstream typings (`@firebase/messaging` 0.12.26 `index.d.ts` / `index.sw.d.ts`) plus Window and real module-ServiceWorker boundary replay `messaging-app-boundary.pw.ts`. | 17 |

## `firebase-admin/messaging` — entry + `Messaging` class

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getMessaging(app?): Messaging |  | Returns the `Messaging` service for the default or given admin `App`. | ✓ | Upstream typings/JSDoc (firebase-admin 13.10.0 `lib/messaging/index`); no observation yet. | 1 |
| messaging(app?): messaging.Messaging |  | Namespaced / legacy accessor equivalent of `getMessaging`, exposed by the compat entry alongside the `namespace messaging` type aliases. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-namespace`); no observation yet. | 2 |
| Messaging.get app(): App |  | The admin `App` this `Messaging` instance is bound to. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging`); no observation yet. | 3 |
| Messaging.send(message, dryRun?): Promise<string> |  | Sends one message via FCM v1 and resolves with the resource name `projects/<projectId>/messages/<numeric id>`. `dryRun=true` returns the SAME shape (fake id), so callers cannot distinguish validation from acceptance by shape. Topic, condition, token, notification-only, data-only, and webpush-config sends are all accepted. Malformed sends fail server-side validation with HTTP 4xx `google.rpc` error envelopes carrying both a `google.rpc.BadRequest` (fieldViolations) and a `google.firebase.fcm.v1.FcmError` (errorCode); detail ordering is not contractual. The documented data-payload cap is 4096 bytes. | ✓ | oracle: 10 send-plane observations — accept paths `messaging-send-topic-accepted`, `messaging-send-condition-accepted`, `messaging-send-notification-only-vs-data-only-accepted`, `messaging-send-webpush-config-accepted`; error envelopes `messaging-send-no-target-error-envelope`, `messaging-send-invalid-token-error-envelope`, `messaging-send-invalid-condition-error-envelope`, `messaging-send-invalid-topic-name-error-envelope`, `messaging-send-oversized-payload-error-envelope`, `messaging-send-webpush-invalid-ttl-error-envelope`. Replayed by the conformance suite. | 4 |
| Messaging.sendEach(messages, dryRun?): Promise<BatchResponse> |  | Sends an array of up to 500 messages, one RPC per message; resolves a `BatchResponse` whose `responses` are ordered to match the input. Total failure is signalled by a throw or an all-failure `BatchResponse`. | ✓ | Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet. | 5 |
| Messaging.sendEachForMulticast(message, dryRun?): Promise<BatchResponse> |  | Fans a `MulticastMessage` (up to 500 tokens) out through `sendEach`. | ✓ | Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet. | 6 |
| Messaging.subscribeToTopic(tokenOrTokens, topic): Promise<MessagingTopicManagementResponse> |  | Subscribes one or many registration tokens to a topic; resolves a `MessagingTopicManagementResponse`. | ✓ | Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet. | 7 |
| Messaging.unsubscribeFromTopic(tokenOrTokens, topic): Promise<MessagingTopicManagementResponse> |  | Unsubscribes one or many registration tokens from a topic; resolves a `MessagingTopicManagementResponse`. | ✓ | Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`); no observation yet. | 8 |
| Messaging.enableLegacyHttpTransport(): void |  | Forces HTTP/1.1 transport for `sendEach` / `sendEachForMulticast`; deprecated. | ✓ | Upstream typings/JSDoc (firebase-admin 13.10.0 `messaging`, `@deprecated`); no observation yet. | 9 |

## `Message` union + targets

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| type Message = TokenMessage \| TopicMessage \| ConditionMessage |  | A send payload carrying exactly one of token, topic, or condition. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 10 |
| interface BaseMessage { data?; notification?; android?; webpush?; apns?; fcmOptions? } |  | Common message fields shared by every target variant. Production accepts a message carrying ONLY a `notification` block and, separately, ONLY a `data` block — neither is individually required. | ✓ | oracle: `messaging-send-notification-only-vs-data-only-accepted.json` (both accepted). Replayed by the conformance suite. | 11 |
| interface TokenMessage extends BaseMessage { token: string } |  | A device-token target. A syntactically invalid token is rejected with HTTP 400 INVALID_ARGUMENT whose fieldViolations name `message.token`. | ✓ | oracle: `messaging-send-invalid-token-error-envelope.json` (fieldViolations names message.token). Replayed by the conformance suite. | 12 |
| interface TopicMessage extends BaseMessage { topic: string } |  | A topic target. A well-formed topic send is accepted and returns the standard resource name (no subscribers required); a topic name containing characters outside the documented `[a-zA-Z0-9-_.~%]` set is rejected with an INVALID_ARGUMENT error envelope. | ✓ | oracle: `messaging-send-topic-accepted.json` (accepted) + `messaging-send-invalid-topic-name-error-envelope.json` (bad name rejected). Replayed by the conformance suite. | 13 |
| interface ConditionMessage extends BaseMessage { condition: string } |  | A condition target. A well-formed condition of the form `"'a' in topics && 'b' in topics"` is accepted with the standard resource-name shape (no subscribers required); a malformed condition (dangling operator) is rejected with an error envelope. | ✓ | oracle: `messaging-send-condition-accepted.json` (accepted) + `messaging-send-invalid-condition-error-envelope.json` (malformed rejected). Replayed by the conformance suite. | 14 |
| interface MulticastMessage extends BaseMessage { tokens: string[] } |  | A multicast target of up to 500 tokens, fanned out by `sendEachForMulticast`. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 15 |

## Payload / config option shapes

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| interface Notification { title?; body?; imageUrl? } |  | Top-level, platform-independent notification block. Production accepts a notification-only message (no data block). | ✓ | oracle: `messaging-send-notification-only-vs-data-only-accepted.json`. Replayed by the conformance suite. | 16 |
| interface FcmOptions { analyticsLabel? } |  | Platform-independent FCM options (`analyticsLabel`). | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 17 |
| interface WebpushConfig { headers?; data?; notification?; fcmOptions? } |  | Webpush overrides. Production accepts a webpush config carrying `headers.TTL` and `fcmOptions.link`; a non-numeric `headers.TTL` is rejected with an error envelope. | ✓ | oracle: `messaging-send-webpush-config-accepted.json` (accepted) + `messaging-send-webpush-invalid-ttl-error-envelope.json` (bad TTL rejected). Replayed by the conformance suite. | 18 |
| interface WebpushFcmOptions { link? } |  | Webpush FCM options (`link`, HTTPS required). Production accepts `fcmOptions.link` on a webpush send. | ✓ | oracle: `messaging-send-webpush-config-accepted.json` (link accepted). Replayed by the conformance suite. | 19 |
| interface WebpushNotification { title?; actions?; badge?; body?; dir?; icon?; image?; renotify?; requireInteraction?; silent?; tag?; vibrate?; [key] } |  | Web Notification API-shaped options, including an open-ended index signature. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 20 |
| interface ApnsConfig { liveActivityToken?; headers?; payload?; fcmOptions? } |  | APNs overrides. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 21 |
| interface ApnsPayload { aps; [customData] } |  | APNs payload wrapper carrying the required `aps` dictionary plus arbitrary custom keys. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 22 |
| interface Aps { alert?; badge?; sound?; contentAvailable?; mutableContent?; category?; threadId?; [customData] } |  | APNs `aps` dictionary; `alert` is a string or an `ApsAlert`, `sound` a string or a `CriticalSound`. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 23 |
| interface ApsAlert { title?; subtitle?; body?; locKey?; locArgs?; ...; launchImage? } |  | APNs alert object with title/subtitle/body and localization keys. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 24 |
| interface CriticalSound { critical?; name; volume? } |  | APNs critical sound — `name` required; `volume` in the range 0.0–1.0. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 25 |
| interface ApnsFcmOptions { analyticsLabel?; imageUrl? } |  | APNs FCM options (`analyticsLabel`, `imageUrl`). | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 26 |
| interface AndroidConfig { collapseKey?; priority?; ttl?; restrictedPackageName?; data?; notification?; fcmOptions?; ... } |  | Android overrides; `ttl` is in milliseconds and `priority` is `high` \| `normal`. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 27 |
| interface AndroidNotification { title?; body?; icon?; color?; sound?; tag?; imageUrl?; channelId?; priority?; visibility?; lightSettings?; ... } |  | Android notification options, including localization keys, LED light settings, and delivery-proxy controls. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 28 |
| interface LightSettings { color; lightOnDurationMillis; lightOffDurationMillis } |  | Android LED light settings — all three fields required. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 29 |
| interface AndroidFcmOptions { analyticsLabel? } |  | Android FCM options (`analyticsLabel`). | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 30 |

## Legacy payload shapes

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| interface DataMessagePayload { [key]: string } |  | Legacy data payload — up to 4KB; the keys `from` and `google.*` are reserved. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 31 |
| interface NotificationMessagePayload { tag?; body?; icon?; badge?; color?; sound?; title?; ...; [key] } |  | Legacy notification payload with localization keys, a `clickAction`, and arbitrary string keys. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 32 |
| interface MessagingPayload { data?; notification? } |  | Legacy combined payload — one or both of `data` / `notification` required. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 33 |
| interface MessagingOptions { dryRun?; priority?; timeToLive?; collapseKey?; mutableContent?; contentAvailable?; restrictedPackageName?; [key] } |  | Legacy send options; documented defaults are dryRun false, ttl 2419200s (4 weeks), priority high for notifications / normal for data. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 34 |

## Response shapes

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| interface MessagingTopicManagementResponse { failureCount; successCount; errors } |  | Topic subscribe / unsubscribe result carrying per-index errors as `FirebaseArrayIndexError[]`. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 35 |
| interface BatchResponse { responses; successCount; failureCount } |  | Batch send result; `responses` is a `SendResponse[]`. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 36 |
| interface SendResponse { success; messageId?; error? } |  | Per-message batch entry — on success `messageId` is set, on failure `error` is set. | ✓ | Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet. | 37 |

## Errors

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| class FirebaseMessagingError extends PrefixedFirebaseError |  | The exported admin messaging error type. | ✓ | Upstream typings (firebase-admin 13.10.0 `lib/messaging/index`); no observation yet. | 38 |
| class MessagingClientErrorCode |  | Exported static `{ code, message }` members (`INVALID_ARGUMENT`, `INVALID_RECIPIENT`, `INVALID_PAYLOAD`, … `UNKNOWN_ERROR`). The wire-level `INVALID_ARGUMENT` FcmError returned by malformed sends maps to `MessagingClientErrorCode.INVALID_ARGUMENT`. | ✓ | oracle: `messaging-send-no-target-error-envelope.json` + `messaging-send-invalid-token-error-envelope.json` (both carry the INVALID_ARGUMENT FcmError). Replayed by the conformance suite. | 39 |
