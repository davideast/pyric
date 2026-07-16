---
title: "API reference: pyric/messaging"
navLabel: "pyric/messaging"
group: "API reference"
section: "pyric"
order: 24026
description: "Published declarations for pyric/messaging."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/messaging"
apiSubpath: "messaging"
apiSymbolCount: 17
apiEvidenceSlug: "pyric-messaging-compat"
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="deliverspec"></a>

### DeliverSpec

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="data"></a> `data?` | `Record`\<`string`, `string`\> | - |
| <a id="from"></a> `from?` | `string` | - |
| <a id="messageid"></a> `messageId?` | `string` | - |
| <a id="notification"></a> `notification?` | \{ `body?`: `string`; `image?`: `string`; `title?`: `string`; \} | - |
| `notification.body?` | `string` | - |
| `notification.image?` | `string` | - |
| `notification.title?` | `string` | - |
| <a id="visibilitystate"></a> `visibilityState?` | `"visible"` \| `"hidden"` | Simulated visibility of the (single) window client at delivery time. |

***

<a id="deliveryresult"></a>

### DeliveryResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="handlercount"></a> `handlerCount` | `number` | Handlers actually invoked on the chosen route. |
| <a id="payload"></a> `payload` | `DeliveredPayload` | - |
| <a id="route"></a> `route` | `DeliveryRoute` | - |

***

<a id="fcmoptions"></a>

### FcmOptions

