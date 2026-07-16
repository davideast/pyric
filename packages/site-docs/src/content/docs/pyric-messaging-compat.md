---
title: "pyric messaging compatibility matrix"
navLabel: "Messaging"
group: "Conformance"
section: ""
order: 6010
---
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
[Read how the axes differ.](../pyric-conformance-scores/)

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

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span><strong>Conforming</strong> — sandbox matches prod, locked by a passing probe</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span><strong>Diverged (documented)</strong> — intentional difference with a written reason</span>
<span class="compat-key-item"><span class="compat-dot" data-status="bug"></span><strong>Bug</strong> — should match prod but doesn't; failing probe pins it</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span><strong>Unsupported</strong> — not implemented (deliberately or pending)</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span><strong>Unverified</strong> — a target with a derived failing test, not a guarantee</span>
</div>

Probe references: `oracle:<name>` cites an observation under
`packages/conformance/observations/<name>.json`. Under CDD a citation records that
production was consulted; it does not certify the sandbox matches — that waits
on the conformance suite replaying it.

---

## `firebase/messaging` (client)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getMessaging(app?): Messaging</code><span class="compat-sub"><span class="compat-behavior">Returns the FCM <code>Messaging</code> instance associated with the given (or default) <code>FirebaseApp</code>. Bound to the client component registered under the name <code>messaging</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase 12.13.0, <code>@firebase/messaging</code> 0.12.26); in-process mirror suite plus canonical-import SharedWorker replay <code>messaging-app-boundary.pw.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getToken(messaging, options?): Promise&lt;string&gt;</code><span class="compat-sub"><span class="compat-behavior">Subscribes the instance to push and resolves with an FCM registration token; requests notification permission if not already granted and rejects if denied. Production tokens are colon-separated, URL-safe, ~142 chars, with the suffix after the colon beginning <code>APA91b</code>, and are stable across repeated <code>getToken</code> calls on the same service-worker registration (no per-call rotation).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-token-shape.json</code> (minted, length 142, colon-separated, suffix starts <code>APA91b</code>, URL-safe) + <code>messaging-web-token-stability.json</code> (second <code>getToken</code> on the same registration returns the same token). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">deleteToken(messaging): Promise&lt;boolean&gt;</code><span class="compat-sub"><span class="compat-behavior">Deletes the registration token and unsubscribes the instance from its push subscription; resolves truthy. After deletion no message reaches the client on either route, and a server send to the now-dead token eventually surfaces the UNREGISTERED / 404-class error on the send plane (propagation is asynchronous — the first send after delete may still be accepted while delivery has already stopped).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-deletetoken-unregistered.json</code> (deleteToken resolved truthy; no delivery to client; send plane eventually UNREGISTERED). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">onMessage(messaging, nextOrObserver): Unsubscribe</code><span class="compat-sub"><span class="compat-behavior">Dispatched with the push payload when a message arrives while a window client is visible; the returned function stops listening. Routing keys on page VISIBILITY, not focus: a <code>visibilityState: "visible"</code> page receives <code>onMessage</code> even when unfocused, and when no window client is visible the message routes to the service-worker <code>onBackgroundMessage</code> instead.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-onmessage-foreground.json</code> (focused page → onMessage) + <code>messaging-web-visibility-routing.json</code> (visible → onMessage, no visible client → onBackgroundMessage). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">isSupported(): Promise&lt;boolean&gt;</code><span class="compat-sub"><span class="compat-behavior">Resolves whether every API required by FCM exists in the current browser window context (bound to <code>isWindowSupported</code>).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (<code>@firebase/messaging</code> 0.12.26); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface Messaging { app }</code><span class="compat-sub"><span class="compat-behavior">Public interface of the FCM client SDK; exposes the bound <code>FirebaseApp</code> as <code>app</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>public-types</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface GetTokenOptions { vapidKey?; serviceWorkerRegistration? }</code><span class="compat-sub"><span class="compat-behavior">Options for <code>getToken</code>: an optional <code>vapidKey</code> (Web Push certificate public key) and an optional <code>serviceWorkerRegistration</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>public-types</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface MessagePayload { notification?; data?; fcmOptions?; from; collapseKey; messageId }</code><span class="compat-sub"><span class="compat-behavior">Received message envelope delivered to <code>onMessage</code> / <code>onBackgroundMessage</code>. Production deliveries carry top-level keys <code>data</code>, <code>from</code>, <code>messageId</code>, and <code>notification</code>; <code>from</code> equals the project messaging sender id and <code>messageId</code> is present. (<code>from</code>, <code>collapseKey</code>, <code>messageId</code> are typed as required.)</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-onmessage-foreground.json</code> + <code>messaging-web-onbackgroundmessage.json</code> (top-level keys data/from/messageId/notification; from = sender id; messageId present). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface NotificationPayload { title?; body?; image?; icon? }</code><span class="compat-sub"><span class="compat-behavior">Display-notification block inside a <code>MessagePayload</code>. Production foreground deliveries carry a <code>notification</code> object whose keys include <code>title</code> and <code>body</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-onmessage-foreground.json</code> (notificationKeys body, title). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface FcmOptions { link?; analyticsLabel? }</code><span class="compat-sub"><span class="compat-behavior">WebpushFcmOptions-style options carried on a client <code>MessagePayload</code> (<code>link</code>, <code>analyticsLabel</code>).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>public-types</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">NextFn, Observer, Unsubscribe (re-exported from @firebase/util)</code><span class="compat-sub"><span class="compat-behavior">The callback, observer, and teardown types consumed by <code>onMessage</code> / <code>onBackgroundMessage</code> are re-exported from <code>@firebase/util</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 re-exports); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">const enum ErrorCode (client)</code><span class="compat-sub"><span class="compat-behavior">Client failures surface as thrown <code>FirebaseError</code>s carrying one of the 18 documented <code>ErrorCode</code> values (<code>missing-app-config-values</code>, <code>only-available-in-window</code>, <code>only-available-in-sw</code>, <code>permission-default</code>, <code>permission-blocked</code>, <code>unsupported-browser</code>, <code>indexed-db-unsupported</code>, <code>failed-service-worker-registration</code>, <code>token-subscribe-failed</code>, <code>token-subscribe-no-token</code>, <code>token-unsubscribe-failed</code>, <code>token-update-failed</code>, <code>token-update-no-token</code>, <code>invalid-bg-handler</code>, <code>use-sw-after-get-token</code>, <code>invalid-sw-registration</code>, <code>use-vapid-key-after-get-token</code>, <code>invalid-vapid-key</code>). The enum itself is <code>@internal</code>, not a public export.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>src/util/errors</code>); no client-error observation among the committed set.</div></div>
</details>
</div>

