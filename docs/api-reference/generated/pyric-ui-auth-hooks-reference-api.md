---
title: "API reference: @pyric/ui/auth/hooks"
navLabel: "@pyric/ui/auth/hooks"
outcome: "Published declarations for @pyric/ui/auth/hooks."
slug: "pyric-ui-auth-hooks-reference-api"
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/auth/hooks"
apiSubpath: "auth/hooks"
apiSymbolCount: 24
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="authflowcontroller"></a>

### AuthFlowController

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new AuthFlowController(auth: Auth): AuthFlowController;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | `Auth` |

###### Returns

[`AuthFlowController`](#authflowcontroller)

#### Methods

<a id="add"></a>

##### add()

```ts
add(spec: NewIdentitySpec): void;
```

Add + sign in as a new identity. The backend creates the identity
 (so claims resolve in rules and it shows up in the picker next time)
 and mints the credential in one step.

 Credential creation happens BEFORE take's emit: subscribers
 recompute the snapshot synchronously on emit, so creating after would
 publish a stale identity list (a `useSyncExternalStore` consumer
 would miss the new account until the next unrelated emit).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `spec` | [`NewIdentitySpec`](#newidentityspec) |

###### Returns

`void`

<a id="cancel"></a>

##### cancel()

```ts
cancel(): void;
```

Dismiss — rejects with the faithful `auth/popup-closed-by-user`.

###### Returns

`void`

<a id="install"></a>

##### install()

```ts
install(): void;
```

Wire this controller's resolver into the auth handle. Paired with
 [uninstall](#uninstall) for use in a React effect (install in the body,
 uninstall in the cleanup) — StrictMode-safe.

###### Returns

`void`

<a id="pick"></a>

##### pick()

```ts
pick(uid: string): void;
```

Pick an existing identity (by uid). The backend mints the credential
 (and records the provider on the identity).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |

###### Returns

`void`

<a id="resolver"></a>

##### resolver()

```ts
resolver(): AuthFlowResolver;
```

The resolver to hand to `sandbox.setAuthFlowResolver`. Popup and
 redirect share one implementation (the sandbox has no navigation).

###### Returns

`AuthFlowResolver`

<a id="snapshot"></a>

##### snapshot()

```ts
snapshot(): HelperState;
```

###### Returns

[`HelperState`](#helperstate)

<a id="subscribe"></a>

##### subscribe()

```ts
subscribe(fn: () => void): () => void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `fn` | () => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

<a id="uninstall"></a>

##### uninstall()

```ts
uninstall(): void;
```

###### Returns

`void`

## Interfaces

<a id="authproviderconfigentry"></a>

### AuthProviderConfigEntry

One provider's current enablement, as the hook exposes it.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="enabled"></a> `enabled` | `boolean` |
| <a id="providerid"></a> `providerId` | `string` |

***

<a id="authusereditorerrors"></a>

### AuthUserEditorErrors

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="claims"></a> `claims?` | `string` |
| <a id="email"></a> `email?` | `string` |
| <a id="password"></a> `password?` | `string` |

***

<a id="authusereditorfields"></a>

### AuthUserEditorFields

Editable field set. `claimsText` is the raw textarea JSON.
 `providerIds` are the linked FEDERATED providers (`google.com`,
 `apple.com`, …) — `password` is credential-derived (the password
 field) and never appears here.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="claimstext"></a> `claimsText` | `string` |
| <a id="disabled"></a> `disabled` | `boolean` |
| <a id="displayname"></a> `displayName` | `string` |
| <a id="email-1"></a> `email` | `string` |
| <a id="emailverified"></a> `emailVerified` | `boolean` |
| <a id="password-1"></a> `password` | `string` |
| <a id="phonenumber"></a> `phoneNumber` | `string` |
| <a id="photourl"></a> `photoUrl` | `string` |
| <a id="providerids"></a> `providerIds` | `string`[] |

***

<a id="authusereditorstate"></a>

### AuthUserEditorState

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="fields"></a> `fields` | [`AuthUserEditorFields`](#authusereditorfields) | - |
| <a id="initial"></a> `initial` | [`AuthUserEditorFields`](#authusereditorfields) | What reset returns to; dirtiness is measured against this. |

***

<a id="helperstate"></a>

### HelperState

Snapshot the helper UI renders from.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="identities"></a> `identities` | `any`[] | Existing identities to pick from (seeded + previously created). |
| <a id="request"></a> `request` | `any` | The in-flight request, or null when the helper is closed. |

***

<a id="newidentityspec"></a>

### NewIdentitySpec

A field set for "add new account" — mirrors the emulator's add-user form.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="customclaims"></a> `customClaims?` | `Record`\<`string`, `unknown`\> | Parsed custom claims (the emulator's `customAttributes`). |
| <a id="displayname-1"></a> `displayName?` | `string` | - |
| <a id="email-2"></a> `email` | `string` | - |

***

<a id="useauthflowhelperresult"></a>

### UseAuthFlowHelperResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="add-2"></a> `add` | (`spec`: [`NewIdentitySpec`](#newidentityspec)) => `void` | Create + sign in as a new identity (seeds it for next time). |
| <a id="cancel-2"></a> `cancel` | () => `void` | Dismiss — rejects the app's sign-in promise with `auth/popup-closed-by-user` (faithful to `firebase/auth`). |
| <a id="pick-2"></a> `pick` | (`uid`: `string`) => `void` | Settle the flow with an existing identity (by uid). |
| <a id="state"></a> `state` | [`HelperState`](#helperstate) | Render snapshot: the in-flight request (or null) + pickable identities. |

***

<a id="useauthproviderconfigresult"></a>

### UseAuthProviderConfigResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="config"></a> `config` | [`AuthProviderConfigEntry`](#authproviderconfigentry)[] | Every provider this sandbox has an explicit enablement for. Unknown providers (never toggled) are simply absent — `isEnabled` treats an absent entry as enabled, matching the backend default. |
| <a id="error"></a> `error` | `Error` | - |
| <a id="isenabled"></a> `isEnabled` | (`providerId`: `string`) => `boolean` | Convenience lookup: `true` for a provider that's never been toggled. |
| <a id="isloading"></a> `isLoading` | `boolean` | - |
| <a id="refresh"></a> `refresh` | () => `void` | Re-read manually. Rarely needed — every mutation (this hook's own `setEnabled`, another handle, the agent) already triggers the subscription re-list. |
| <a id="setenabled"></a> `setEnabled` | (`providerId`: `string`, `enabled`: `boolean`) => `void` | Toggle a provider on/off. Sync (in-process) failures throw to the caller, same policy as `useAuthUsers`'s mutation callbacks; an ASYNC (worker-RPC) failure can't reach a sync caller, so it surfaces on the hook's `error` state instead — never an unhandled rejection. |

***

<a id="useauthusereditoroptions"></a>

### UseAuthUserEditorOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="initial-1"></a> `initial?` | `AuthUserRecord` | Existing record to edit. Omit for create mode. |

***

<a id="useauthusereditorresult"></a>

### UseAuthUserEditorResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="dispatch"></a> `dispatch` | (`action`: [`AuthUserEditorAction`](#authusereditoraction)) => `void` | Raw reducer access for advanced consumers. |
| <a id="errors"></a> `errors` | [`AuthUserEditorErrors`](#authusereditorerrors) | Per-field validation messages (emulator-UI wording). Empty when valid. |
| <a id="fields-1"></a> `fields` | [`AuthUserEditorFields`](#authusereditorfields) | - |
| <a id="isdirty"></a> `isDirty` | `boolean` | - |
| <a id="isvalid"></a> `isValid` | `boolean` | - |
| <a id="reset"></a> `reset` | () => `void` | Back to the initial snapshot. |
| <a id="setfield"></a> `setField` | \<`K`\>(`field`: `K`, `value`: [`AuthUserEditorFields`](#authusereditorfields)\[`K`\]) => `void` | - |
| <a id="tocreaterequest"></a> `toCreateRequest` | () => `CreateUserRequest` | Full payload for `createUser` (every non-empty field). |
| <a id="toupdaterequest"></a> `toUpdateRequest` | () => `UpdateUserRequest` | Delta payload for `updateUser` (only changed fields). |

***

<a id="useauthusersresult"></a>

### UseAuthUsersResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="clearusers"></a> `clearUsers` | () => `void` | - |
| <a id="createuser"></a> `createUser` | (`request`: `CreateUserRequest`) => `AuthUserRecord` | - |
| <a id="deleteuser"></a> `deleteUser` | (`uid`: `string`) => `void` | - |
| <a id="error-1"></a> `error` | `Error` | - |
| <a id="filter"></a> `filter` | `string` | Case-insensitive substring match over uid, email, display name and phone number (the emulator UI's search semantics). |
| <a id="isloading-1"></a> `isLoading` | `boolean` | - |
| <a id="refresh-1"></a> `refresh` | () => `void` | Re-list manually. Rarely needed, every mutation (including ones made by the agent or the running app) already triggers `subscribeUsers`. |
| <a id="setfilter"></a> `setFilter` | (`filter`: `string`) => `void` | - |
| <a id="totalcount"></a> `totalCount` | `number` | Unfiltered count: lets a list distinguish "no users at all" from "no results for this filter". |
| <a id="updateuser"></a> `updateUser` | (`uid`: `string`, `update`: `UpdateUserRequest`) => `AuthUserRecord` | - |
| <a id="users"></a> `users` | `AuthUserRecord`[] | Users matching [filter](#filter) (everyone when the filter is empty). |

## Type Aliases

<a id="authusereditoraction"></a>

### AuthUserEditorAction

```ts
type AuthUserEditorAction =
  | {
  field: keyof AuthUserEditorFields;
  type: "setField";
  value: AuthUserEditorFields[keyof AuthUserEditorFields];
}
  | {
  type: "reset";
};
```

***

<a id="sandboxidentity"></a>

### SandboxIdentity

```ts
type SandboxIdentity = ReturnType<typeof authSandbox.listIdentities>[number];
```

One pickable identity, as reported by `sandbox.listIdentities`.

## Functions

<a id="authusereditorreducer"></a>

### authUserEditorReducer()

```ts
function authUserEditorReducer(state: AuthUserEditorState, action: AuthUserEditorAction): AuthUserEditorState;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`AuthUserEditorState`](#authusereditorstate) |
| `action` | [`AuthUserEditorAction`](#authusereditoraction) |

#### Returns

[`AuthUserEditorState`](#authusereditorstate)

***

<a id="fieldsfromrecord"></a>

### fieldsFromRecord()

```ts
function fieldsFromRecord(record?: AuthUserRecord): AuthUserEditorFields;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `record?` | `AuthUserRecord` |

#### Returns

[`AuthUserEditorFields`](#authusereditorfields)

***

<a id="initauthusereditorstate"></a>

### initAuthUserEditorState()

```ts
function initAuthUserEditorState(initial?: AuthUserRecord): AuthUserEditorState;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `initial?` | `AuthUserRecord` |

#### Returns

[`AuthUserEditorState`](#authusereditorstate)

***

<a id="tocreaterequest-1"></a>

### toCreateRequest()

```ts
function toCreateRequest(state: AuthUserEditorState): CreateUserRequest;
```

Full payload for `sandbox.createUser` — every non-empty field.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`AuthUserEditorState`](#authusereditorstate) |

#### Returns

`CreateUserRequest`

***

<a id="toupdaterequest-1"></a>

### toUpdateRequest()

```ts
function toUpdateRequest(state: AuthUserEditorState): UpdateUserRequest;
```

Delta payload for `sandbox.updateUser` — only fields that changed
 from the initial record. A cleared displayName maps to `null`
 (the update API's clear semantics).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`AuthUserEditorState`](#authusereditorstate) |

#### Returns

`UpdateUserRequest`

***

<a id="useauthflowhelper"></a>

### useAuthFlowHelper()

```ts
function useAuthFlowHelper(auth: Auth): UseAuthFlowHelperResult;
```

Emulator-style sign-in helper for a sandbox `Auth` handle.

Installs an [AuthFlowController](#authflowcontroller) as the handle's
`AuthFlowResolver` for the lifetime of the calling component — the
analog of browser `getAuth` wiring `browserPopupRedirectResolver`.
While mounted, any `signInWithPopup` / `signInWithRedirect` call made
against `auth` parks on `state.request`; render an account-picker UI
(e.g. `<AuthSignInHelper>`) from `state` and settle with
`pick` / `add` / `cancel`.

Install/uninstall is a paired effect, so the StrictMode double-mount
installs and cleanly uninstalls. Sandbox-only: the controller throws
`failed-precondition` if `auth` is prod-backed.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | `Auth` |

#### Returns

[`UseAuthFlowHelperResult`](#useauthflowhelperresult)

***

<a id="useauthproviderconfig"></a>

### useAuthProviderConfig()

```ts
function useAuthProviderConfig(auth: Auth): UseAuthProviderConfigResult;
```

Live sign-in provider config view over a sandbox `Auth` handle:
`sandbox.getAuthProviderConfig` + `sandbox.subscribeAuthProviderConfig` +
`sandbox.setAuthProviderConfig`. Mirrors `useAuthUsers`'s shape exactly
(coarse "something changed, re-list" subscription; sync in-process,
tolerates a promise over the SharedWorker client).

Sandbox-only: throws `failed-precondition` on a prod-backed handle (the
hook surfaces that via `error`, same as `useAuthUsers`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | `Auth` |

#### Returns

[`UseAuthProviderConfigResult`](#useauthproviderconfigresult)

***

<a id="useauthusereditor"></a>

### useAuthUserEditor()

```ts
function useAuthUserEditor(options?: UseAuthUserEditorOptions): UseAuthUserEditorResult;
```

Headless add/edit-user state machine (reducer-based, like
`useDocumentEditor`): field edits, claims-JSON validation with
emulator-grade messages, dirtiness vs the initial record, and payload
builders for `useAuthUsers`' `createUser` / `updateUser`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`UseAuthUserEditorOptions`](#useauthusereditoroptions) |

#### Returns

[`UseAuthUserEditorResult`](#useauthusereditorresult)

***

<a id="useauthusers"></a>

### useAuthUsers()

```ts
function useAuthUsers(auth: Auth): UseAuthUsersResult;
```

Live user-admin view over a sandbox `Auth` handle:
`sandbox.listUsers` + `sandbox.subscribeUsers` + CRUD actions.

The subscription is coarse ("something changed"): any user-DB
mutation (from these actions, the running app's sign-ups, the
agent's seeding) triggers a re-list, so the view stays live without
per-row bookkeeping. Filtering is client-side (the sandbox is
in-process; there is no server to push the query to).

Mutation errors (e.g. `auth/uid-already-exists`) throw to the caller:
handle them at the call site like the firestore hooks' `createDocument`.
Sandbox-only: throws `failed-precondition` on a prod-backed handle (the
hook surfaces that via `error`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | `Auth` |

#### Returns

[`UseAuthUsersResult`](#useauthusersresult)

***

<a id="validateauthuserfields"></a>

### validateAuthUserFields()

```ts
function validateAuthUserFields(fields: AuthUserEditorFields): AuthUserEditorErrors;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `fields` | [`AuthUserEditorFields`](#authusereditorfields) |

#### Returns

[`AuthUserEditorErrors`](#authusereditorerrors)
