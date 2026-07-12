---
title: "pyric messaging compatibility matrix"
navLabel: "Messaging"
group: "Compatibility"
section: ""
order: 8008
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric` messaging compatibility matrix

**56 of 56 tracked behaviors match production Firebase (100%).**

## Status legend

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span>Matches Firebase</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span>Documented difference</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span>Not supported yet</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span>Not verified yet</span>
</div>

## `firebase/messaging` (client)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">1</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns the FCM <code>Messaging</code> instance associated with the given (or default) <code>FirebaseApp</code>. Bound to the client component registered under the name <code>messaging</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase 12.13.0, <code>@firebase/messaging</code> 0.12.26); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">2</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Subscribes the instance to push and resolves with an FCM registration token; requests notification permission if not already granted and rejects if denied. Production tokens are colon-separated, URL-safe, ~142 chars, with the suffix after the colon beginning <code>APA91b</code>, and are stable across repeated <code>getToken</code> calls on the same service-worker registration (no per-call rotation).</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-token-shape.json</code> (minted, length 142, colon-separated, suffix starts <code>APA91b</code>, URL-safe) + <code>messaging-web-token-stability.json</code> (second <code>getToken</code> on the same registration returns the same token). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">3</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Deletes the registration token and unsubscribes the instance from its push subscription; resolves truthy. After deletion no message reaches the client on either route, and a server send to the now-dead token eventually surfaces the UNREGISTERED / 404-class error on the send plane (propagation is asynchronous — the first send after delete may still be accepted while delivery has already stopped).</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-deletetoken-unregistered.json</code> (deleteToken resolved truthy; no delivery to client; send plane eventually UNREGISTERED). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">4</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Dispatched with the push payload when a message arrives while a window client is visible; the returned function stops listening. Routing keys on page VISIBILITY, not focus: a <code>visibilityState: "visible"</code> page receives <code>onMessage</code> even when unfocused, and when no window client is visible the message routes to the service-worker <code>onBackgroundMessage</code> instead.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-onmessage-foreground.json</code> (focused page → onMessage) + <code>messaging-web-visibility-routing.json</code> (visible → onMessage, no visible client → onBackgroundMessage). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">5</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Resolves whether every API required by FCM exists in the current browser window context (bound to <code>isWindowSupported</code>).</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (<code>@firebase/messaging</code> 0.12.26); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">6</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Public interface of the FCM client SDK; exposes the bound <code>FirebaseApp</code> as <code>app</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>public-types</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">7</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Options for <code>getToken</code>: an optional <code>vapidKey</code> (Web Push certificate public key) and an optional <code>serviceWorkerRegistration</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>public-types</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">8</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Received message envelope delivered to <code>onMessage</code> / <code>onBackgroundMessage</code>. Production deliveries carry top-level keys <code>data</code>, <code>from</code>, <code>messageId</code>, and <code>notification</code>; <code>from</code> equals the project messaging sender id and <code>messageId</code> is present. (<code>from</code>, <code>collapseKey</code>, <code>messageId</code> are typed as required.)</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-onmessage-foreground.json</code> + <code>messaging-web-onbackgroundmessage.json</code> (top-level keys data/from/messageId/notification; from = sender id; messageId present). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">9</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Display-notification block inside a <code>MessagePayload</code>. Production foreground deliveries carry a <code>notification</code> object whose keys include <code>title</code> and <code>body</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-onmessage-foreground.json</code> (notificationKeys body, title). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">10</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">WebpushFcmOptions-style options carried on a client <code>MessagePayload</code> (<code>link</code>, <code>analyticsLabel</code>).</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>public-types</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">11</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The callback, observer, and teardown types consumed by <code>onMessage</code> / <code>onBackgroundMessage</code> are re-exported from <code>@firebase/util</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 re-exports); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">12</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Client failures surface as thrown <code>FirebaseError</code>s carrying one of the 18 documented <code>ErrorCode</code> values (<code>missing-app-config-values</code>, <code>only-available-in-window</code>, <code>only-available-in-sw</code>, <code>permission-default</code>, <code>permission-blocked</code>, <code>unsupported-browser</code>, <code>indexed-db-unsupported</code>, <code>failed-service-worker-registration</code>, <code>token-subscribe-failed</code>, <code>token-subscribe-no-token</code>, <code>token-unsubscribe-failed</code>, <code>token-update-failed</code>, <code>token-update-no-token</code>, <code>invalid-bg-handler</code>, <code>use-sw-after-get-token</code>, <code>invalid-sw-registration</code>, <code>use-vapid-key-after-get-token</code>, <code>invalid-vapid-key</code>). The enum itself is <code>@internal</code>, not a public export.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>src/util/errors</code>); no client-error observation among the committed set.</div></div>
</details>
</div>

## `firebase/messaging/sw` (service worker)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">13</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns the FCM instance within a service-worker context (bound to <code>getMessagingInSw</code>); registers under the component name <code>messaging-sw</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>sw/index-public</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">14</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Called when a message arrives while the app has no visible window client. Production routes background deliveries here rather than to <code>onMessage</code>; the delivered payload carries <code>data</code> / <code>from</code> / <code>messageId</code> and, for notification messages, a <code>notification</code> block. A DATA-ONLY message still fires <code>onBackgroundMessage</code> with no <code>notification</code> key, and a registered handler suppresses the SDK auto-display.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-web-onbackgroundmessage.json</code> (no visible client → onBackgroundMessage) + <code>messaging-web-visibility-routing.json</code> + <code>messaging-web-data-only-background.json</code> (data-only fires, no notification key). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">15</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Enables or disables delivery-metrics export to BigQuery at runtime; default off.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>sw/index-public</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">16</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Resolves whether every API required by FCM exists within the service-worker context (bound to <code>isSwSupported</code>).</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>sw/index-public</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">17</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The sw entry exports <code>onBackgroundMessage</code>, <code>getMessaging</code>, <code>experimentalSetDeliveryMetricsExportedToBigQueryEnabled</code>, and <code>isSupported</code>, but NOT <code>getToken</code> / <code>deleteToken</code> / <code>onMessage</code>; the client entry exports the latter but NOT <code>onBackgroundMessage</code> / the metrics toggle. The two modules register under different component names (<code>messaging</code> vs <code>messaging-sw</code>) and re-export identical <code>Messaging</code> / <code>GetTokenOptions</code> / <code>MessagePayload</code> / <code>NotificationPayload</code> / <code>FcmOptions</code> type declarations.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (<code>@firebase/messaging</code> 0.12.26 <code>index.d.ts</code> / <code>index.sw.d.ts</code>); no observation yet.</div></div>
</details>
</div>

## `firebase-admin/messaging` — entry + `Messaging` class

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">1</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns the <code>Messaging</code> service for the default or given admin <code>App</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>lib/messaging/index</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">2</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Namespaced / legacy accessor equivalent of <code>getMessaging</code>, exposed by the compat entry alongside the <code>namespace messaging</code> type aliases.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-namespace</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">3</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The admin <code>App</code> this <code>Messaging</code> instance is bound to.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">4</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sends one message via FCM v1 and resolves with the resource name <code>projects/&lt;projectId&gt;/messages/&lt;numeric id&gt;</code>. <code>dryRun=true</code> returns the SAME shape (fake id), so callers cannot distinguish validation from acceptance by shape. Topic, condition, token, notification-only, data-only, and webpush-config sends are all accepted. Malformed sends fail server-side validation with HTTP 4xx <code>google.rpc</code> error envelopes carrying both a <code>google.rpc.BadRequest</code> (fieldViolations) and a <code>google.firebase.fcm.v1.FcmError</code> (errorCode); detail ordering is not contractual. The documented data-payload cap is 4096 bytes.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: 10 send-plane observations — accept paths <code>messaging-send-topic-accepted</code>, <code>messaging-send-condition-accepted</code>, <code>messaging-send-notification-only-vs-data-only-accepted</code>, <code>messaging-send-webpush-config-accepted</code>; error envelopes <code>messaging-send-no-target-error-envelope</code>, <code>messaging-send-invalid-token-error-envelope</code>, <code>messaging-send-invalid-condition-error-envelope</code>, <code>messaging-send-invalid-topic-name-error-envelope</code>, <code>messaging-send-oversized-payload-error-envelope</code>, <code>messaging-send-webpush-invalid-ttl-error-envelope</code>. Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">5</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sends an array of up to 500 messages, one RPC per message; resolves a <code>BatchResponse</code> whose <code>responses</code> are ordered to match the input. Total failure is signalled by a throw or an all-failure <code>BatchResponse</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">6</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Fans a <code>MulticastMessage</code> (up to 500 tokens) out through <code>sendEach</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">7</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Subscribes one or many registration tokens to a topic; resolves a <code>MessagingTopicManagementResponse</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">8</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Unsubscribes one or many registration tokens from a topic; resolves a <code>MessagingTopicManagementResponse</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">9</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Forces HTTP/1.1 transport for <code>sendEach</code> / <code>sendEachForMulticast</code>; deprecated.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings/JSDoc (firebase-admin 13.10.0 <code>messaging</code>, <code>@deprecated</code>); no observation yet.</div></div>
</details>
</div>

## `Message` union + targets

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">10</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A send payload carrying exactly one of token, topic, or condition.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">11</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Common message fields shared by every target variant. Production accepts a message carrying ONLY a <code>notification</code> block and, separately, ONLY a <code>data</code> block — neither is individually required.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-notification-only-vs-data-only-accepted.json</code> (both accepted). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">12</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A device-token target. A syntactically invalid token is rejected with HTTP 400 INVALID_ARGUMENT whose fieldViolations name <code>message.token</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-invalid-token-error-envelope.json</code> (fieldViolations names message.token). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">13</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A topic target. A well-formed topic send is accepted and returns the standard resource name (no subscribers required); a topic name containing characters outside the documented <code>[a-zA-Z0-9-_.~%]</code> set is rejected with an INVALID_ARGUMENT error envelope.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-topic-accepted.json</code> (accepted) + <code>messaging-send-invalid-topic-name-error-envelope.json</code> (bad name rejected). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">14</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A condition target. A well-formed condition of the form <code>"'a' in topics &amp;&amp; 'b' in topics"</code> is accepted with the standard resource-name shape (no subscribers required); a malformed condition (dangling operator) is rejected with an error envelope.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-condition-accepted.json</code> (accepted) + <code>messaging-send-invalid-condition-error-envelope.json</code> (malformed rejected). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">15</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A multicast target of up to 500 tokens, fanned out by <code>sendEachForMulticast</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
</div>

## Payload / config option shapes

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">16</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Top-level, platform-independent notification block. Production accepts a notification-only message (no data block).</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-notification-only-vs-data-only-accepted.json</code>. Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">17</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Platform-independent FCM options (<code>analyticsLabel</code>).</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">18</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Webpush overrides. Production accepts a webpush config carrying <code>headers.TTL</code> and <code>fcmOptions.link</code>; a non-numeric <code>headers.TTL</code> is rejected with an error envelope.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-webpush-config-accepted.json</code> (accepted) + <code>messaging-send-webpush-invalid-ttl-error-envelope.json</code> (bad TTL rejected). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">19</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Webpush FCM options (<code>link</code>, HTTPS required). Production accepts <code>fcmOptions.link</code> on a webpush send.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-webpush-config-accepted.json</code> (link accepted). Replayed by the conformance suite.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">20</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Web Notification API-shaped options, including an open-ended index signature.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">21</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">APNs overrides.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">22</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">APNs payload wrapper carrying the required <code>aps</code> dictionary plus arbitrary custom keys.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">23</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">APNs <code>aps</code> dictionary; <code>alert</code> is a string or an <code>ApsAlert</code>, <code>sound</code> a string or a <code>CriticalSound</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">24</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">APNs alert object with title/subtitle/body and localization keys.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">25</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">APNs critical sound — <code>name</code> required; <code>volume</code> in the range 0.0–1.0.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">26</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">APNs FCM options (<code>analyticsLabel</code>, <code>imageUrl</code>).</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">27</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Android overrides; <code>ttl</code> is in milliseconds and <code>priority</code> is <code>high</code> | <code>normal</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">28</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Android notification options, including localization keys, LED light settings, and delivery-proxy controls.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">29</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Android LED light settings — all three fields required.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">30</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Android FCM options (<code>analyticsLabel</code>).</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
</div>

## Legacy payload shapes

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">31</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Legacy data payload — up to 4KB; the keys <code>from</code> and <code>google.*</code> are reserved.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">32</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Legacy notification payload with localization keys, a <code>clickAction</code>, and arbitrary string keys.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">33</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Legacy combined payload — one or both of <code>data</code> / <code>notification</code> required.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">34</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Legacy send options; documented defaults are dryRun false, ttl 2419200s (4 weeks), priority high for notifications / normal for data.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
</div>

## Response shapes

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">35</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Topic subscribe / unsubscribe result carrying per-index errors as <code>FirebaseArrayIndexError[]</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">36</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Batch send result; <code>responses</code> is a <code>SendResponse[]</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">37</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Per-message batch entry — on success <code>messageId</code> is set, on failure <code>error</code> is set.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>messaging-api</code>); no observation yet.</div></div>
</details>
</div>

## Errors

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">38</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The exported admin messaging error type.</span></summary>
<div class="compat-evidence"><div class="compat-probe">Upstream typings (firebase-admin 13.10.0 <code>lib/messaging/index</code>); no observation yet.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">39</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Exported static <code>{ code, message }</code> members (<code>INVALID_ARGUMENT</code>, <code>INVALID_RECIPIENT</code>, <code>INVALID_PAYLOAD</code>, … <code>UNKNOWN_ERROR</code>). The wire-level <code>INVALID_ARGUMENT</code> FcmError returned by malformed sends maps to <code>MessagingClientErrorCode.INVALID_ARGUMENT</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>messaging-send-no-target-error-envelope.json</code> + <code>messaging-send-invalid-token-error-envelope.json</code> (both carry the INVALID_ARGUMENT FcmError). Replayed by the conformance suite.</div></div>
</details>
</div>