Options carried on a client [MessagePayload](#messagepayload).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="analyticslabel"></a> `analyticsLabel?` | `string` |
| <a id="link"></a> `link?` | `string` |

***

<a id="gettokenoptions"></a>

### GetTokenOptions

Options for [getToken](#gettoken).

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="serviceworkerregistration"></a> `serviceWorkerRegistration?` | `object` | A (simulated) service-worker registration; token stability keys on its identity. |
| <a id="vapidkey"></a> `vapidKey?` | `string` | - |

***

<a id="messagepayload"></a>

### MessagePayload

Received message envelope delivered to `onMessage` / `onBackgroundMessage`.
`from` / `collapseKey` / `messageId` are typed required (upstream parity);
captured production deliveries carry top-level keys
`data` / `from` / `messageId` (+ `notification`) — `collapseKey` was not
observed on the wire and the sandbox likewise omits it at runtime.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="collapsekey"></a> `collapseKey` | `string` |
| <a id="data-1"></a> `data?` | \{ \[`key`: `string`\]: `string`; \} |
| <a id="fcmoptions-1"></a> `fcmOptions?` | [`FcmOptions`](#fcmoptions) |
| <a id="from-1"></a> `from` | `string` |
| <a id="messageid-1"></a> `messageId` | `string` |
| <a id="notification-1"></a> `notification?` | [`NotificationPayload`](#notificationpayload) |

***

<a id="messaging"></a>

### Messaging

The FCM `Messaging` instance mirror — exposes the bound app as `app`
(upstream `@firebase/messaging` public-types parity).

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="app"></a> `app` | `readonly` | `FirebaseApp` |

***

<a id="notificationpayload"></a>

### NotificationPayload

Display-notification block inside a [MessagePayload](#messagepayload).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="body"></a> `body?` | `string` |
| <a id="icon"></a> `icon?` | `string` |
| <a id="image"></a> `image?` | `string` |
| <a id="title"></a> `title?` | `string` |

***

<a id="observer"></a>

### Observer

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="complete"></a> `complete` | () => `void` |
| <a id="error"></a> `error` | (`error`: `Error`) => `void` |
| <a id="next"></a> `next` | [`NextFn`](#nextfn)\<`T`\> |

***

<a id="simulatedserviceworkerregistration"></a>

### SimulatedServiceWorkerRegistration

Minimal structural stand-in for a `ServiceWorkerRegistration` in the
headless sandbox (bun has no DOM lib). Identity is what matters: token
stability is keyed per registration object.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="active"></a> `active` | `readonly` | \{ `state`: `"activated"`; \} |
| `active.state` | `readonly` | `"activated"` |
| <a id="scope"></a> `scope` | `readonly` | `string` |

## Type Aliases

<a id="nextfn"></a>

### NextFn()

```ts
type NextFn<T> = (value: T) => void;
```

Callback / observer / teardown shapes — structurally identical to the
`@firebase/util` types the upstream entry re-exports (declared locally
because `@firebase/util` is not a direct dependency of `pyric`; the
tier-2 assignability census closes exact type parity).

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `T` |

#### Returns

`void`

***

<a id="unsubscribe"></a>

### Unsubscribe()

```ts
type Unsubscribe = () => void;
```

#### Returns

`void`

## Variables

<a id="sandbox"></a>

### sandbox

```ts
const sandbox: {
  deliver: Promise<DeliveryResult>;
  registration: SimulatedServiceWorkerRegistration;
};
```

#### Type Declaration

<a id="deliver"></a>

##### deliver()

```ts
deliver(messaging: Messaging, spec: DeliverSpec): Promise<DeliveryResult>;
```

Inject a delivery into the client plane, optionally setting the
simulated window client's visibility first. Routes through the broker's
captured visibility rule, so a `visible` spec lands on `onMessage`
handlers and a `hidden` spec on `onBackgroundMessage` handlers.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `messaging` | [`Messaging`](#messaging) |
| `spec` | [`DeliverSpec`](#deliverspec) |

###### Returns

`Promise`\<[`DeliveryResult`](#deliveryresult)\>

<a id="registration"></a>

##### registration()

```ts
registration(): SimulatedServiceWorkerRegistration;
```

The module-default simulated service-worker registration.

###### Returns

[`SimulatedServiceWorkerRegistration`](#simulatedserviceworkerregistration)

## Functions

<a id="deletetoken"></a>

### deleteToken()

```ts
function deleteToken(messaging: Messaging): Promise<boolean>;
```

Delete the active registration token. Resolves truthy; afterwards no
message reaches the client on either route and a send to the dead token
surfaces the captured UNREGISTERED envelope on the send plane
(oracle: `messaging-web-deletetoken-unregistered`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `messaging` | [`Messaging`](#messaging) |

#### Returns

`Promise`\<`boolean`\>

***

<a id="getmessaging"></a>

### getMessaging()

```ts
function getMessaging(app?: FirebaseApp): Messaging;
```

Return the FCM `Messaging` instance for the given (or default) app —
window-client plane (upstream component name `messaging`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app?` | `FirebaseApp` |

#### Returns

[`Messaging`](#messaging)

***

<a id="gettoken"></a>

### getToken()

```ts
function getToken(messaging: Messaging, options?: GetTokenOptions): Promise<string>;
```

Subscribe the instance to push and resolve its registration token.
Sandbox semantics per the captured contract: the minted token matches the
production shape class (142 chars, colon-separated, URL-safe, `APA91b`
suffix class) and is STABLE across repeated calls on the same
(simulated) service-worker registration — no per-call rotation.
Notification permission is modeled as granted in the sandbox.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `messaging` | [`Messaging`](#messaging) |
| `options?` | [`GetTokenOptions`](#gettokenoptions) |

#### Returns

`Promise`\<`string`\>

***

<a id="issupported"></a>

### isSupported()

```ts
function isSupported(): Promise<boolean>;
```

Whether every API FCM requires exists here — always true in the sandbox.

#### Returns

`Promise`\<`boolean`\>

***

<a id="onmessage"></a>

### onMessage()

```ts
function onMessage(messaging: Messaging, nextOrObserver:
  | NextFn<MessagePayload>
  | Observer<MessagePayload>): Unsubscribe;
```

Listen for messages delivered while a window client is VISIBLE — routing
keys on visibility, never focus (oracle: `messaging-web-visibility-routing`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `messaging` | [`Messaging`](#messaging) |
| `nextOrObserver` | \| [`NextFn`](#nextfn)\<[`MessagePayload`](#messagepayload)\> \| [`Observer`](#observer)\<[`MessagePayload`](#messagepayload)\> |

#### Returns

[`Unsubscribe`](#unsubscribe)
