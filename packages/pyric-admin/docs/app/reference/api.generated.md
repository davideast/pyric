<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric-admin/app

## Interfaces

### SandboxAdminApp

#### Properties

##### \[ADMIN\_APP\_TARGET\]

> `readonly` **\[ADMIN\_APP\_TARGET\]**: `"sandbox"`

##### name

> `readonly` **name**: `string`

##### sandbox

> `readonly` **sandbox**: `Sandbox`

## Type Aliases

### InitializeAdminAppConfig

> **InitializeAdminAppConfig** = `object`

#### Properties

##### sandbox

> **sandbox**: `Sandbox`

***

### PyricAdminApp

> **PyricAdminApp** = [`SandboxAdminApp`](#sandboxadminapp)

***

### PyricAdminAppTarget

> **PyricAdminAppTarget** = `"sandbox"`

## Variables

### ADMIN\_APP\_TARGET

> `const` **ADMIN\_APP\_TARGET**: unique `symbol`

Brand carried by every sandbox admin app.

***

### DEFAULT\_APP\_NAME

> `const` **DEFAULT\_APP\_NAME**: `"[DEFAULT]"` = `"[DEFAULT]"`

firebase-admin's default app name.

## Functions

### applicationDefault()

> **applicationDefault**(): `never`

Firebase Functions' ESM runtime statically imports this credential factory
while linking its database provider. Pyric initializes the sandbox app
before that provider executes, so the factory is not used by supported
Functions flows. Keep the named export link-compatible, but fail clearly if
application code asks the development sandbox for production credentials.

#### Returns

`never`

***

### deleteApp()

> **deleteApp**(`app`): `Promise`\<`void`\>

Remove a sandbox app from the registry.

#### Parameters

##### app

[`SandboxAdminApp`](#sandboxadminapp)

#### Returns

`Promise`\<`void`\>

***

### getApp()

> **getApp**(`name?`): [`SandboxAdminApp`](#sandboxadminapp)

Return the registered app for `name`.

#### Parameters

##### name?

`string`

#### Returns

[`SandboxAdminApp`](#sandboxadminapp)

***

### getApps()

> **getApps**(): [`SandboxAdminApp`](#sandboxadminapp)[]

Return a copy of the app registry.

#### Returns

[`SandboxAdminApp`](#sandboxadminapp)[]

***

### initializeApp()

> **initializeApp**(`config?`, `name?`): [`SandboxAdminApp`](#sandboxadminapp)

Initialize a sandbox admin app.

An explicit `{ sandbox }` config binds an in-process or remote sandbox.
A bare call resolves the remote sandbox factory installed by
`@pyric/cli/register`. Production callers must import `firebase-admin/app`
without Pyric activation instead of passing production options here.

#### Parameters

##### config?

[`InitializeAdminAppConfig`](#initializeadminappconfig)

##### name?

`string`

#### Returns

[`SandboxAdminApp`](#sandboxadminapp)

***

### isSandboxAdminApp()

> **isSandboxAdminApp**(`app`): `app is SandboxAdminApp`

#### Parameters

##### app

[`SandboxAdminApp`](#sandboxadminapp)

#### Returns

`app is SandboxAdminApp`
