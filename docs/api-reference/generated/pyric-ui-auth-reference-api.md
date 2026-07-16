---
title: "API reference: @pyric/ui/auth"
navLabel: "@pyric/ui/auth"
outcome: "Published declarations for @pyric/ui/auth."
slug: "pyric-ui-auth-reference-api"
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/auth"
apiSubpath: "auth"
apiSymbolCount: 51
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

<a id="authprovidertogglesprops"></a>

### AuthProviderTogglesProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname"></a> `className?` | `string` | - |
| <a id="config"></a> `config` | [`AuthProviderConfigEntry`](#authproviderconfigentry)[] | Current config — usually `useAuthProviderConfig(auth).config`. |
| <a id="error"></a> `error?` | `Error` | - |
| <a id="isloading"></a> `isLoading?` | `boolean` | - |
| <a id="knownproviderids"></a> `knownProviderIds?` | readonly `string`[] | Always-shown rows, in this order. Default: [DEFAULT\_KNOWN\_PROVIDER\_IDS](#default_known_provider_ids). |
| <a id="ontoggle"></a> `onToggle` | (`providerId`: `string`, `enabled`: `boolean`) => `void` | Fired when a toggle (known or custom) flips. |

***

<a id="authsigninhelperprops"></a>

### AuthSignInHelperProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-1"></a> `className?` | `string` | - |
| <a id="description"></a> `description?` | `ReactNode` | Optional helper text rendered under the title (`[data-pyric-helper-description]`). Default: none. |
| <a id="initialvalues"></a> `initialValues?` | \{ `claims?`: `string`; `displayName?`: `string`; `email?`: `string`; \} | Prefill for the add-account form (e.g. a host-suggested email). Read once on mount; `claims` is the raw textarea JSON text. |
| `initialValues.claims?` | `string` | - |
| `initialValues.displayName?` | `string` | - |
| `initialValues.email?` | `string` | - |
| <a id="onadd"></a> `onAdd` | (`spec`: [`NewIdentitySpec`](#newidentityspec)) => `void` | Create + sign in as a new identity (wire to the hook's `add`). |
| <a id="oncancel"></a> `onCancel` | () => `void` | Dismiss the flow (wire to the hook's `cancel`). Rejects the app's sign-in promise with `auth/popup-closed-by-user`. |
| <a id="onpick"></a> `onPick` | (`uid`: `string`) => `void` | Settle with an existing identity (wire to the hook's `pick`). |
| <a id="renderaccount"></a> `renderAccount?` | (`identity`: `any`) => `ReactNode` | Optional renderer for an account row's content. Default renders the display name (or email, or uid) plus the email when both exist. The row button + data attributes stay owned by the component; this slot only fills the button's children. |
| <a id="state"></a> `state` | [`HelperState`](#helperstate) | Snapshot from `useAuthFlowHelper`. Renders nothing while `state.request` is null. |
| <a id="title"></a> `title?` | `ReactNode` | Heading text. Default: `Sign in with <provider label>`. |

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

<a id="authuserformfield"></a>

### AuthUserFormField

What the [AuthUserFormProps.renderField](#renderfield) slot receives per field.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="defaultrender"></a> `defaultRender` | () => `ReactNode` | The default rendering (label wrapper + label text + input + error). Call it to keep the stock layout for fields you don't customize. |
| <a id="error-1"></a> `error` | `string` | Current validation message for this field, or null. |
| <a id="input"></a> `input` | `ReactNode` | The wired, controlled input element (carries `data-pyric-field`). Place it anywhere; state/validation stay connected. |
| <a id="kind"></a> `kind` | `"text"` \| `"checkbox"` \| `"group"` | `'text' | 'checkbox' | 'group'` — lets one slot impl branch on layout (`group` = a multi-control block, e.g. the provider checklist; create mode only). |
| <a id="label"></a> `label` | `string` | The visible label text the default rendering uses. |
| <a id="name"></a> `name` | [`AuthUserFormFieldName`](#authuserformfieldname-1) | - |

***

<a id="authuserformprops"></a>

### AuthUserFormProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="cancellabel"></a> `cancelLabel?` | `string` | - |
| <a id="children"></a> `children?` | `ReactNode` | Extra content rendered before the action row (e.g. an error from a failed `createUser` call). |
| <a id="classname-2"></a> `className?` | `string` | - |
| <a id="initial-1"></a> `initial?` | `AuthUserRecord` | Existing record → edit mode (delta payloads); omit → create mode. |
| <a id="oncancel-1"></a> `onCancel?` | () => `void` | - |
| <a id="onsubmit"></a> `onSubmit` | (`submit`: [`AuthUserFormSubmit`](#authuserformsubmit)) => `void` | Receives the validated payload. Wire `create` to `useAuthUsers().createUser` and `edit` to `updateUser`. |
| <a id="renderfield"></a> `renderField?` | (`field`: [`AuthUserFormField`](#authuserformfield)) => `ReactNode` | Per-field layout override. Called for each field (see [AuthUserFormFieldName](#authuserformfieldname-1) order); return your own markup around `field.input`, or `field.defaultRender()` to keep the stock label wrapper for that field. Omit the prop for the default layout. |
| <a id="submitlabel"></a> `submitLabel?` | `string` | - |

***

<a id="authuserlistprops"></a>

### AuthUserListProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-3"></a> `className?` | `string` | - |
| <a id="emptystate"></a> `emptyState?` | `ReactNode` | Zero state when the project has no users at all. |
| <a id="error-2"></a> `error?` | `Error` | - |
| <a id="filter"></a> `filter?` | `string` | The active filter text. Distinguishes the "no users yet" zero state (empty filter) from "no results" (non-empty). |
| <a id="formatcreatedat"></a> `formatCreatedAt?` | (`iso`: `string`) => `ReactNode` | Timestamp formatter for Created. Default: locale date, em dash for null. |
| <a id="formatlastloginat"></a> `formatLastLoginAt?` | (`iso`: `string`) => `ReactNode` | Timestamp formatter for Signed In. Kept separate because a missing login means "never", while a missing/invalid creation time is malformed data. |
| <a id="isloading-1"></a> `isLoading?` | `boolean` | - |
| <a id="noresultsstate"></a> `noResultsState?` | `ReactNode` | Zero state when the filter matches nothing. |
| <a id="onselect"></a> `onSelect?` | (`user`: `AuthUserRecord`) => `void` | Fired when the identifier cell is clicked. When omitted, the identifier renders as plain text. |
| <a id="renderactions"></a> `renderActions?` | (`user`: `AuthUserRecord`) => `ReactNode` | Per-row action slot (edit / disable / delete menu). Rendered in a trailing cell; column header is added when this is provided. |
| <a id="renderactionsheader"></a> `renderActionsHeader?` | `ReactNode` | Optional content for the trailing actions column header (for example, a select-all checkbox). Only rendered with `renderActions`. |
| <a id="renderidentifier"></a> `renderIdentifier?` | (`user`: `AuthUserRecord`) => `ReactNode` | Identifier-cell override. Default: email, else phone, else `anonymous`, else the uid. |
| <a id="renderproviders"></a> `renderProviders?` | (`user`: `AuthUserRecord`) => `ReactNode` | Providers-cell override. Default: one `<span data-pyric-provider-id>` per linked provider with its text label (`anonymous` for anonymous users) — hook icons off the attribute. |
| <a id="renderselection"></a> `renderSelection?` | (`user`: `AuthUserRecord`) => `ReactNode` | Per-row selection control. Rendered in the leading cell so bulk selection stays visually separate from trailing row actions. |
| <a id="renderselectionheader"></a> `renderSelectionHeader?` | `ReactNode` | Optional content for the leading selection column header (for example, a select-all checkbox). Only rendered with `renderSelection`. |
| <a id="rowheight"></a> `rowHeight?` | `number` \| (`index`: `number`) => `number` | Estimated row height when virtualizing. Default 44. |
| <a id="users"></a> `users` | `AuthUserRecord`[] | Rows to render — usually `useAuthUsers().users`. |
| <a id="virtualizedheight"></a> `virtualizedHeight?` | `string` \| `number` | Scroll-container height when virtualized. Default `'60vh'`. |
| <a id="virtualizethreshold"></a> `virtualizeThreshold?` | `number` | Above this row count, rows render through `<VirtualList>`. Default 100. `Infinity` disables. |

***

<a id="claimsfieldprops"></a>

### ClaimsFieldProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-4"></a> `className?` | `string` | - |
| <a id="error-3"></a> `error?` | `string` | Validation message (from `validateSerializedClaims` / `useAuthUserEditor().errors.claims`). Renders a `role="alert"` paragraph and marks the textarea invalid. |
| <a id="hint"></a> `hint?` | `ReactNode` | Helper text under the field (rules-usage hint by default). |
| <a id="onchange"></a> `onChange` | (`text`: `string`) => `void` | - |
| <a id="placeholder"></a> `placeholder?` | `string` | - |
| <a id="value"></a> `value` | `string` | Raw claims JSON text. |

***

<a id="clearuserswithconfirmprops"></a>

### ClearUsersWithConfirmProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="body"></a> `body?` | `ReactNode` | - |
| <a id="classname-5"></a> `className?` | `string` | - |
| <a id="confirmlabel"></a> `confirmLabel?` | `string` | - |
| <a id="count"></a> `count?` | `number` | Current user count, interpolated into the default body. |
| <a id="onclear"></a> `onClear` | () => `void` | Runs after the user confirms. Wire to `useAuthUsers().clearUsers`. |
| <a id="rendertrigger"></a> `renderTrigger?` | (`props`: `TriggerProps`) => `ReactNode` | - |
| <a id="title-1"></a> `title?` | `string` | - |

***

<a id="deleteuserwithconfirmprops"></a>

### DeleteUserWithConfirmProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="body-1"></a> `body?` | `ReactNode` | - |
| <a id="classname-6"></a> `className?` | `string` | - |
| <a id="confirmlabel-1"></a> `confirmLabel?` | `string` | - |
| <a id="ondelete"></a> `onDelete` | (`uid`: `string`) => `void` | Runs after the user confirms. Wire to `useAuthUsers().deleteUser`. |
| <a id="rendertrigger-1"></a> `renderTrigger?` | (`props`: `TriggerProps`) => `ReactNode` | Trigger override; default is a plain destructive `<button>`. |
| <a id="title-2"></a> `title?` | `string` | - |
| <a id="user"></a> `user` | `AuthUserRecord` | - |

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
| <a id="state-1"></a> `state` | [`HelperState`](#helperstate) | Render snapshot: the in-flight request (or null) + pickable identities. |

***

<a id="useauthproviderconfigresult"></a>

### UseAuthProviderConfigResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="config-1"></a> `config` | [`AuthProviderConfigEntry`](#authproviderconfigentry)[] | Every provider this sandbox has an explicit enablement for. Unknown providers (never toggled) are simply absent — `isEnabled` treats an absent entry as disabled, matching the backend default. |
| <a id="error-4"></a> `error` | `Error` | - |
| <a id="isenabled"></a> `isEnabled` | (`providerId`: `string`) => `boolean` | Convenience lookup: `false` for a provider that's never been toggled. |
| <a id="isloading-2"></a> `isLoading` | `boolean` | - |
| <a id="refresh"></a> `refresh` | () => `void` | Re-read manually. Rarely needed — every mutation (this hook's own `setEnabled`, another handle, the agent) already triggers the subscription re-list. |
| <a id="setenabled"></a> `setEnabled` | (`providerId`: `string`, `enabled`: `boolean`) => `void` | Toggle a provider on/off. Sync (in-process) failures throw to the caller, same policy as `useAuthUsers`'s mutation callbacks; an ASYNC (worker-RPC) failure can't reach a sync caller, so it surfaces on the hook's `error` state instead — never an unhandled rejection. |

***

<a id="useauthusereditoroptions"></a>

### UseAuthUserEditorOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="initial-2"></a> `initial?` | `AuthUserRecord` | Existing record to edit. Omit for create mode. |

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
| <a id="error-5"></a> `error` | `Error` | - |
| <a id="filter-1"></a> `filter` | `string` | Case-insensitive substring match over uid, email, display name and phone number (the emulator UI's search semantics). |
| <a id="isloading-3"></a> `isLoading` | `boolean` | - |
| <a id="refresh-1"></a> `refresh` | () => `void` | Re-list manually. Rarely needed, every mutation (including ones made by the agent or the running app) already triggers `subscribeUsers`. |
| <a id="setfilter"></a> `setFilter` | (`filter`: `string`) => `void` | - |
| <a id="totalcount"></a> `totalCount` | `number` | Unfiltered count: lets a list distinguish "no users at all" from "no results for this filter". |
| <a id="updateuser"></a> `updateUser` | (`uid`: `string`, `update`: `UpdateUserRequest`) => `AuthUserRecord` | - |
| <a id="users-1"></a> `users` | `AuthUserRecord`[] | Users matching [filter](#filter-1) (everyone when the filter is empty). |

## Type Aliases

<a id="authapi"></a>

### AuthApi

```ts
type AuthApi = Pick<typeof authSandbox,
  | "listUsers"
  | "subscribeUsers"
  | "createUser"
  | "updateUser"
  | "deleteUser"
  | "clearUsers"
  | "getAuthProviderConfig"
  | "setAuthProviderConfig"
| "subscribeAuthProviderConfig">;
```

The sandbox auth admin ops `useAuthUsers` drives, as an INJECTABLE bundle.

WHY (same rationale as `@pyric/ui/firestore`'s FirestoreApi): the hook defaults
to the in-process `pyric/auth` `sandbox` ops, but Pyric Studio's served mode
drives the SAME ops over a SharedWorker (a parallel client over a MessagePort).
Reading them from this context lets a consumer inject the worker client's fns
so the hook operates on the live worker user DB without knowing the backend.

The bundle is typed to the in-process signatures; a worker bundle is adapted
(cast) at the Studio boundary. NOTE the worker `listUsers` is ASYNC (an RPC)
whereas the in-process one is sync, so `useAuthUsers` tolerates a promise (it
wraps the result in `Promise.resolve`).

Default = the real `pyric/auth` sandbox ops, so every existing consumer is
unchanged: no provider needed unless swapping the backend.

***

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

<a id="authuserformfieldname-1"></a>

### AuthUserFormFieldName

```ts
type AuthUserFormFieldName =
  | "email"
  | "password"
  | "display-name"
  | "phone-number"
  | "photo-url"
  | "providers"
  | "email-verified"
  | "disabled";
```

Field names the [AuthUserFormProps.renderField](#renderfield) slot receives,
 in render order. Claims is NOT a slot field — it stays the standalone
 `<ClaimsField>` (override it by composing `useAuthUserEditor`).

***

<a id="authuserformsubmit"></a>

### AuthUserFormSubmit

```ts
type AuthUserFormSubmit =
  | {
  mode: "create";
  request: CreateUserRequest;
}
  | {
  mode: "edit";
  request: UpdateUserRequest;
  uid: string;
};
```

What `onSubmit` receives — discriminated on the form's mode.

***

<a id="claimsvalidationresult"></a>

### ClaimsValidationResult

```ts
type ClaimsValidationResult =
  | {
  claims: Record<string, unknown> | undefined;
  ok: true;
}
  | {
  message: string;
  ok: false;
};
```

#### Type Declaration

```ts
{
  claims: Record<string, unknown> | undefined;
  ok: true;
}
```

##### claims

```ts
claims: Record<string, unknown> | undefined;
```

##### ok

```ts
ok: true;
```

`claims` is `undefined` when the input was empty/whitespace.

```ts
{
  message: string;
  ok: false;
}
```

##### message

```ts
message: string;
```

##### ok

```ts
ok: false;
```

***

<a id="sandboxidentity"></a>

### SandboxIdentity

```ts
type SandboxIdentity = ReturnType<typeof authSandbox.listIdentities>[number];
```

One pickable identity, as reported by `sandbox.listIdentities`.

## Variables

<a id="custom_claims_max_length"></a>

### CUSTOM\_CLAIMS\_MAX\_LENGTH

```ts
const CUSTOM_CLAIMS_MAX_LENGTH: 1000 = 1000;
```

Serialized-length cap, matching the emulator's `CUSTOM_ATTRIBUTES_MAX_LENGTH`.

***

<a id="default_known_provider_ids"></a>

### DEFAULT\_KNOWN\_PROVIDER\_IDS

```ts
const DEFAULT_KNOWN_PROVIDER_IDS: readonly ["password", "anonymous", "google.com", "github.com", "apple.com", "microsoft.com"];
```

Providers always shown as a toggle row, regardless of whether the
 backend has an explicit entry for them yet (an unconfigured provider
 simply reads as disabled — same default the sandbox backend applies).

***

<a id="forbidden_custom_claims"></a>

### FORBIDDEN\_CUSTOM\_CLAIMS

```ts
const FORBIDDEN_CUSTOM_CLAIMS: readonly string[];
```

Reserved JWT/OIDC keys the Auth emulator rejects as custom claims.
 https://firebase.google.com/docs/auth/admin/create-custom-tokens

***

<a id="provider_labels"></a>

### PROVIDER\_LABELS

```ts
const PROVIDER_LABELS: Record<string, string>;
```

Provider-id → human label mapping, mirroring the provider set the
Firebase emulator UI recognizes (it maps the same ids to icons; a
headless library maps them to text and leaves icons to the consumer
via `data-pyric-provider-id`).

## Functions

<a id="authapiprovider"></a>

### AuthApiProvider()

```ts
function AuthApiProvider(__namedParameters: {
  children: ReactNode;
  value: AuthApi;
}): FunctionComponentElement<ProviderProps<AuthApi>>;
```

Provide an auth API bundle to the subtree. Pyric Studio supplies the
in-process bundle for dev-seed review and the SharedWorker client bundle under
`pyric dev --ui`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | \{ `children`: `ReactNode`; `value`: [`AuthApi`](#authapi); \} |
| `__namedParameters.children` | `ReactNode` |
| `__namedParameters.value` | [`AuthApi`](#authapi) |

#### Returns

`FunctionComponentElement`\<`ProviderProps`\<[`AuthApi`](#authapi)\>\>

***

<a id="authprovidertoggles"></a>

### AuthProviderToggles()

```ts
function AuthProviderToggles(__namedParameters: AuthProviderTogglesProps): Element;
```

Headless "Sign-in providers" toggle grid — the Authentication → Sign-in
method surface. Known providers (password / anonymous / the built-in OAuth
set) always render as a row; any OTHER provider already present in
`config` (a custom OAuth id a host previously added) also gets a row. A
free-text field lets a consumer enable an arbitrary OAuth provider id not
in the known set — this is a SECTION, not a dialog: the add row lives
inline, no modal.

Fully headless: styling hangs off `data-pyric-*`, matching the rest of
`@pyric/ui/auth` (`AuthUserList`, `AuthUserForm`, …). Data + mutation come
from `useAuthProviderConfig`; this component only renders + fires events.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`AuthProviderTogglesProps`](#authprovidertogglesprops) |

#### Returns

`Element`

***

<a id="authsigninhelper"></a>

### AuthSignInHelper()

```ts
function AuthSignInHelper(__namedParameters: AuthSignInHelperProps): Element;
```

Headless emulator-style sign-in helper: an account picker over the
sandbox's known identities plus an add-account form (email, display
name, custom-claims JSON with emulator-grade validation messages).

Ships zero styling. Structure is addressable via the
`data-pyric-*` contract:

- root: `[data-pyric-ui="auth-signin-helper"]`,
  `[data-pyric-provider-id]`, `[data-pyric-auth-type]`
- picker: `[data-pyric-account-list]` > `[data-pyric-account-entry]`
  > `button[data-pyric-account-pick]`
- form: `form[data-pyric-add-account-form]`, fields
  `[data-pyric-field="email" | "display-name" | "claims"]`,
  `[data-pyric-claims-error]` (role=alert),
  `button[data-pyric-cancel]`, `button[data-pyric-submit]`

Positioning is the consumer's job — render it inside your own modal
or panel (the flow is host-UI-agnostic; only `onCancel` carries the
popup-closed semantics).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`AuthSignInHelperProps`](#authsigninhelperprops) |

#### Returns

`Element`

***

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

<a id="authuserform"></a>

### AuthUserForm()

```ts
function AuthUserForm(__namedParameters: AuthUserFormProps): Element;
```

Headless add/edit-user form over `useAuthUserEditor` — the emulator
UI's user dialog fields (email, password, display name, phone, photo
URL, verified/disabled toggles, custom claims) with its validation
messages. Zero CSS; structure addressable via `data-pyric-*`:

- root `form[data-pyric-ui="auth-user-form"]` with `data-pyric-mode`,
  `data-pyric-is-dirty`, `data-pyric-is-valid` state attrs
- every field (text inputs AND checkboxes) is wrapped in a
  `label[data-pyric-field-label="<name>"]` carrying a visible
  `span[data-pyric-label-text]` — labeled grid layouts are pure CSS
  (`display: grid` on the wrappers); label-less designs hide
  `[data-pyric-label-text]` and lean on the placeholders
- inputs `[data-pyric-field="email" | "password" | "display-name" |
  "phone-number" | "photo-url" | "email-verified" | "disabled"]`
- CREATE mode only: a "Sign-in providers" group
  (`fieldset[data-pyric-field-label="providers"]` wrapping
  `[data-pyric-provider-checklist]`) — one checkbox per federated
  provider the sandbox supports (`FEDERATED_PROVIDER_IDS` from
  `pyric/auth`; multiple selectable, entries land on
  `CreateUserRequest.providerUserInfo`)
- claims via the standalone `<ClaimsField>`
- per-field messages `[data-pyric-field-error="email" | "password"]`
  render INSIDE the field's label wrapper, after the input
- `button[data-pyric-cancel]` / `button[data-pyric-submit]` (submit is
  disabled while invalid, or pristine in edit mode)

Submit emits payloads only — no sandbox calls — so the same form works
for create and edit and the consumer owns error handling.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`AuthUserFormProps`](#authuserformprops) |

#### Returns

`Element`

***

<a id="authuserlist"></a>

### AuthUserList()

```ts
function AuthUserList(__namedParameters: AuthUserListProps): Element;
```

Headless users table — the emulator UI's columns (Identifier,
Provider, Created, Signed In, User UID, actions) over the
`data-pyric-*` styling contract, with role-based table semantics so
rows can virtualize (a real `<table>` can't wrap a scroll container).

The hook (`useAuthUsers`) owns data + filter state; this component
just renders. Disabled accounts carry `data-pyric-user-disabled` for
dimmed styling.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`AuthUserListProps`](#authuserlistprops) |

#### Returns

`Element`

***

<a id="claimsfield"></a>

### ClaimsField()

```ts
function ClaimsField(__namedParameters: ClaimsFieldProps): Element;
```

Headless custom-claims textarea — the emulator UI's
`customAttributes` control. Standalone so custom forms can reuse the
exact field (the playground's sign-in helper and the user form both
render one); validation itself lives in `validateSerializedClaims`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ClaimsFieldProps`](#claimsfieldprops) |

#### Returns

`Element`

***

<a id="clearuserswithconfirm"></a>

### ClearUsersWithConfirm()

```ts
function ClearUsersWithConfirm(__namedParameters: ClearUsersWithConfirmProps): Element;
```

Confirm-gated clear-all (the emulator UI's "Clear all data").
Requires a `<ConfirmProvider>` ancestor.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ClearUsersWithConfirmProps`](#clearuserswithconfirmprops) |

#### Returns

`Element`

***

<a id="deleteuserwithconfirm"></a>

### DeleteUserWithConfirm()

```ts
function DeleteUserWithConfirm(__namedParameters: DeleteUserWithConfirmProps): Element;
```

Confirm-gated single-user delete (the emulator UI's row-menu
"Delete user"). Requires a `<ConfirmProvider>` ancestor.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`DeleteUserWithConfirmProps`](#deleteuserwithconfirmprops) |

#### Returns

`Element`

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

<a id="providerlabel"></a>

### providerLabel()

```ts
function providerLabel(providerId: string): string;
```

Label for a provider id; falls back to the raw id for custom
 `OAuthProvider` ids the map doesn't know.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `providerId` | `string` |

#### Returns

`string`

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

<a id="useauthapi"></a>

### useAuthApi()

```ts
function useAuthApi(): AuthApi;
```

Read the active auth API bundle (defaults to in-process `pyric/auth`).

#### Returns

[`AuthApi`](#authapi)

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

***

<a id="validateserializedclaims"></a>

### validateSerializedClaims()

```ts
function validateSerializedClaims(text: string): ClaimsValidationResult;
```

Validate the claims textarea's raw text. Empty input is valid (no
claims). Messages match the emulator UI verbatim so users see the
same wording in both tools.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `text` | `string` |

#### Returns

[`ClaimsValidationResult`](#claimsvalidationresult)