## `firebase/messaging/sw` (service worker)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getMessaging(app?): Messaging (sw)</code><span class="compat-sub"><span class="compat-behavior">Returns the FCM instance within a service-worker context (bound to <code>getMessagingInSw</code>); registers under the component name <code>messaging-sw</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>sw/index-public</code>) plus real module-ServiceWorker served-entry replay <code>messaging-app-boundary.pw.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">onBackgroundMessage(messaging, nextOrObserver): Unsubscribe</code><span class="compat-sub"><span class="compat-behavior">Called when a message arrives while the app has no visible window client. Production routes background deliveries here rather than to <code>onMessage</code>; the delivered payload carries <code>data</code> / <code>from</code> / <code>messageId</code> and, for notification messages, a <code>notification</code> block. A DATA-ONLY message still fires <code>onBackgroundMessage</code> with no <code>notification</code> key, and a registered handler suppresses the SDK auto-display.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-onbackgroundmessage.json</code> (no visible client → onBackgroundMessage) + <code>messaging-web-visibility-routing.json</code> + <code>messaging-web-data-only-background.json</code> (data-only fires, no notification key). Replayed by the conformance suite and by a real module Service Worker connected to the canonical SharedWorker broker in <code>messaging-app-boundary.pw.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging, enable): void</code><span class="compat-sub"><span class="compat-behavior">Enables or disables delivery-metrics export to BigQuery at runtime; default off.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>sw/index-public</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">isSupported(): Promise&lt;boolean&gt; (sw)</code><span class="compat-sub"><span class="compat-behavior">Resolves whether every API required by FCM exists within the service-worker context (bound to <code>isSwSupported</code>).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>sw/index-public</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">firebase/messaging/sw module boundary + shared type parity</code><span class="compat-sub"><span class="compat-behavior">The sw entry exports <code>onBackgroundMessage</code>, <code>getMessaging</code>, <code>experimentalSetDeliveryMetricsExportedToBigQueryEnabled</code>, and <code>isSupported</code>, but NOT <code>getToken</code> / <code>deleteToken</code> / <code>onMessage</code>; the client entry exports the latter but NOT <code>onBackgroundMessage</code> / the metrics toggle. The two modules register under different component names (<code>messaging</code> vs <code>messaging-sw</code>) and re-export identical <code>Messaging</code> / <code>GetTokenOptions</code> / <code>MessagePayload</code> / <code>NotificationPayload</code> / <code>FcmOptions</code> type declarations.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>index.d.ts</code> / <code>index.sw.d.ts</code>) plus Window and real module-ServiceWorker boundary replay <code>messaging-app-boundary.pw.ts</code>.</div></div>
</details>
</div>

