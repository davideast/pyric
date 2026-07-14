<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric-admin/database

## Interfaces

### Database

#### Properties

##### app

> `readonly` **app**: `unknown`

#### Methods

##### getRules()

> **getRules**(): `Promise`\<`string`\>

###### Returns

`Promise`\<`string`\>

##### getRulesJSON()

> **getRulesJSON**(): `Promise`\<`object`\>

###### Returns

`Promise`\<`object`\>

##### goOffline()

> **goOffline**(): `void`

###### Returns

`void`

##### goOnline()

> **goOnline**(): `void`

###### Returns

`void`

##### ref()

> **ref**(`path?`): [`Reference`](#reference)

###### Parameters

###### path?

`string`

###### Returns

[`Reference`](#reference)

##### refFromURL()

> **refFromURL**(`url`): [`Reference`](#reference)

###### Parameters

###### url

`string`

###### Returns

[`Reference`](#reference)

##### setRules()

> **setRules**(`source`): `Promise`\<`void`\>

###### Parameters

###### source

`string` | `object`

###### Returns

`Promise`\<`void`\>

***

### DataSnapshot

#### Properties

##### key

> `readonly` **key**: `string`

##### ref

> `readonly` **ref**: [`Reference`](#reference)

#### Methods

##### child()

> **child**(`path`): [`DataSnapshot`](#datasnapshot)

###### Parameters

###### path

`string`

###### Returns

[`DataSnapshot`](#datasnapshot)

##### exists()

> **exists**(): `boolean`

###### Returns

`boolean`

##### exportVal()

> **exportVal**(): `unknown`

###### Returns

`unknown`

##### forEach()

> **forEach**(`action`): `boolean`

###### Parameters

###### action

(`child`) => `boolean` \| `void`

###### Returns

`boolean`

##### getPriority()

> **getPriority**(): `string` \| `number`

###### Returns

`string` \| `number`

##### hasChild()

> **hasChild**(`path`): `boolean`

###### Parameters

###### path

`string`

###### Returns

`boolean`

##### hasChildren()

> **hasChildren**(`children?`): `boolean`

###### Parameters

###### children?

`string`[]

###### Returns

`boolean`

##### numChildren()

> **numChildren**(): `number`

###### Returns

`number`

##### toJSON()

> **toJSON**(): `unknown`

###### Returns

`unknown`

##### val()

> **val**(): `unknown`

###### Returns

`unknown`

***

### OnDisconnect

#### Indexable

\[`key`: `string`\]: `unknown`

***

### Reference

#### Indexable

\[`key`: `string`\]: `unknown`

#### Properties

##### database

> `readonly` **database**: [`Database`](#database)

##### key

> `readonly` **key**: `string`

##### parent

> `readonly` **parent**: [`Reference`](#reference)

##### ref

> `readonly` **ref**: [`Reference`](#reference)

##### root

> `readonly` **root**: [`Reference`](#reference)

#### Methods

##### child()

> **child**(`path`): [`Reference`](#reference)

###### Parameters

###### path

`string`

###### Returns

[`Reference`](#reference)

##### get()

> **get**(): `Promise`\<[`DataSnapshot`](#datasnapshot)\>

###### Returns

`Promise`\<[`DataSnapshot`](#datasnapshot)\>

##### off()

> **off**(`eventType?`, `callback?`): `void`

###### Parameters

###### eventType?

[`EventType`](#eventtype)

###### callback?

(`snapshot`, `previousChildKey?`) => `unknown`

###### Returns

`void`

##### on()

> **on**(`eventType`, `callback`, `cancelCallback?`): `unknown`

###### Parameters

###### eventType

[`EventType`](#eventtype)

###### callback

(`snapshot`, `previousChildKey?`) => `unknown`

###### cancelCallback?

(`error`) => `unknown`

###### Returns

`unknown`

##### once()

> **once**(`eventType`, `successCallback?`, `failureCallback?`): `Promise`\<[`DataSnapshot`](#datasnapshot)\>

###### Parameters

###### eventType

[`EventType`](#eventtype)

###### successCallback?

(`snapshot`) => `unknown`

###### failureCallback?

(`error`) => `unknown`

###### Returns

`Promise`\<[`DataSnapshot`](#datasnapshot)\>

##### push()

> **push**(`value?`, `onComplete?`): [`ThenableReference`](#thenablereference)

###### Parameters

###### value?

`unknown`

###### onComplete?

(`error`) => `void`

###### Returns

[`ThenableReference`](#thenablereference)

##### remove()

> **remove**(`onComplete?`): `Promise`\<`void`\>

###### Parameters

###### onComplete?

(`error`) => `void`

###### Returns

`Promise`\<`void`\>

##### set()

> **set**(`value`, `onComplete?`): `Promise`\<`void`\>

###### Parameters

###### value

`unknown`

###### onComplete?

(`error`) => `void`

###### Returns

`Promise`\<`void`\>

##### toString()

> **toString**(): `string`

###### Returns

`string`

##### update()

> **update**(`values`, `onComplete?`): `Promise`\<`void`\>

###### Parameters

###### values

`object`

###### onComplete?

(`error`) => `void`

###### Returns

`Promise`\<`void`\>

## Type Aliases

### EventType

> **EventType** = `"value"` \| `"child_added"` \| `"child_changed"` \| `"child_removed"` \| `"child_moved"`

Mirror-owned structural types for the implemented admin RTDB surface.

***

### Query

> **Query** = [`Reference`](#reference)

***

### ThenableReference

> **ThenableReference** = [`Reference`](#reference) & `PromiseLike`\<[`Reference`](#reference)\>

## Functions

### getDatabase()

> **getDatabase**(`app?`, `_url?`): [`Database`](#database)

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

##### app?

`SandboxAdminApp`

##### \_url?

`string`

#### Returns

[`Database`](#database)

***

### getDatabaseWithUrl()

> **getDatabaseWithUrl**(`_url`, `app?`): [`Database`](#database)

Returns the AdminDatabase service selected by an upstream-shaped
database URL.

This is the exact `firebase-admin/database` argument order used by the
Firebase Functions SDK: `getDatabaseWithUrl(url, app?)`. The first Pyric
Functions slice has one shared RTDB instance, so the URL selects that
instance rather than creating a second sandbox database.

#### Parameters

##### \_url

`string`

##### app?

`SandboxAdminApp`

#### Returns

[`Database`](#database)
