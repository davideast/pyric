<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric-admin/auth

## Interfaces

### Auth

Sandbox Auth interface intentionally limited to implemented behavior.

#### Indexable

\[`key`: `string`\]: `unknown`

#### Properties

##### app

> `readonly` **app**: `SandboxAdminApp`

#### Methods

##### createCustomToken()

> **createCustomToken**(`uid`, `developerClaims?`): `Promise`\<`string`\>

###### Parameters

###### uid

`string`

###### developerClaims?

`object`

###### Returns

`Promise`\<`string`\>

##### createUser()

> **createUser**(`properties`): `Promise`\<[`UserRecord`](#userrecord)\>

###### Parameters

###### properties

[`CreateRequest`](#createrequest)

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

##### deleteUser()

> **deleteUser**(`uid`): `Promise`\<`void`\>

###### Parameters

###### uid

`string`

###### Returns

`Promise`\<`void`\>

##### getUser()

> **getUser**(`uid`): `Promise`\<[`UserRecord`](#userrecord)\>

###### Parameters

###### uid

`string`

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

##### getUserByEmail()

> **getUserByEmail**(`email`): `Promise`\<[`UserRecord`](#userrecord)\>

###### Parameters

###### email

`string`

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

##### listUsers()

> **listUsers**(`maxResults?`, `pageToken?`): `Promise`\<[`ListUsersResult`](#listusersresult)\>

###### Parameters

###### maxResults?

`number`

###### pageToken?

`string`

###### Returns

`Promise`\<[`ListUsersResult`](#listusersresult)\>

##### setCustomUserClaims()

> **setCustomUserClaims**(`uid`, `customUserClaims`): `Promise`\<`void`\>

###### Parameters

###### uid

`string`

###### customUserClaims

`object`

###### Returns

`Promise`\<`void`\>

##### updateUser()

> **updateUser**(`uid`, `properties`): `Promise`\<[`UserRecord`](#userrecord)\>

###### Parameters

###### uid

`string`

###### properties

[`UpdateRequest`](#updaterequest)

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

##### verifyIdToken()

> **verifyIdToken**(`idToken`, `checkRevoked?`): `Promise`\<[`DecodedIdToken`](#decodedidtoken)\>

###### Parameters

###### idToken

`string`

###### checkRevoked?

`boolean`

###### Returns

`Promise`\<[`DecodedIdToken`](#decodedidtoken)\>

***

### CreateRequest

#### Properties

##### disabled?

> `optional` **disabled**: `boolean`

##### displayName?

> `optional` **displayName**: `string`

##### email?

> `optional` **email**: `string`

##### emailVerified?

> `optional` **emailVerified**: `boolean`

##### password?

> `optional` **password**: `string`

##### phoneNumber?

> `optional` **phoneNumber**: `string`

##### photoURL?

> `optional` **photoURL**: `string`

##### uid?

> `optional` **uid**: `string`

***

### DecodedIdToken

#### Extends

- `Record`\<`string`, `unknown`\>

#### Indexable

\[`key`: `string`\]: `unknown`

#### Properties

##### aud

> **aud**: `string`

##### auth\_time

> **auth\_time**: `number`

##### exp

> **exp**: `number`

##### firebase

> **firebase**: `object`

###### identities

> **identities**: `Record`\<`string`, `unknown`\>

###### sign\_in\_provider

> **sign\_in\_provider**: `string`

##### iat

> **iat**: `number`

##### iss

> **iss**: `string`

##### sub

> **sub**: `string`

##### uid

> **uid**: `string`

***

### ListUsersResult

#### Properties

##### pageToken?

> `optional` **pageToken**: `string`

##### users

> **users**: [`UserRecord`](#userrecord)[]

***

### UpdateRequest

#### Extends

- `Omit`\<[`CreateRequest`](#createrequest), `"uid"`\>

#### Properties

##### disabled?

> `optional` **disabled**: `boolean`

###### Inherited from

[`CreateRequest`](#createrequest).[`disabled`](#disabled)

##### displayName?

> `optional` **displayName**: `string`

###### Inherited from

[`CreateRequest`](#createrequest).[`displayName`](#displayname)

##### email?

> `optional` **email**: `string`

###### Inherited from

[`CreateRequest`](#createrequest).[`email`](#email)

##### emailVerified?

> `optional` **emailVerified**: `boolean`

###### Inherited from

[`CreateRequest`](#createrequest).[`emailVerified`](#emailverified)

##### multiFactor?

> `optional` **multiFactor**: `unknown`

##### password?

> `optional` **password**: `string`

###### Inherited from

[`CreateRequest`](#createrequest).[`password`](#password)

##### phoneNumber?

> `optional` **phoneNumber**: `string`

###### Inherited from

[`CreateRequest`](#createrequest).[`phoneNumber`](#phonenumber)

##### photoURL?

> `optional` **photoURL**: `string`

###### Inherited from

[`CreateRequest`](#createrequest).[`photoURL`](#photourl)

##### providersToUnlink?

> `optional` **providersToUnlink**: `unknown`

##### providerToLink?

> `optional` **providerToLink**: `unknown`

***

### UserInfo

#### Properties

##### displayName?

> `optional` **displayName**: `string`

##### email?

> `optional` **email**: `string`

##### phoneNumber?

> `optional` **phoneNumber**: `string`

##### photoURL?

> `optional` **photoURL**: `string`

##### providerId

> **providerId**: `string`

##### uid

> **uid**: `string`

#### Methods

##### toJSON()

> **toJSON**(): `Record`\<`string`, `unknown`\>

###### Returns

`Record`\<`string`, `unknown`\>

***

### UserMetadata

#### Properties

##### creationTime

> **creationTime**: `string`

##### lastSignInTime

> **lastSignInTime**: `string`

#### Methods

##### toJSON()

> **toJSON**(): `Record`\<`string`, `unknown`\>

###### Returns

`Record`\<`string`, `unknown`\>

***

### UserRecord

#### Properties

##### customClaims?

> `readonly` `optional` **customClaims**: `Record`\<`string`, `unknown`\>

##### disabled

> `readonly` **disabled**: `boolean`

##### displayName?

> `readonly` `optional` **displayName**: `string`

##### email?

> `readonly` `optional` **email**: `string`

##### emailVerified

> `readonly` **emailVerified**: `boolean`

##### metadata

> `readonly` **metadata**: [`UserMetadata`](#usermetadata)

##### phoneNumber?

> `readonly` `optional` **phoneNumber**: `string`

##### photoURL?

> `readonly` `optional` **photoURL**: `string`

##### providerData

> `readonly` **providerData**: [`UserInfo`](#userinfo)[]

##### tenantId

> `readonly` **tenantId**: `string`

##### uid

> `readonly` **uid**: `string`

#### Methods

##### toJSON()

> **toJSON**(): `Record`\<`string`, `unknown`\>

###### Returns

`Record`\<`string`, `unknown`\>

## Variables

### SANDBOX\_TOKEN\_PREFIX

> `const` **SANDBOX\_TOKEN\_PREFIX**: `"pyric-sandbox-custom"` = `"pyric-sandbox-custom"`

Token format minted by `createCustomToken` and parsed by
`verifyIdToken`. Exported as a constant so tests can lock the shape.

Layout: `pyric-sandbox-custom:${uid}:${jsonClaims}`

- The prefix lets `verifyIdToken` reject foreign tokens with a clear
  "not a sandbox token" error rather than NaN'ing out.
- `uid` is colon-free per the auto-uid format above.
- `jsonClaims` is the JSON-stringified developer claims (or `{}` when
  none were provided). Round-trips losslessly through `JSON.parse`.

NOT a JWT. NOT signed. Do not use this token format to talk to any
real Firebase service — it only round-trips through this same
sandbox backend.

## Functions

### getAuth()

> **getAuth**(`app?`): [`Auth`](#auth)

Return an `Auth` handle for the given app — or for the DEFAULT app when
called with no argument (mirrors firebase-admin's no-arg `getAuth()`:
resolves `'[DEFAULT]'` through `pyric-admin/app`'s registry and throws
`app/no-app` when nothing has been initialized). Local sandboxes use the
in-memory store; remote sandboxes relay to the browser-hosted worker.

#### Parameters

##### app?

`SandboxAdminApp`

#### Returns

[`Auth`](#auth)

#### Example

```ts
import { initializeApp } from 'pyric-admin/app';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth } from 'pyric-admin/auth';

const sandbox = initializeSandbox();
const app = initializeApp({ sandbox });
const auth = getAuth(app);

const user = await auth.createUser({ uid: 'alice', email: 'a@e.com' });
const token = await auth.createCustomToken(user.uid, { role: 'admin' });
const decoded = await auth.verifyIdToken(token);
console.log(decoded.uid, decoded.role); // 'alice' 'admin'
```