## `firebase-admin/messaging` — entry + `Messaging` class

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getMessaging(app?): Messaging</code><span class="compat-sub"><span class="compat-behavior">Returns the <code>Messaging</code> service for the default or given admin <code>App</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>lib/messaging/index</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">messaging(app?): messaging.Messaging</code><span class="compat-sub"><span class="compat-behavior">Namespaced / legacy accessor equivalent of <code>getMessaging</code>, exposed by the compat entry alongside the <code>namespace messaging</code> type aliases.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-namespace</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">Messaging.get app(): App</code><span class="compat-sub"><span class="compat-behavior">The admin <code>App</code> this <code>Messaging</code> instance is bound to.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">Messaging.send(message, dryRun?): Promise&lt;string&gt;</code><span class="compat-sub"><span class="compat-behavior">Sends one message via FCM v1 and resolves with the resource name <code>projects/&lt;projectId&gt;/messages/&lt;numeric id&gt;</code>. <code>dryRun=true</code> returns the SAME shape (fake id), so callers cannot distinguish validation from acceptance by shape. Topic, condition, token, notification-only, data-only, and webpush-config sends are all accepted. Malformed sends fail server-side validation with HTTP 4xx <code>google.rpc</code> error envelopes carrying both a <code>google.rpc.BadRequest</code> (fieldViolations) and a <code>google.firebase.fcm.v1.FcmError</code> (errorCode); detail ordering is not contractual. The documented data-payload cap is 4096 bytes.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: 10 send-plane observations — accept paths <code>messaging-send-topic-accepted</code>, <code>messaging-send-condition-accepted</code>, <code>messaging-send-notification-only-vs-data-only-accepted</code>, <code>messaging-send-webpush-config-accepted</code>; error envelopes <code>messaging-send-no-target-error-envelope</code>, <code>messaging-send-invalid-token-error-envelope</code>, <code>messaging-send-invalid-condition-error-envelope</code>, <code>messaging-send-invalid-topic-name-error-envelope</code>, <code>messaging-send-oversized-payload-error-envelope</code>, <code>messaging-send-webpush-invalid-ttl-error-envelope</code>. Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">Messaging.sendEach(messages, dryRun?): Promise&lt;BatchResponse&gt;</code><span class="compat-sub"><span class="compat-behavior">Sends an array of up to 500 messages, one RPC per message; resolves a <code>BatchResponse</code> whose <code>responses</code> are ordered to match the input. Total failure is signalled by a throw or an all-failure <code>BatchResponse</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">Messaging.sendEachForMulticast(message, dryRun?): Promise&lt;BatchResponse&gt;</code><span class="compat-sub"><span class="compat-behavior">Fans a <code>MulticastMessage</code> (up to 500 tokens) out through <code>sendEach</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">Messaging.subscribeToTopic(tokenOrTokens, topic): Promise&lt;MessagingTopicManagementResponse&gt;</code><span class="compat-sub"><span class="compat-behavior">Subscribes one or many registration tokens to a topic; resolves a <code>MessagingTopicManagementResponse</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">Messaging.unsubscribeFromTopic(tokenOrTokens, topic): Promise&lt;MessagingTopicManagementResponse&gt;</code><span class="compat-sub"><span class="compat-behavior">Unsubscribes one or many registration tokens from a topic; resolves a <code>MessagingTopicManagementResponse</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">Messaging.enableLegacyHttpTransport(): void</code><span class="compat-sub"><span class="compat-behavior">Forces HTTP/1.1 transport for <code>sendEach</code> / <code>sendEachForMulticast</code>; deprecated.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>, <code>@deprecated</code>); no observation yet.</div></div>
</details>
</div>

