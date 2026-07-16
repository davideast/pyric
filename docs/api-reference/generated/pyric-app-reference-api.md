---
title: "API reference: pyric/app"
navLabel: "pyric/app"
outcome: "Published declarations for pyric/app."
slug: "pyric-app-reference-api"
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/app"
apiSubpath: "app"
apiSymbolCount: 16
apiEvidenceSlug: "pyric-app-compat"
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="firebaseerror"></a>

### FirebaseError

Firebase-shaped error primitive shared by the sandbox client mirrors.

It lives below every service surface so mirrors can preserve cross-service
`instanceof FirebaseError` identity without depending on the app composition
root or loading the production SDK.

#### Extends

- `Error`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new FirebaseError(
   code: string,
   message: string,
   customData?: Record<string, unknown>): FirebaseError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `code` | `string` |
| `message` | `string` |
| `customData?` | `Record`\<`string`, `unknown`\> |

###### Returns

[`FirebaseError`](#firebaseerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Default value | Overrides |
| :------ | :------ | :------ | :------ | :------ |
| <a id="code"></a> `code` | `readonly` | `string` | `undefined` | - |
| <a id="customdata"></a> `customData?` | `readonly` | `Record`\<`string`, `unknown`\> | `undefined` | - |
| <a id="name"></a> `name` | `readonly` | `"FirebaseError"` | `"FirebaseError"` | `Error.name` |

## Interfaces

<a id="firebaseapp"></a>

### FirebaseApp

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="automaticdatacollectionenabled"></a> `automaticDataCollectionEnabled` | `public` | `boolean` |
| <a id="name-1"></a> `name` | `readonly` | `string` |
| <a id="options"></a> `options` | `readonly` | [`FirebaseOptions`](#firebaseoptions) |

***

<a id="firebaseappsettings"></a>

### FirebaseAppSettings

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="automaticdatacollectionenabled-1"></a> `automaticDataCollectionEnabled?` | `boolean` |
| <a id="name-2"></a> `name?` | `string` |

***

<a id="firebaseoptions"></a>

### FirebaseOptions

Firebase-compatible public value types for `pyric/app`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="apikey"></a> `apiKey?` | `string` |
| <a id="appid"></a> `appId?` | `string` |
| <a id="authdomain"></a> `authDomain?` | `string` |
| <a id="databaseurl"></a> `databaseURL?` | `string` |
| <a id="measurementid"></a> `measurementId?` | `string` |
| <a id="messagingsenderid"></a> `messagingSenderId?` | `string` |
| <a id="projectid"></a> `projectId?` | `string` |
| <a id="storagebucket"></a> `storageBucket?` | `string` |

***

<a id="logentry"></a>

### LogEntry

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="args"></a> `args` | `unknown`[] |
| <a id="level"></a> `level` | [`LogLevel`](#loglevel) |
| <a id="message"></a> `message` | `string` |
| <a id="type"></a> `type` | `string` |

***

<a id="logoptions"></a>

### LogOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="level-1"></a> `level` | [`LogLevel`](#loglevel) |

## Type Aliases

<a id="logcallback"></a>

### LogCallback()

```ts
type LogCallback = (entry: LogEntry) => void;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `entry` | [`LogEntry`](#logentry) |

#### Returns

`void`

***

<a id="loglevel"></a>

### LogLevel

```ts
type LogLevel = "debug" | "verbose" | "info" | "warn" | "error" | "silent";
```

## Variables

<a id="sdk_version"></a>

### SDK\_VERSION

```ts
const SDK_VERSION: "12.13.0" = "12.13.0";
```

Firebase JS SDK version whose public app behavior the current oracle records.
The app conformance replay makes this pin fail visibly when observations move.

## Functions

<a id="deleteapp"></a>

### deleteApp()

```ts
function deleteApp(app: FirebaseApp): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | [`FirebaseApp`](#firebaseapp) |

#### Returns

`Promise`\<`void`\>

***

<a id="getapp"></a>

### getApp()

```ts
function getApp(name?: string): FirebaseApp;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `name?` | `string` |

#### Returns

[`FirebaseApp`](#firebaseapp)

***

<a id="getapps"></a>

### getApps()

```ts
function getApps(): FirebaseApp[];
```

#### Returns

[`FirebaseApp`](#firebaseapp)[]

***

<a id="initializeapp"></a>

### initializeApp()

```ts
function initializeApp(options?: FirebaseOptions, rawSettings?: string | FirebaseAppSettings): FirebaseApp;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`FirebaseOptions`](#firebaseoptions) |
| `rawSettings?` | `string` \| [`FirebaseAppSettings`](#firebaseappsettings) |

#### Returns

[`FirebaseApp`](#firebaseapp)

***

<a id="onlog"></a>

### onLog()

```ts
function onLog(callback: LogCallback, options?: LogOptions): void;
```

Register or clear the process-wide app diagnostic handler.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `callback` | [`LogCallback`](#logcallback) |
| `options?` | [`LogOptions`](#logoptions) |

#### Returns

`void`

***

<a id="registerversion"></a>

### registerVersion()

```ts
function registerVersion(
   libraryKeyOrName: string,
   version: string,
   variant?: string): void;
```

Validate a platform-logger version registration.

A sandbox has no production component container, so valid registrations
need no retained component. Invalid registrations still emit the exact
diagnostic warning consumers can observe from Firebase.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `libraryKeyOrName` | `string` |
| `version` | `string` |
| `variant?` | `string` |

#### Returns

`void`

***

<a id="setloglevel"></a>

### setLogLevel()

```ts
function setLogLevel(level: LogLevel): void;
```

Set the threshold used by the app diagnostics logger.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `level` | [`LogLevel`](#loglevel) |

#### Returns

`void`
