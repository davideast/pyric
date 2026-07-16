---
title: "API reference: pyric-admin/database"
navLabel: "pyric-admin/database"
group: "API reference"
section: "pyric-admin"
order: 24005
description: "Published declarations for pyric-admin/database."
kind: "api"
apiPackage: "pyric-admin"
apiImportPath: "pyric-admin/database"
apiSubpath: "database"
apiSymbolCount: 9
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="database"></a>

### Database

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="app"></a> `app` | `readonly` | `unknown` |

#### Methods

<a id="getrules"></a>

##### getRules()

```ts
getRules(): Promise<string>;
```

###### Returns

`Promise`\<`string`\>

<a id="getrulesjson"></a>

##### getRulesJSON()

```ts
getRulesJSON(): Promise<object>;
```

###### Returns

`Promise`\<`object`\>

<a id="gooffline"></a>

##### goOffline()

```ts
goOffline(): void;
```

###### Returns

`void`

<a id="goonline"></a>

##### goOnline()

```ts
goOnline(): void;
```

###### Returns

`void`

<a id="ref"></a>

##### ref()

```ts
ref(path?: string): Reference;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path?` | `string` |

###### Returns

[`Reference`](#reference)

<a id="reffromurl"></a>

##### refFromURL()

```ts
refFromURL(url: string): Reference;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `url` | `string` |

###### Returns

[`Reference`](#reference)

<a id="setrules"></a>

##### setRules()

```ts
setRules(source: string | object): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | `string` \| `object` |

###### Returns

`Promise`\<`void`\>

***

<a id="datasnapshot"></a>

### DataSnapshot

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="key"></a> `key` | `readonly` | `string` |
| <a id="ref-2"></a> `ref` | `readonly` | [`Reference`](#reference) |

#### Methods

<a id="child"></a>

##### child()

```ts
child(path: string): DataSnapshot;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`DataSnapshot`](#datasnapshot)

<a id="exists"></a>

##### exists()

```ts
exists(): boolean;
```

###### Returns

`boolean`

<a id="exportval"></a>

##### exportVal()

```ts
exportVal(): unknown;
```

###### Returns

`unknown`

<a id="foreach"></a>

##### forEach()

```ts
forEach(action: (child: DataSnapshot) => boolean | void): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `action` | (`child`: [`DataSnapshot`](#datasnapshot)) => `boolean` \| `void` |

###### Returns

`boolean`

<a id="getpriority"></a>

##### getPriority()

```ts
getPriority(): string | number;
```

###### Returns

`string` \| `number`

<a id="haschild"></a>

##### hasChild()

```ts
hasChild(path: string): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`boolean`

<a id="haschildren"></a>

##### hasChildren()

```ts
hasChildren(children?: string[]): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `children?` | `string`[] |

###### Returns

`boolean`

<a id="numchildren"></a>

##### numChildren()

```ts
numChildren(): number;
```

###### Returns

`number`

<a id="tojson"></a>

##### toJSON()

```ts
toJSON(): unknown;
```

###### Returns

`unknown`

<a id="val"></a>

##### val()

```ts
val(): unknown;
```

###### Returns

`unknown`

***

<a id="ondisconnect"></a>

### OnDisconnect

#### Indexable

```ts
[key: string]: unknown
```

***

<a id="reference"></a>

### Reference

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="database-1"></a> `database` | `readonly` | [`Database`](#database) |
| <a id="key-1"></a> `key` | `readonly` | `string` |
| <a id="parent"></a> `parent` | `readonly` | [`Reference`](#reference) |
| <a id="ref-3"></a> `ref` | `readonly` | [`Reference`](#reference) |
| <a id="root"></a> `root` | `readonly` | [`Reference`](#reference) |

#### Methods

<a id="child-2"></a>

##### child()

```ts
child(path: string): Reference;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`Reference`](#reference)

<a id="get"></a>

##### get()

```ts
get(): Promise<DataSnapshot>;
```

###### Returns

`Promise`\<[`DataSnapshot`](#datasnapshot)\>

<a id="off"></a>

##### off()

```ts
off(eventType?: EventType, callback?: (snapshot: DataSnapshot, previousChildKey?: string) => unknown): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `eventType?` | [`EventType`](#eventtype) |
| `callback?` | (`snapshot`: [`DataSnapshot`](#datasnapshot), `previousChildKey?`: `string`) => `unknown` |

###### Returns

`void`

<a id="on"></a>

##### on()

```ts
on(
   eventType: EventType,
   callback: (snapshot: DataSnapshot, previousChildKey?: string) => unknown,
   cancelCallback?: (error: Error) => unknown): unknown;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `eventType` | [`EventType`](#eventtype) |
| `callback` | (`snapshot`: [`DataSnapshot`](#datasnapshot), `previousChildKey?`: `string`) => `unknown` |
| `cancelCallback?` | (`error`: `Error`) => `unknown` |

###### Returns

`unknown`

<a id="once"></a>

##### once()

```ts
once(
   eventType: EventType,
   successCallback?: (snapshot: DataSnapshot) => unknown,
failureCallback?: (error: Error) => unknown): Promise<DataSnapshot>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `eventType` | [`EventType`](#eventtype) |
| `successCallback?` | (`snapshot`: [`DataSnapshot`](#datasnapshot)) => `unknown` |
| `failureCallback?` | (`error`: `Error`) => `unknown` |

###### Returns

`Promise`\<[`DataSnapshot`](#datasnapshot)\>

<a id="push"></a>

##### push()

```ts
push(value?: unknown, onComplete?: (error: Error) => void): ThenableReference;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `value?` | `unknown` |
| `onComplete?` | (`error`: `Error`) => `void` |

###### Returns

[`ThenableReference`](#thenablereference)

<a id="remove"></a>

##### remove()

```ts
remove(onComplete?: (error: Error) => void): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `onComplete?` | (`error`: `Error`) => `void` |

###### Returns

`Promise`\<`void`\>

<a id="set"></a>

##### set()

```ts
set(value: unknown, onComplete?: (error: Error) => void): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |
| `onComplete?` | (`error`: `Error`) => `void` |

###### Returns

`Promise`\<`void`\>

<a id="tostring"></a>

##### toString()

```ts
toString(): string;
```

###### Returns

`string`

<a id="update"></a>

##### update()

```ts
update(values: object, onComplete?: (error: Error) => void): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `values` | `object` |
| `onComplete?` | (`error`: `Error`) => `void` |

###### Returns

`Promise`\<`void`\>

## Type Aliases

<a id="eventtype"></a>

### EventType

```ts
type EventType =
  | "value"
  | "child_added"
  | "child_changed"
  | "child_removed"
  | "child_moved";
```

Mirror-owned structural types for the implemented admin RTDB surface.

***

<a id="query"></a>

### Query

```ts
type Query = Reference;
```

***

<a id="thenablereference"></a>

### ThenableReference

```ts
type ThenableReference = Reference & PromiseLike<Reference>;
```

## Functions

<a id="getdatabase"></a>

### getDatabase()

```ts
function getDatabase(app?: SandboxAdminApp, _url?: string): Database;
```

Returns the AdminDatabase service for the supplied app.

Signature mirrors `firebase-admin/database`'s `getDatabase(app?)`.

  - `getDatabase()` — default database for the DEFAULT app (resolved
    through `pyric-admin/app`'s registry, exactly like firebase-admin's
    no-arg `getDatabase()`; throws `app/no-app` when no default app has
    been initialized). Works for local and remote sandbox apps.
  - `getDatabase(app)` — default database for the app.
  - `getDatabase(app, url)` — legacy Pyric-only compatibility form. New
    code should use the upstream-shaped [getDatabaseWithUrl](#getdatabasewithurl) export.

The sandbox brand returns the local or remote `Database` backed by the
per-`Sandbox` state described in the module-level docs.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app?` | `SandboxAdminApp` |
| `_url?` | `string` |

#### Returns

[`Database`](#database)

***

<a id="getdatabasewithurl"></a>

### getDatabaseWithUrl()

```ts
function getDatabaseWithUrl(_url: string, app?: SandboxAdminApp): Database;
```

Returns the AdminDatabase service selected by an upstream-shaped
database URL.

This is the exact `firebase-admin/database` argument order used by the
Firebase Functions SDK: `getDatabaseWithUrl(url, app?)`. The first Pyric
Functions slice has one shared RTDB instance, so the URL selects that
instance rather than creating a second sandbox database.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_url` | `string` |
| `app?` | `SandboxAdminApp` |

#### Returns

[`Database`](#database)