## `Message` union + targets

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">type Message = TokenMessage | TopicMessage | ConditionMessage</code><span class="compat-sub"><span class="compat-behavior">A send payload carrying exactly one of token, topic, or condition.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface BaseMessage { data?; notification?; android?; webpush?; apns?; fcmOptions? }</code><span class="compat-sub"><span class="compat-behavior">Common message fields shared by every target variant. Production accepts a message carrying ONLY a <code>notification</code> block and, separately, ONLY a <code>data</code> block — neither is individually required.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-notification-only-vs-data-only-accepted.json</code> (both accepted). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface TokenMessage extends BaseMessage { token: string }</code><span class="compat-sub"><span class="compat-behavior">A device-token target. A syntactically invalid token is rejected with HTTP 400 INVALID_ARGUMENT whose fieldViolations name <code>message.token</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-invalid-token-error-envelope.json</code> (fieldViolations names message.token). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface TopicMessage extends BaseMessage { topic: string }</code><span class="compat-sub"><span class="compat-behavior">A topic target. A well-formed topic send is accepted and returns the standard resource name (no subscribers required); a topic name containing characters outside the documented <code>[a-zA-Z0-9-_.~%]</code> set is rejected with an INVALID_ARGUMENT error envelope.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-topic-accepted.json</code> (accepted) + <code>messaging-send-invalid-topic-name-error-envelope.json</code> (bad name rejected). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface ConditionMessage extends BaseMessage { condition: string }</code><span class="compat-sub"><span class="compat-behavior">A condition target. A well-formed condition of the form <code>"'a' in topics &amp;&amp; 'b' in topics"</code> is accepted with the standard resource-name shape (no subscribers required); a malformed condition (dangling operator) is rejected with an error envelope.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-condition-accepted.json</code> (accepted) + <code>messaging-send-invalid-condition-error-envelope.json</code> (malformed rejected). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface MulticastMessage extends BaseMessage { tokens: string[] }</code><span class="compat-sub"><span class="compat-behavior">A multicast target of up to 500 tokens, fanned out by <code>sendEachForMulticast</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
</div>

## Payload / config option shapes

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface Notification { title?; body?; imageUrl? }</code><span class="compat-sub"><span class="compat-behavior">Top-level, platform-independent notification block. Production accepts a notification-only message (no data block).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-notification-only-vs-data-only-accepted.json</code>. Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface FcmOptions { analyticsLabel? }</code><span class="compat-sub"><span class="compat-behavior">Platform-independent FCM options (<code>analyticsLabel</code>).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface WebpushConfig { headers?; data?; notification?; fcmOptions? }</code><span class="compat-sub"><span class="compat-behavior">Webpush overrides. Production accepts a webpush config carrying <code>headers.TTL</code> and <code>fcmOptions.link</code>; a non-numeric <code>headers.TTL</code> is rejected with an error envelope.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-webpush-config-accepted.json</code> (accepted) + <code>messaging-send-webpush-invalid-ttl-error-envelope.json</code> (bad TTL rejected). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface WebpushFcmOptions { link? }</code><span class="compat-sub"><span class="compat-behavior">Webpush FCM options (<code>link</code>, HTTPS required). Production accepts <code>fcmOptions.link</code> on a webpush send.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-webpush-config-accepted.json</code> (link accepted). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface WebpushNotification { title?; actions?; badge?; body?; dir?; icon?; image?; renotify?; requireInteraction?; silent?; tag?; vibrate?; [key] }</code><span class="compat-sub"><span class="compat-behavior">Web Notification API-shaped options, including an open-ended index signature.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface ApnsConfig { liveActivityToken?; headers?; payload?; fcmOptions? }</code><span class="compat-sub"><span class="compat-behavior">APNs overrides.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface ApnsPayload { aps; [customData] }</code><span class="compat-sub"><span class="compat-behavior">APNs payload wrapper carrying the required <code>aps</code> dictionary plus arbitrary custom keys.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface Aps { alert?; badge?; sound?; contentAvailable?; mutableContent?; category?; threadId?; [customData] }</code><span class="compat-sub"><span class="compat-behavior">APNs <code>aps</code> dictionary; <code>alert</code> is a string or an <code>ApsAlert</code>, <code>sound</code> a string or a <code>CriticalSound</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface ApsAlert { title?; subtitle?; body?; locKey?; locArgs?; ...; launchImage? }</code><span class="compat-sub"><span class="compat-behavior">APNs alert object with title/subtitle/body and localization keys.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface CriticalSound { critical?; name; volume? }</code><span class="compat-sub"><span class="compat-behavior">APNs critical sound — <code>name</code> required; <code>volume</code> in the range 0.0–1.0.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface ApnsFcmOptions { analyticsLabel?; imageUrl? }</code><span class="compat-sub"><span class="compat-behavior">APNs FCM options (<code>analyticsLabel</code>, <code>imageUrl</code>).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface AndroidConfig { collapseKey?; priority?; ttl?; restrictedPackageName?; data?; notification?; fcmOptions?; ... }</code><span class="compat-sub"><span class="compat-behavior">Android overrides; <code>ttl</code> is in milliseconds and <code>priority</code> is <code>high</code> | <code>normal</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface AndroidNotification { title?; body?; icon?; color?; sound?; tag?; imageUrl?; channelId?; priority?; visibility?; lightSettings?; ... }</code><span class="compat-sub"><span class="compat-behavior">Android notification options, including localization keys, LED light settings, and delivery-proxy controls.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface LightSettings { color; lightOnDurationMillis; lightOffDurationMillis }</code><span class="compat-sub"><span class="compat-behavior">Android LED light settings — all three fields required.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface AndroidFcmOptions { analyticsLabel? }</code><span class="compat-sub"><span class="compat-behavior">Android FCM options (<code>analyticsLabel</code>).</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
</div>

