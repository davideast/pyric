---
title: "API reference: pyric-admin/app"
navLabel: "pyric-admin/app"
outcome: "Published declarations for pyric-admin/app."
slug: "pyric-admin-app-reference-api"
kind: "api"
apiPackage: "pyric-admin"
apiImportPath: "pyric-admin/app"
apiSubpath: "app"
apiSymbolCount: 12
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="sandboxadminapp"></a>

### SandboxAdminApp

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="admin_app_target"></a> `[ADMIN_APP_TARGET]` | `readonly` | `"sandbox"` |
| <a id="name"></a> `name` | `readonly` | `string` |
| <a id="sandbox"></a> `sandbox` | `readonly` | `Sandbox` |

## Type Aliases

<a id="initializeadminappconfig"></a>

### InitializeAdminAppConfig

```ts
type InitializeAdminAppConfig = {
  sandbox: Sandbox;
};
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="sandbox-1"></a> `sandbox` | `Sandbox` |

***

<a id="pyricadminapp"></a>

### PyricAdminApp

```ts
type PyricAdminApp = SandboxAdminApp;
```

***

<a id="pyricadminapptarget"></a>

### PyricAdminAppTarget

```ts
type PyricAdminAppTarget = "sandbox";
```

## Variables

<a id="admin_app_target-1"></a>

### ADMIN\_APP\_TARGET

```ts
const ADMIN_APP_TARGET: unique symbol;
```

Brand carried by every sandbox admin app.

***

<a id="default_app_name"></a>

### DEFAULT\_APP\_NAME

```ts
const DEFAULT_APP_NAME: "[DEFAULT]" = "[DEFAULT]";
```

firebase-admin's default app name.

## Functions

<a id="applicationdefault"></a>

### applicationDefault()

```ts
function applicationDefault(): never;
```

Firebase Functions' ESM runtime statically imports this credential factory
while linking its database provider. Pyric initializes the sandbox app
before that provider executes, so the factory is not used by supported
Functions flows. Keep the named export link-compatible, but fail clearly if
application code asks the development sandbox for production credentials.

#### Returns

`never`

***

<a id="deleteapp"></a>

### deleteApp()

```ts
function deleteApp(app: SandboxAdminApp): Promise<void>;
```

Remove a sandbox app from the registry.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | [`SandboxAdminApp`](#sandboxadminapp) |

#### Returns

`Promise`\<`void`\>

***

<a id="getapp"></a>

### getApp()

```ts
function getApp(name?: string): SandboxAdminApp;
```

Return the registered app for `name`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `name?` | `string` |

#### Returns

[`SandboxAdminApp`](#sandboxadminapp)

***

<a id="getapps"></a>

### getApps()

```ts
function getApps(): SandboxAdminApp[];
```

Return a copy of the app registry.

#### Returns

[`SandboxAdminApp`](#sandboxadminapp)[]

***

<a id="initializeapp"></a>

### initializeApp()

```ts
function initializeApp(config?: InitializeAdminAppConfig, name?: string): SandboxAdminApp;
```

Initialize a sandbox admin app.

An explicit `{ sandbox }` config binds an in-process or remote sandbox.
A bare call resolves the remote sandbox factory installed by
`@pyric/cli/register`. Production callers must import `firebase-admin/app`
without Pyric activation instead of passing production options here.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `config?` | [`InitializeAdminAppConfig`](#initializeadminappconfig) |
| `name?` | `string` |

#### Returns

[`SandboxAdminApp`](#sandboxadminapp)

***

<a id="issandboxadminapp"></a>

### isSandboxAdminApp()

```ts
function isSandboxAdminApp(app: SandboxAdminApp): app is SandboxAdminApp;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | [`SandboxAdminApp`](#sandboxadminapp) |

#### Returns

`app is SandboxAdminApp`
