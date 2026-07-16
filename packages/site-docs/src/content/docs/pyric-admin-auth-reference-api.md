---
title: "API reference: pyric-admin/auth"
navLabel: "pyric-admin/auth"
group: "API reference"
section: "pyric-admin"
order: 9004
description: "Published declarations for pyric-admin/auth."
kind: "api"
apiPackage: "pyric-admin"
apiImportPath: "pyric-admin/auth"
apiSubpath: "auth"
apiSymbolCount: 10
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="auth"></a>

### Auth

Sandbox Auth interface intentionally limited to implemented behavior.

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="app"></a> `app` | `readonly` | `SandboxAdminApp` |

#### Methods

<a id="createcustomtoken"></a>

##### createCustomToken()

```ts
createCustomToken(uid: string, developerClaims?: object): Promise<string>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |
| `developerClaims?` | `object` |

###### Returns

`Promise`\<`string`\>

<a id="createuser"></a>

##### createUser()

```ts
createUser(properties: CreateRequest): Promise<UserRecord>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `properties` | [`CreateRequest`](#createrequest) |

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

<a id="deleteuser"></a>

##### deleteUser()

```ts
deleteUser(uid: string): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |

###### Returns

`Promise`\<`void`\>

<a id="getuser"></a>

##### getUser()

```ts
getUser(uid: string): Promise<UserRecord>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

<a id="getuserbyemail"></a>

##### getUserByEmail()

```ts
getUserByEmail(email: string): Promise<UserRecord>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `email` | `string` |

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

<a id="listusers"></a>

##### listUsers()

```ts
listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `maxResults?` | `number` |
| `pageToken?` | `string` |

###### Returns

`Promise`\<[`ListUsersResult`](#listusersresult)\>

<a id="setcustomuserclaims"></a>

##### setCustomUserClaims()

```ts
setCustomUserClaims(uid: string, customUserClaims: object): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |
| `customUserClaims` | `object` |

###### Returns

`Promise`\<`void`\>

<a id="updateuser"></a>

##### updateUser()

```ts
updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |
| `properties` | [`UpdateRequest`](#updaterequest) |

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

<a id="verifyidtoken"></a>

##### verifyIdToken()

```ts
verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `idToken` | `string` |
| `checkRevoked?` | `boolean` |

###### Returns

`Promise`\<[`DecodedIdToken`](#decodedidtoken)\>

***

<a id="createrequest"></a>

### CreateRequest

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="disabled"></a> `disabled?` | `boolean` |
| <a id="displayname"></a> `displayName?` | `string` |
| <a id="email"></a> `email?` | `string` |
| <a id="emailverified"></a> `emailVerified?` | `boolean` |
| <a id="password"></a> `password?` | `string` |
| <a id="phonenumber"></a> `phoneNumber?` | `string` |
| <a id="photourl"></a> `photoURL?` | `string` |
| <a id="uid"></a> `uid?` | `string` |

***

<a id="decodedidtoken"></a>

### DecodedIdToken

#### Extends

- `Record`\<`string`, `unknown`\>

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="aud"></a> `aud` | `string` |
| <a id="auth_time"></a> `auth_time` | `number` |
| <a id="exp"></a> `exp` | `number` |
| <a id="firebase"></a> `firebase` | \{ `identities`: `Record`\<`string`, `unknown`\>; `sign_in_provider`: `string`; \} |
| `firebase.identities` | `Record`\<`string`, `unknown`\> |
| `firebase.sign_in_provider` | `string` |
| <a id="iat"></a> `iat` | `number` |
| <a id="iss"></a> `iss` | `string` |
| <a id="sub"></a> `sub` | `string` |
| <a id="uid-1"></a> `uid` | `string` |

***

<a id="listusersresult"></a>

### ListUsersResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="pagetoken"></a> `pageToken?` | `string` |
| <a id="users"></a> `users` | [`UserRecord`](#userrecord)[] |

***

<a id="updaterequest"></a>

### UpdateRequest

#### Extends

- `Omit`\<[`CreateRequest`](#createrequest), `"uid"`\>

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="disabled-1"></a> `disabled?` | `boolean` |
| <a id="displayname-1"></a> `displayName?` | `string` |
| <a id="email-1"></a> `email?` | `string` |
| <a id="emailverified-1"></a> `emailVerified?` | `boolean` |
| <a id="multifactor"></a> `multiFactor?` | `unknown` |
| <a id="password-1"></a> `password?` | `string` |
| <a id="phonenumber-1"></a> `phoneNumber?` | `string` |
| <a id="photourl-1"></a> `photoURL?` | `string` |
| <a id="providerstounlink"></a> `providersToUnlink?` | `unknown` |
| <a id="providertolink"></a> `providerToLink?` | `unknown` |

***

<a id="userinfo"></a>

### UserInfo

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="displayname-2"></a> `displayName?` | `string` |
| <a id="email-2"></a> `email?` | `string` |
| <a id="phonenumber-2"></a> `phoneNumber?` | `string` |
| <a id="photourl-2"></a> `photoURL?` | `string` |
| <a id="providerid"></a> `providerId` | `string` |
| <a id="uid-2"></a> `uid` | `string` |

#### Methods

<a id="tojson"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

###### Returns

`Record`\<`string`, `unknown`\>

***

<a id="usermetadata"></a>

### UserMetadata

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="creationtime"></a> `creationTime` | `string` |
| <a id="lastsignintime"></a> `lastSignInTime` | `string` |

#### Methods

<a id="tojson-2"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

###### Returns

`Record`\<`string`, `unknown`\>

***

<a id="userrecord"></a>

### UserRecord

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="customclaims"></a> `customClaims?` | `readonly` | `Record`\<`string`, `unknown`\> |
| <a id="disabled-2"></a> `disabled` | `readonly` | `boolean` |
| <a id="displayname-3"></a> `displayName?` | `readonly` | `string` |
| <a id="email-3"></a> `email?` | `readonly` | `string` |
| <a id="emailverified-2"></a> `emailVerified` | `readonly` | `boolean` |
| <a id="metadata"></a> `metadata` | `readonly` | [`UserMetadata`](#usermetadata) |
| <a id="phonenumber-3"></a> `phoneNumber?` | `readonly` | `string` |
| <a id="photourl-3"></a> `photoURL?` | `readonly` | `string` |
| <a id="providerdata"></a> `providerData` | `readonly` | [`UserInfo`](#userinfo)[] |
| <a id="tenantid"></a> `tenantId` | `readonly` | `string` |
| <a id="uid-3"></a> `uid` | `readonly` | `string` |

#### Methods

<a id="tojson-4"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

###### Returns

`Record`\<`string`, `unknown`\>

## Variables

<a id="sandbox_token_prefix"></a>

### SANDBOX\_TOKEN\_PREFIX

```ts
const SANDBOX_TOKEN_PREFIX: "pyric-sandbox-custom" = "pyric-sandbox-custom";
```

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

<a id="getauth"></a>

### getAuth()

```ts
function getAuth(app?: SandboxAdminApp): Auth;
```

Return an `Auth` handle for the given app — or for the DEFAULT app when
called with no argument (mirrors firebase-admin's no-arg `getAuth()`:
resolves `'[DEFAULT]'` through `pyric-admin/app`'s registry and throws
`app/no-app` when nothing has been initialized). Local sandboxes use the
in-memory store; remote sandboxes relay to the browser-hosted worker.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app?` | `SandboxAdminApp` |

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