## Legacy payload shapes

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface DataMessagePayload { [key]: string }</code><span class="compat-sub"><span class="compat-behavior">Legacy data payload — up to 4KB; the keys <code>from</code> and <code>google.*</code> are reserved.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface NotificationMessagePayload { tag?; body?; icon?; badge?; color?; sound?; title?; ...; [key] }</code><span class="compat-sub"><span class="compat-behavior">Legacy notification payload with localization keys, a <code>clickAction</code>, and arbitrary string keys.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface MessagingPayload { data?; notification? }</code><span class="compat-sub"><span class="compat-behavior">Legacy combined payload — one or both of <code>data</code> / <code>notification</code> required.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface MessagingOptions { dryRun?; priority?; timeToLive?; collapseKey?; mutableContent?; contentAvailable?; restrictedPackageName?; [key] }</code><span class="compat-sub"><span class="compat-behavior">Legacy send options; documented defaults are dryRun false, ttl 2419200s (4 weeks), priority high for notifications / normal for data.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
</div>

## Response shapes

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface MessagingTopicManagementResponse { failureCount; successCount; errors }</code><span class="compat-sub"><span class="compat-behavior">Topic subscribe / unsubscribe result carrying per-index errors as <code>FirebaseArrayIndexError[]</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface BatchResponse { responses; successCount; failureCount }</code><span class="compat-sub"><span class="compat-behavior">Batch send result; <code>responses</code> is a <code>SendResponse[]</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">interface SendResponse { success; messageId?; error? }</code><span class="compat-sub"><span class="compat-behavior">Per-message batch entry — on success <code>messageId</code> is set, on failure <code>error</code> is set.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
</div>

## Errors

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">class FirebaseMessagingError extends PrefixedFirebaseError</code><span class="compat-sub"><span class="compat-behavior">The exported admin messaging error type.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>lib/messaging/index</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">class MessagingClientErrorCode</code><span class="compat-sub"><span class="compat-behavior">Exported static <code>{ code, message }</code> members (<code>INVALID_ARGUMENT</code>, <code>INVALID_RECIPIENT</code>, <code>INVALID_PAYLOAD</code>, … <code>UNKNOWN_ERROR</code>). The wire-level <code>INVALID_ARGUMENT</code> FcmError returned by malformed sends maps to <code>MessagingClientErrorCode.INVALID_ARGUMENT</code>.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-no-target-error-envelope.json</code> + <code>messaging-send-invalid-token-error-envelope.json</code> (both carry the INVALID_ARGUMENT FcmError). Replayed by the conformance suite.</div></div>
</details>
</div>
