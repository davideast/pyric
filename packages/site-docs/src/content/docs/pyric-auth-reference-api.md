---
title: "API reference: pyric/auth"
navLabel: "pyric/auth"
group: "API reference"
section: "pyric"
order: 9011
description: "Published declarations for pyric/auth."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/auth"
apiSubpath: "auth"
apiSymbolCount: 106
apiEvidenceSlug: "pyric-auth-compat"
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="actioncodeurl"></a>

### ActionCodeURL

A parsed out-of-band action link. Mirrors `firebase/auth`'s
`ActionCodeURL`.

Construct one only via [ActionCodeURL.parseLink](#parselink) or
[parseActionCodeURL](#parseactioncodeurl) — upstream's constructor is internal, and
both entry points return `null` rather than throwing for a link that
does not carry the required `mode` + `oobCode`.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="apikey"></a> `apiKey` | `readonly` | `string` | The project API key carried in the link, or `null`. |
| <a id="code"></a> `code` | `readonly` | `string` | The out-of-band code — the bearer token the action-code consumers (`applyActionCode`, `confirmPasswordReset`, …) redeem. |
| <a id="continueurl"></a> `continueUrl` | `readonly` | `string` | Where to send the user after the action completes. URL-decoded. `null` when the link carried no `continueUrl`. |
| <a id="languagecode"></a> `languageCode` | `readonly` | `string` | BCP-47 language tag from the link's `lang` param, or `null`. |
| <a id="operation"></a> `operation` | `readonly` | `string` | The normalized operation the code authorizes. One of [ActionCodeOperation](#actioncodeoperation) — NOT the raw `mode` param. |
| <a id="tenantid"></a> `tenantId` | `readonly` | `string` | Multi-tenant tenant id, or `null`. The sandbox does not model tenants, so this is always `null` on a sandbox-minted link — but a link produced elsewhere and parsed here round-trips it. |

#### Methods

<a id="parselink"></a>

##### parseLink()

```ts
static parseLink(link: string): ActionCodeURL;
```

Parse an action link. Returns `null` — never throws — when the input
is not a URL, carries no `mode`, carries an unrecognized `mode`, or
carries no `oobCode`. Oracle-pinned (see the file docstring).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `link` | `string` |

###### Returns

[`ActionCodeURL`](#actioncodeurl)

***

<a id="authcredential"></a>

### AuthCredential

Base auth credential. Mirrors `firebase/auth`'s abstract
`AuthCredential`: an opaque token identifying a provider and the
method used to sign in with it.

Concrete, not abstract, so `instanceof AuthCredential` narrowing and
direct construction both work in consumer code. Upstream marks it
abstract, but nothing in the modular surface constructs a bare
`AuthCredential` — the providers' static factories do.

#### Extended by

- [`EmailAuthCredential`](#emailauthcredential)
- [`OAuthCredential`](#oauthcredential)

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new AuthCredential(providerId: string, signInMethod: string): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `providerId` | `string` |
| `signInMethod` | `string` |

###### Returns

[`AuthCredential`](#authcredential)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="providerid"></a> `providerId` | `readonly` | `string` | Provider identifier (e.g. `'google.com'`, `'password'`). |
| <a id="signinmethod"></a> `signInMethod` | `readonly` | `string` | Sign-in method identifier. Distinct from [providerId](#providerid): the `'password'` provider signs in via `'password'` OR `'emailLink'`. |

#### Methods

<a id="tojson"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialize. Mirrors upstream's `AuthCredential.toJSON()`.

###### Returns

`Record`\<`string`, `unknown`\>

<a id="fromjson"></a>

##### fromJSON()

```ts
static fromJSON(json: string | Record<string, unknown>): AuthCredential;
```

Deserialize a credential previously produced by [toJSON](#tojson).
Returns `null` for input that isn't a credential payload — matching
upstream, which never throws here.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `json` | `string` \| `Record`\<`string`, `unknown`\> |

###### Returns

[`AuthCredential`](#authcredential)

***

<a id="emailauthcredential"></a>

### EmailAuthCredential

Email/password (or email-link) credential. Mirrors `firebase/auth`'s
`EmailAuthCredential`.

Carries the SECRET — which is the whole reason the linking and reauth
families are decidable in the sandbox without a resolver (see the file
docstring). The secret is `password` for the `'password'` sign-in
method and the email LINK for the `'emailLink'` method.

`_secret` is deliberately non-enumerable: it must not leak into a
`JSON.stringify(cred)` in host/log code. [toJSON](#tojson-2) exposes it
only for the round-trip upstream also supports.

#### Extends

- [`AuthCredential`](#authcredential)

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new EmailAuthCredential(
   email: string,
   secret: string,
   signInMethod?: string): EmailAuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `email` | `string` |
| `secret` | `string` |
| `signInMethod?` | `string` |

###### Returns

[`EmailAuthCredential`](#emailauthcredential)

###### Overrides

[`AuthCredential`](#authcredential).[`constructor`](#constructor)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="email"></a> `email` | `readonly` | `string` | The account this credential is for. |
| <a id="providerid-1"></a> `providerId` | `readonly` | `string` | Provider identifier (e.g. `'google.com'`, `'password'`). |
| <a id="signinmethod-1"></a> `signInMethod` | `readonly` | `string` | Sign-in method identifier. Distinct from [providerId](#providerid): the `'password'` provider signs in via `'password'` OR `'emailLink'`. |

#### Accessors

<a id="emaillink"></a>

##### emailLink

###### Get Signature

```ts
get emailLink(): string;
```

The email link carried by an `'emailLink'`-method credential, else `null`.

###### Returns

`string`

<a id="password"></a>

##### password

###### Get Signature

```ts
get password(): string;
```

The password carried by a `'password'`-method credential, else `null`.

###### Returns

`string`

#### Methods

<a id="tojson-2"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialize. Mirrors upstream's `AuthCredential.toJSON()`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Overrides

[`AuthCredential`](#authcredential).[`toJSON`](#tojson)

<a id="fromjson-2"></a>

##### fromJSON()

```ts
static fromJSON(json: string | Record<string, unknown>): AuthCredential;
```

Deserialize a credential previously produced by [toJSON](#tojson).
Returns `null` for input that isn't a credential payload — matching
upstream, which never throws here.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `json` | `string` \| `Record`\<`string`, `unknown`\> |

###### Returns

[`AuthCredential`](#authcredential)

###### Inherited from

[`AuthCredential`](#authcredential).[`fromJSON`](#fromjson)

***

<a id="emailauthprovider"></a>

### EmailAuthProvider

Email + password provider — marker class, used as the
 `providerId` on email/password credentials.

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new EmailAuthProvider(): EmailAuthProvider;
```

###### Returns

[`EmailAuthProvider`](#emailauthprovider)

#### Properties

| Property | Modifier | Type | Default value |
| :------ | :------ | :------ | :------ |
| <a id="providerid-2"></a> `providerId` | `readonly` | `"password"` | `"password"` |
| <a id="email_link_sign_in_method"></a> `EMAIL_LINK_SIGN_IN_METHOD` | `readonly` | `"emailLink"` | `"emailLink"` |
| <a id="email_password_sign_in_method"></a> `EMAIL_PASSWORD_SIGN_IN_METHOD` | `readonly` | `"password"` | `"password"` |
| <a id="provider_id"></a> `PROVIDER_ID` | `readonly` | `"password"` | `"password"` |

#### Methods

<a id="credential"></a>

##### credential()

```ts
static credential(email: string, password: string): EmailAuthCredential;
```

Build an email/password credential. The credential CARRIES THE
PASSWORD — which is what lets `linkWithCredential` and
`reauthenticateWithCredential` actually verify it against the sandbox
user DB, with no resolver and no mock. See `credentials.ts`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `email` | `string` |
| `password` | `string` |

###### Returns

[`EmailAuthCredential`](#emailauthcredential)

<a id="credentialwithlink"></a>

##### credentialWithLink()

```ts
static credentialWithLink(email: string, emailLink: string): EmailAuthCredential;
```

Build an email-LINK credential from a link the user received. Its
 secret is the link itself.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `email` | `string` |
| `emailLink` | `string` |

###### Returns

[`EmailAuthCredential`](#emailauthcredential)

***

<a id="facebookauthprovider"></a>

### FacebookAuthProvider

Facebook OAuth provider.

#### Constructors

<a id="constructor-3"></a>

##### Constructor

```ts
new FacebookAuthProvider(): FacebookAuthProvider;
```

###### Returns

[`FacebookAuthProvider`](#facebookauthprovider)

#### Properties

| Property | Modifier | Type | Default value |
| :------ | :------ | :------ | :------ |
| <a id="providerid-3"></a> `providerId` | `readonly` | `"facebook.com"` | `"facebook.com"` |
| <a id="facebook_sign_in_method"></a> `FACEBOOK_SIGN_IN_METHOD` | `readonly` | `"facebook.com"` | `"facebook.com"` |
| <a id="provider_id-1"></a> `PROVIDER_ID` | `readonly` | `"facebook.com"` | `"facebook.com"` |

#### Methods

<a id="addscope"></a>

##### addScope()

```ts
addScope(_scope: string): FacebookAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_scope` | `string` |

###### Returns

[`FacebookAuthProvider`](#facebookauthprovider)

<a id="setcustomparameters"></a>

##### setCustomParameters()

```ts
setCustomParameters(_params: Record<string, unknown>): FacebookAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_params` | `Record`\<`string`, `unknown`\> |

###### Returns

[`FacebookAuthProvider`](#facebookauthprovider)

<a id="credential-2"></a>

##### credential()

```ts
static credential(accessToken: string): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromerror"></a>

##### credentialFromError()

```ts
static credentialFromError(_err: unknown): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_err` | `unknown` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromresult"></a>

##### credentialFromResult()

```ts
static credentialFromResult(result: UserCredential): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `result` | [`UserCredential`](#usercredential) |

###### Returns

[`AuthCredential`](#authcredential)

***

<a id="githubauthprovider"></a>

### GithubAuthProvider

GitHub OAuth provider.

#### Constructors

<a id="constructor-4"></a>

##### Constructor

```ts
new GithubAuthProvider(): GithubAuthProvider;
```

###### Returns

[`GithubAuthProvider`](#githubauthprovider)

#### Properties

| Property | Modifier | Type | Default value |
| :------ | :------ | :------ | :------ |
| <a id="providerid-4"></a> `providerId` | `readonly` | `"github.com"` | `"github.com"` |
| <a id="github_sign_in_method"></a> `GITHUB_SIGN_IN_METHOD` | `readonly` | `"github.com"` | `"github.com"` |
| <a id="provider_id-2"></a> `PROVIDER_ID` | `readonly` | `"github.com"` | `"github.com"` |

#### Methods

<a id="addscope-2"></a>

##### addScope()

```ts
addScope(_scope: string): GithubAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_scope` | `string` |

###### Returns

[`GithubAuthProvider`](#githubauthprovider)

<a id="setcustomparameters-2"></a>

##### setCustomParameters()

```ts
setCustomParameters(_params: Record<string, unknown>): GithubAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_params` | `Record`\<`string`, `unknown`\> |

###### Returns

[`GithubAuthProvider`](#githubauthprovider)

<a id="credential-4"></a>

##### credential()

```ts
static credential(accessToken: string): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromerror-2"></a>

##### credentialFromError()

```ts
static credentialFromError(_err: unknown): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_err` | `unknown` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromresult-2"></a>

##### credentialFromResult()

```ts
static credentialFromResult(result: UserCredential): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `result` | [`UserCredential`](#usercredential) |

###### Returns

[`AuthCredential`](#authcredential)

***

<a id="googleauthprovider"></a>

### GoogleAuthProvider

Google OAuth provider. Sandbox marker; no real OAuth flow runs.

#### Constructors

<a id="constructor-5"></a>

##### Constructor

```ts
new GoogleAuthProvider(): GoogleAuthProvider;
```

###### Returns

[`GoogleAuthProvider`](#googleauthprovider)

#### Properties

| Property | Modifier | Type | Default value |
| :------ | :------ | :------ | :------ |
| <a id="providerid-5"></a> `providerId` | `readonly` | `"google.com"` | `"google.com"` |
| <a id="google_sign_in_method"></a> `GOOGLE_SIGN_IN_METHOD` | `readonly` | `"google.com"` | `"google.com"` |
| <a id="provider_id-3"></a> `PROVIDER_ID` | `readonly` | `"google.com"` | `"google.com"` |

#### Methods

<a id="addscope-4"></a>

##### addScope()

```ts
addScope(_scope: string): GoogleAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_scope` | `string` |

###### Returns

[`GoogleAuthProvider`](#googleauthprovider)

<a id="setcustomparameters-4"></a>

##### setCustomParameters()

```ts
setCustomParameters(_params: Record<string, unknown>): GoogleAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_params` | `Record`\<`string`, `unknown`\> |

###### Returns

[`GoogleAuthProvider`](#googleauthprovider)

<a id="credential-6"></a>

##### credential()

```ts
static credential(idToken?: string, accessToken?: string): AuthCredential;
```

Construct a credential directly from an OAuth id_token /
 access_token. Sandbox accepts any string; opaque marker only.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `idToken?` | `string` |
| `accessToken?` | `string` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromerror-4"></a>

##### credentialFromError()

```ts
static credentialFromError(_err: unknown): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_err` | `unknown` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromresult-4"></a>

##### credentialFromResult()

```ts
static credentialFromResult(result: UserCredential): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `result` | [`UserCredential`](#usercredential) |

###### Returns

[`AuthCredential`](#authcredential)

***

<a id="oauthcredential"></a>

### OAuthCredential

OAuth credential. Mirrors `firebase/auth`'s `OAuthCredential`.

Carries the IdP tokens the real flow would have obtained. The sandbox
does NOT and cannot verify them — it is not the identity provider —
so flows consuming one of these still resolve through the
`AuthFlowResolver` / `mockSignInResult` seam. Keeping the tokens on
the object anyway means a resolver implementation (a playground
picker, a test fixture) can read whatever the caller passed.

#### Extends

- [`AuthCredential`](#authcredential)

#### Constructors

<a id="constructor-6"></a>

##### Constructor

```ts
new OAuthCredential(
   providerId: string,
   signInMethod: string,
   tokens?: {
  accessToken?: string;
  idToken?: string;
  secret?: string;
}): OAuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `providerId` | `string` |
| `signInMethod` | `string` |
| `tokens?` | \{ `accessToken?`: `string`; `idToken?`: `string`; `secret?`: `string`; \} |
| `tokens.accessToken?` | `string` |
| `tokens.idToken?` | `string` |
| `tokens.secret?` | `string` |

###### Returns

[`OAuthCredential`](#oauthcredential)

###### Overrides

[`AuthCredential`](#authcredential).[`constructor`](#constructor)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="accesstoken"></a> `accessToken?` | `readonly` | `string` | - |
| <a id="idtoken"></a> `idToken?` | `readonly` | `string` | - |
| <a id="providerid-6"></a> `providerId` | `readonly` | `string` | Provider identifier (e.g. `'google.com'`, `'password'`). |
| <a id="secret"></a> `secret?` | `readonly` | `string` | - |
| <a id="signinmethod-2"></a> `signInMethod` | `readonly` | `string` | Sign-in method identifier. Distinct from [providerId](#providerid): the `'password'` provider signs in via `'password'` OR `'emailLink'`. |

#### Methods

<a id="tojson-4"></a>

##### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Serialize. Mirrors upstream's `AuthCredential.toJSON()`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Overrides

[`AuthCredential`](#authcredential).[`toJSON`](#tojson)

<a id="fromjson-4"></a>

##### fromJSON()

```ts
static fromJSON(json: string | Record<string, unknown>): AuthCredential;
```

Deserialize a credential previously produced by [toJSON](#tojson).
Returns `null` for input that isn't a credential payload — matching
upstream, which never throws here.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `json` | `string` \| `Record`\<`string`, `unknown`\> |

###### Returns

[`AuthCredential`](#authcredential)

###### Inherited from

[`AuthCredential`](#authcredential).[`fromJSON`](#fromjson)

***

<a id="oauthprovider"></a>

### OAuthProvider

Generic OAuth provider — constructed with a providerId so callers
can target arbitrary OAuth IdPs (Twitter, Apple, etc.) that don't
have a dedicated class above.

#### Constructors

<a id="constructor-7"></a>

##### Constructor

```ts
new OAuthProvider(providerId: string): OAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `providerId` | `string` |

###### Returns

[`OAuthProvider`](#oauthprovider)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="providerid-7"></a> `providerId` | `readonly` | `string` |

#### Methods

<a id="addscope-6"></a>

##### addScope()

```ts
addScope(_scope: string): OAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_scope` | `string` |

###### Returns

[`OAuthProvider`](#oauthprovider)

<a id="credential-8"></a>

##### credential()

```ts
credential(args: {
  accessToken?: string;
  idToken?: string;
  rawNonce?: string;
}): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `args` | \{ `accessToken?`: `string`; `idToken?`: `string`; `rawNonce?`: `string`; \} |
| `args.accessToken?` | `string` |
| `args.idToken?` | `string` |
| `args.rawNonce?` | `string` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="setcustomparameters-6"></a>

##### setCustomParameters()

```ts
setCustomParameters(_params: Record<string, unknown>): OAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_params` | `Record`\<`string`, `unknown`\> |

###### Returns

[`OAuthProvider`](#oauthprovider)

<a id="credentialfromerror-6"></a>

##### credentialFromError()

```ts
static credentialFromError(_err: unknown): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_err` | `unknown` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromresult-6"></a>

##### credentialFromResult()

```ts
static credentialFromResult(result: UserCredential): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `result` | [`UserCredential`](#usercredential) |

###### Returns

[`AuthCredential`](#authcredential)

***

<a id="samlauthprovider"></a>

### SAMLAuthProvider

SAML provider. Constructed with a provider id that MUST start with
`saml.` — upstream enforces that prefix because the id is what routes an
assertion to the right configured SAML IdP, and a typo there would
silently target nothing.

A SAML sign-in has no client-constructible credential (the assertion
comes from the IdP), which is why this class has no `credential()`
factory — only the popup/redirect flows produce one, and in the sandbox
those resolve through the `AuthFlowResolver` seam like every other
federated provider.

#### Constructors

<a id="constructor-8"></a>

##### Constructor

```ts
new SAMLAuthProvider(providerId: string): SAMLAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `providerId` | `string` |

###### Returns

[`SAMLAuthProvider`](#samlauthprovider)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="providerid-8"></a> `providerId` | `readonly` | `string` |

#### Methods

<a id="credentialfromerror-8"></a>

##### credentialFromError()

```ts
static credentialFromError(_err: unknown): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_err` | `unknown` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromresult-8"></a>

##### credentialFromResult()

```ts
static credentialFromResult(result: UserCredential): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `result` | [`UserCredential`](#usercredential) |

###### Returns

[`AuthCredential`](#authcredential)

***

<a id="twitterauthprovider"></a>

### TwitterAuthProvider

Twitter (X) OAuth provider. A dedicated class rather than a generic
`OAuthProvider('twitter.com')` because upstream ships one and consumer
code imports it by name.

Twitter is the one OAuth 1.0a provider in the set, which is why its
`credential()` takes a token AND a secret where the OAuth 2.0 providers
take a single access token.

#### Constructors

<a id="constructor-9"></a>

##### Constructor

```ts
new TwitterAuthProvider(): TwitterAuthProvider;
```

###### Returns

[`TwitterAuthProvider`](#twitterauthprovider)

#### Properties

| Property | Modifier | Type | Default value |
| :------ | :------ | :------ | :------ |
| <a id="providerid-9"></a> `providerId` | `readonly` | `"twitter.com"` | `"twitter.com"` |
| <a id="provider_id-4"></a> `PROVIDER_ID` | `readonly` | `"twitter.com"` | `"twitter.com"` |
| <a id="twitter_sign_in_method"></a> `TWITTER_SIGN_IN_METHOD` | `readonly` | `"twitter.com"` | `"twitter.com"` |

#### Methods

<a id="addscope-8"></a>

##### addScope()

```ts
addScope(_scope: string): TwitterAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_scope` | `string` |

###### Returns

[`TwitterAuthProvider`](#twitterauthprovider)

<a id="setcustomparameters-8"></a>

##### setCustomParameters()

```ts
setCustomParameters(_params: Record<string, unknown>): TwitterAuthProvider;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_params` | `Record`\<`string`, `unknown`\> |

###### Returns

[`TwitterAuthProvider`](#twitterauthprovider)

<a id="credential-10"></a>

##### credential()

```ts
static credential(token: string, secret: string): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `token` | `string` |
| `secret` | `string` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromerror-10"></a>

##### credentialFromError()

```ts
static credentialFromError(_err: unknown): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `_err` | `unknown` |

###### Returns

[`AuthCredential`](#authcredential)

<a id="credentialfromresult-10"></a>

##### credentialFromResult()

```ts
static credentialFromResult(result: UserCredential): AuthCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `result` | [`UserCredential`](#usercredential) |

###### Returns

[`AuthCredential`](#authcredential)

## Interfaces

<a id="actioncodeinfo"></a>

### ActionCodeInfo

What `checkActionCode` returns. Mirror of `firebase/auth`'s
`ActionCodeInfo`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="data"></a> `data` | \{ `email?`: `string`; `multiFactorInfo?`: `null`; `previousEmail?`: `string`; \} | - |
| `data.email?` | `string` | The account the code acts on. |
| `data.multiFactorInfo?` | `null` | - |
| `data.previousEmail?` | `string` | For `VERIFY_AND_CHANGE_EMAIL`: the address being moved AWAY from. |
| <a id="operation-1"></a> `operation` | `string` | One of [ActionCodeOperation](#actioncodeoperation). |

***

<a id="actioncodesettings"></a>

### ActionCodeSettings

`ActionCodeSettings` — mirror of `firebase/auth`. The continue-URL
contract for a mailed link.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="android"></a> `android?` | \{ `installApp?`: `boolean`; `minimumVersion?`: `string`; `packageName`: `string`; \} | - |
| `android.installApp?` | `boolean` | - |
| `android.minimumVersion?` | `string` | - |
| `android.packageName` | `string` | - |
| <a id="dynamiclinkdomain"></a> `dynamicLinkDomain?` | `string` | Deprecated upstream alias of the Hosting link domain. |
| <a id="handlecodeinapp"></a> `handleCodeInApp?` | `boolean` | Handle the code inside the app rather than on the web widget. REQUIRED (`true`) for `sendSignInLinkToEmail`. |
| <a id="ios"></a> `iOS?` | \{ `bundleId`: `string`; \} | - |
| `iOS.bundleId` | `string` | - |
| <a id="linkdomain"></a> `linkDomain?` | `string` | - |
| <a id="url"></a> `url` | `string` | Where the link sends the user when they click it. REQUIRED. |

***

<a id="additionaluserinfo"></a>

### AdditionalUserInfo

Per-provider extra data attached to a sign-in. Mirrors
`firebase/auth`'s `AdditionalUserInfo`.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="isnewuser"></a> `isNewUser` | `readonly` | `boolean` | Was this credential produced by a sign-UP rather than a sign-IN? |
| <a id="profile"></a> `profile` | `readonly` | `Record`\<`string`, `unknown`\> | IdP-specific profile blob. Empty object for the sandbox's own providers — there is no real IdP behind them to return a profile. |
| <a id="providerid-10"></a> `providerId` | `readonly` | `string` | The provider that authenticated this user, or `null` for the anonymous and custom-token paths (neither is a federated provider — see the `ProviderId` docstring in `enums.ts`). |
| <a id="username"></a> `username?` | `readonly` | `string` | Present only for GitHub / Twitter. |

***

<a id="auth"></a>

### Auth

Hidden brand on every [Auth](#auth) handle. Carries its owning sandbox
target. Consumers don't read it.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="target_symbol"></a> `[TARGET_SYMBOL]` | `readonly` | `SandboxTarget` | Internal — identifies the owning sandbox backend. |
| <a id="app"></a> `app?` | `readonly` | `FirebaseApp` | - |
| <a id="currentuser"></a> `currentUser` | `readonly` | [`User`](#user-1) | Currently signed-in user, or `null`. Snapshot value — read through `onAuthStateChanged` for live updates. |

#### Methods

<a id="signout"></a>

##### signOut()

```ts
signOut(): Promise<void>;
```

Sign the current user out. Method form of the free `signOut(auth)`
 function — `firebase/auth`'s `Auth` exposes both, so consumer code
 written as `auth.signOut()` works unchanged (AUTH-GAP).

###### Returns

`Promise`\<`void`\>

***

<a id="authflowrequest"></a>

### AuthFlowRequest

What a popup/redirect sign-in flow needs to know about the request.
Mirrors the params `firebase/auth` hands its emulator widget
(`providerId`, `authType`, `scopes`, `customParameters` — see
upstream `core/util/handler.ts`), so a resolver implementation has
the same inputs the real flow does.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="authtype"></a> `authType` | `"signIn"` \| `"reauth"` \| `"link"` | Why the popup/redirect opened. v0 only drives `'signIn'`; the others exist for parity with reauth/link flows. |
| <a id="customparameters"></a> `customParameters?` | `Record`\<`string`, `unknown`\> | Provider custom parameters (`setCustomParameters`). Sandbox-opaque. |
| <a id="providerid-11"></a> `providerId` | `string` | e.g. `'google.com'`, `'github.com'`, or a generic `OAuthProvider` id. |
| <a id="scopes"></a> `scopes?` | `string`[] | OAuth scopes the provider requested (`addScope`). Sandbox-opaque. |

***

<a id="authflowresolver"></a>

### AuthFlowResolver

Pluggable popup/redirect resolver — pyric's analog of
`firebase/auth`'s `PopupRedirectResolver`. The SDK stays UI-free and
delegates the *experience* to whatever implements this: a playground
modal, a headless test fixture, a CLI prompt. One resolver serves all
three flows.

Configured the same three ways the upstream resolver is: passed
per-call to `signInWithPopup` / `signInWithRedirect`, injected once
via `sandbox.setAuthFlowResolver` (the analog of browser `getAuth`
wiring `browserPopupRedirectResolver`), or installed implicitly as a
one-shot by `sandbox.mockSignInResult`.

Implementations reject with `auth/popup-closed-by-user` when the user
dismisses the experience — matches `firebase/auth`.

#### Methods

<a id="openpopup"></a>

##### openPopup()

```ts
openPopup(req: AuthFlowRequest): Promise<UserCredential>;
```

Resolve a `signInWithPopup` flow to a credential.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `req` | [`AuthFlowRequest`](#authflowrequest) |

###### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

<a id="openredirect"></a>

##### openRedirect()

```ts
openRedirect(req: AuthFlowRequest): Promise<UserCredential>;
```

Resolve a `signInWithRedirect` flow. In a real browser the redirect
 navigates away and the credential surfaces on return; the sandbox has
 no navigation, so this resolves inline to the credential and the SDK
 stashes it for the next `getRedirectResult`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `req` | [`AuthFlowRequest`](#authflowrequest) |

###### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="authmailresolver"></a>

### AuthMailResolver

Notified for every message the sandbox's auth mail server emits — the
analog of [AuthFlowResolver](#authflowresolver) for the email family. A host (the
playground) installs one to surface the link in its UI; a headless
test reads AuthFlowRegistry.takeMail instead.

Advisory, not a gate: the message is written to the outbox whether or
not a resolver is installed, because in this model the sandbox IS the
mail server — the mail exists regardless of who is watching.

#### Methods

<a id="deliver"></a>

##### deliver()

```ts
deliver(mail: OutboundAuthMail): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `mail` | [`OutboundAuthMail`](#outboundauthmail) |

###### Returns

`void`

***

<a id="authuserrecord"></a>

### AuthUserRecord

Public per-user record for the user-admin surface
(`sandbox.listUsers` & co.) — emulator-REST-shaped (Identity
Toolkit `accounts:lookup` field names, ISO timestamps).

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="createdat"></a> `createdAt` | `string` | ISO timestamp. |
| <a id="customclaims"></a> `customClaims` | `Record`\<`string`, `unknown`\> | - |
| <a id="disabled"></a> `disabled` | `boolean` | - |
| <a id="displayname"></a> `displayName` | `string` | - |
| <a id="email-1"></a> `email` | `string` | - |
| <a id="emailverified"></a> `emailVerified` | `boolean` | - |
| <a id="isanonymous"></a> `isAnonymous` | `boolean` | - |
| <a id="lastloginat"></a> `lastLoginAt` | `string` | ISO timestamp, or null if the identity never signed in. |
| <a id="phonenumber"></a> `phoneNumber` | `string` | - |
| <a id="photourl"></a> `photoUrl` | `string` | - |
| <a id="provideruserinfo"></a> `providerUserInfo` | [`ProviderUserInfo`](#provideruserinfo-2)[] | - |
| <a id="uid"></a> `uid` | `string` | - |

***

<a id="createuserrequest"></a>

### CreateUserRequest

`sandbox.createUser` request. Everything optional except that a
 `password` requires an `email` to be useful for sign-in.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="customclaims-1"></a> `customClaims?` | `Record`\<`string`, `unknown`\> | - |
| <a id="disabled-1"></a> `disabled?` | `boolean` | - |
| <a id="displayname-1"></a> `displayName?` | `string` | - |
| <a id="email-2"></a> `email?` | `string` | - |
| <a id="emailverified-1"></a> `emailVerified?` | `boolean` | - |
| <a id="password-1"></a> `password?` | `string` | - |
| <a id="phonenumber-1"></a> `phoneNumber?` | `string` | - |
| <a id="photourl-1"></a> `photoUrl?` | `string` | - |
| <a id="provideruserinfo-1"></a> `providerUserInfo?` | [`ProviderUserInfo`](#provideruserinfo-2)[] | Linked OAuth providers to create the user with (dedup by providerId; multiple providers per user are supported). Same rules as [UpdateUserRequest.providerUserInfo](#provideruserinfo-3): `password` is credential-derived (send `password` to link it) and `anonymous` is token-level — neither can be forged here. |
| <a id="uid-1"></a> `uid?` | `string` | Defaults to a generated `user-<N>` uid. |

***

<a id="idtokenresult"></a>

### IdTokenResult

Result of `getIdTokenResult()`. Mirrors the `firebase/auth` shape.

On the sandbox backend `token` is an opaque sandbox-issued string
with a recognizable prefix (`sandbox-id-token-`) — NOT a JWT and
NOT cryptographically signed. `claims` echoes the user's
`customClaims` (from `sandbox.seedUsers`) plus a small set of
synthesized standard claims (`sub`, `aud`, `iss`). Expiration is
set far in the future since the sandbox has no refresh story.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="authtime"></a> `authTime` | `string` | ISO string — when the user last *signed in* (not when the token was last refreshed). |
| <a id="claims"></a> `claims` | `Record`\<`string`, `unknown`\> | Custom + standard claims. Same map seen by the rules engine as `request.auth.token.*`. |
| <a id="expirationtime"></a> `expirationTime` | `string` | ISO string. Sandbox: far-future. |
| <a id="issuedattime"></a> `issuedAtTime` | `string` | ISO string. |
| <a id="signinprovider"></a> `signInProvider?` | `string` | Provider of the current sign-in session — `'password'`, `'anonymous'`, `'google.com'`, etc., or `null` when unknown. Mirrors `firebase/auth`'s `IdTokenResult.signInProvider`; the sandbox synthesizes the same `firebase.sign_in_provider` claim. Optional (`?`) for now: external `User` implementations built before this field existed (the playground's helper-minted users, until Track B's lockstep swap lands) omit it. The sandbox backend always populates it. Tighten to required once all `User` minting is backend-owned. |
| <a id="token"></a> `token` | `string` | Opaque sandbox token string: `sandbox-id-token-<uid>-<hash>`. |

***

<a id="mintedsession"></a>

### MintedSession

A minted per-connection session: the `User` plus the AuthState
 its data contexts should carry (`sandbox.withAuth(state)`).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="state"></a> `state` | `any` |
| <a id="user"></a> `user` | [`User`](#user-1) |

***

<a id="outboundauthmail"></a>

### OutboundAuthMail

One message the sandbox's auth "mail server" emitted. Produced by
every send-an-email API (`sendSignInLinkToEmail`,
`sendPasswordResetEmail`, `sendEmailVerification`,
`verifyBeforeUpdateEmail`).

─── Why a mailbox and not a stub ──────────────────────────────────
The email family's one genuinely unobservable step is the human
opening an inbox and clicking a link. Production cannot be probed
across that gap and neither can a test. What the sandbox does is make
the gap CROSSABLE instead of pretending it isn't there: the message,
with its real out-of-band code and its real link, lands in an outbox
the caller can read. `sandbox.takeAuthMail(auth)` is the program's
substitute for a human reading their mail — and the code in that
message is the same code `applyActionCode` / `signInWithEmailLink`
will accept, so the round trip really does close.

That is the same move `mockSignInResult` makes for OAuth: the sandbox
does not fake the outcome of the external step, it hands you the seam
where the external step's result enters the system.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="code-1"></a> `code` | `string` | The out-of-band code the recipient would redeem. |
| <a id="email-3"></a> `email` | `string` | Recipient. |
| <a id="link"></a> `link` | `string` | The full action link the message would contain — the exact string `signInWithEmailLink` / `parseActionCodeURL` accept. |
| <a id="newemail"></a> `newEmail?` | `string` | For `VERIFY_AND_CHANGE_EMAIL`: the address being moved TO. |
| <a id="operation-2"></a> `operation` | `string` | The [ActionCodeOperation](#actioncodeoperation) this message authorizes. |

***

<a id="passwordpolicy"></a>

### PasswordPolicy

Mirror of `firebase/auth`'s `PasswordPolicy`.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="allowednonalphanumericcharacters"></a> `allowedNonAlphanumericCharacters` | `readonly` | `string` | - |
| <a id="customstrengthoptions"></a> `customStrengthOptions` | `readonly` | \{ `containsLowercaseLetter?`: `boolean`; `containsNonAlphanumericCharacter?`: `boolean`; `containsNumericCharacter?`: `boolean`; `containsUppercaseLetter?`: `boolean`; `maxPasswordLength?`: `number`; `minPasswordLength?`: `number`; \} | - |
| `customStrengthOptions.containsLowercaseLetter?` | `readonly` | `boolean` | - |
| `customStrengthOptions.containsNonAlphanumericCharacter?` | `readonly` | `boolean` | - |
| `customStrengthOptions.containsNumericCharacter?` | `readonly` | `boolean` | - |
| `customStrengthOptions.containsUppercaseLetter?` | `readonly` | `boolean` | - |
| `customStrengthOptions.maxPasswordLength?` | `readonly` | `number` | - |
| `customStrengthOptions.minPasswordLength?` | `readonly` | `number` | - |
| <a id="enforcementstate"></a> `enforcementState` | `readonly` | `string` | `'ENFORCE'` or `'OFF'`. |
| <a id="forceupgradeonsignin"></a> `forceUpgradeOnSignin` | `readonly` | `boolean` | - |

***

<a id="passwordvalidationstatus"></a>

### PasswordValidationStatus

Mirror of `firebase/auth`'s `PasswordValidationStatus`.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="containslowercaseletter"></a> `containsLowercaseLetter?` | `readonly` | `boolean` |
| <a id="containsnonalphanumericcharacter"></a> `containsNonAlphanumericCharacter?` | `readonly` | `boolean` |
| <a id="containsnumericcharacter"></a> `containsNumericCharacter?` | `readonly` | `boolean` |
| <a id="containsuppercaseletter"></a> `containsUppercaseLetter?` | `readonly` | `boolean` |
| <a id="isvalid"></a> `isValid` | `readonly` | `boolean` |
| <a id="meetsmaxpasswordlength"></a> `meetsMaxPasswordLength?` | `readonly` | `boolean` |
| <a id="meetsminpasswordlength"></a> `meetsMinPasswordLength?` | `readonly` | `boolean` |
| <a id="passwordpolicy-1"></a> `passwordPolicy` | `readonly` | [`PasswordPolicy`](#passwordpolicy) |

***

<a id="persistence"></a>

### Persistence

Opaque marker for `setPersistence`. The sandbox records the selected
session storage mode from the `type` field.

`'COOKIE'` is upstream's fourth type (`browserCookiePersistence`, for
SSR) — the union matches `firebase/auth`'s `Persistence.type` exactly.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="type"></a> `type` | `readonly` | `"SESSION"` \| `"LOCAL"` \| `"NONE"` \| `"COOKIE"` |

***

<a id="provideruserinfo-2"></a>

### ProviderUserInfo

One linked provider on a stored user. Emulator-shaped (the
 Identity Toolkit `providerUserInfo` array) — an array rather than
 a single string so account linking can extend it later.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="providerid-12"></a> `providerId` | `string` |

***

<a id="seeduser"></a>

### SeedUser

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="customclaims-2"></a> `customClaims?` | `Record`\<`string`, `unknown`\> | - |
| <a id="displayname-2"></a> `displayName?` | `string` | - |
| <a id="email-4"></a> `email` | `string` | - |
| <a id="password-2"></a> `password` | `string` | - |
| <a id="providerid-13"></a> `providerId?` | `string` | Originating provider for this identity (e.g. `'google.com'`). Defaults to `'password'` — the natural provider for a record seeded with an email + password. A host seeding popup-flow identities passes the real provider so `listIdentities` / `IdTokenResult.signInProvider` label them correctly. |
| <a id="uid-2"></a> `uid` | `string` | - |

***

<a id="signinidentityspec"></a>

### SignInIdentitySpec

"Add account" field set for SandboxBackend.createSignInCredential
 — mirrors the emulator's add-user form (`customAttributes` →
 `customClaims`).

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="customclaims-3"></a> `customClaims?` | `Record`\<`string`, `unknown`\> | - |
| <a id="displayname-3"></a> `displayName?` | `string` | - |
| <a id="email-5"></a> `email` | `string` | - |
| <a id="uid-3"></a> `uid?` | `string` | Defaults to `'<providerId>:<email>'`. |

***

<a id="updateuserrequest"></a>

### UpdateUserRequest

`sandbox.updateUser` request — `undefined` fields are left
 untouched; `displayName: null` clears it. `customClaims` replaces
 the whole map (admin `setCustomUserClaims` semantics).

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="customclaims-4"></a> `customClaims?` | `Record`\<`string`, `unknown`\> | - |
| <a id="disabled-2"></a> `disabled?` | `boolean` | - |
| <a id="displayname-4"></a> `displayName?` | `string` | - |
| <a id="email-6"></a> `email?` | `string` | - |
| <a id="emailverified-2"></a> `emailVerified?` | `boolean` | - |
| <a id="password-3"></a> `password?` | `string` | - |
| <a id="provideruserinfo-3"></a> `providerUserInfo?` | [`ProviderUserInfo`](#provideruserinfo-2)[] | REPLACES the user's linked OAuth providers (dedup by providerId; multiple providers per user are supported — the record's `providerUserInfo` is an array precisely for account linking). The `password` entry is credential-derived and managed by the backend: it survives the replacement while the user has a password and cannot be linked through this field; `anonymous` is a token-level provider, never a linked entry. |

***

<a id="user-1"></a>

### User

The signed-in user. Subset of `firebase/auth`'s `User` interface
containing the fields the sandbox can synthesize faithfully.

The heavier `User` surface the sandbox does NOT model (`metadata`,
`refreshToken`, `tenantId`, `reload()`, `delete()`, `toJSON()`) is
intentionally not synthesized; its absence remains visible in the public
type census rather than being hidden behind placeholder values.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="displayname-5"></a> `displayName` | `readonly` | `string` | Display name, or `null` if none. |
| <a id="email-7"></a> `email` | `readonly` | `string` | Email address, or `null` for anonymous users / providers that didn't supply one. |
| <a id="emailverified-3"></a> `emailVerified?` | `readonly` | `boolean` | Whether the email has been verified. Sandbox: `false` unless the seeded/mock user set it (no verification flow). Optional on the type so host helpers that synthesize a partial `User` aren't forced to specify it; the sandbox backend always populates it. |
| <a id="isanonymous-1"></a> `isAnonymous` | `readonly` | `boolean` | True iff this user signed in via `signInAnonymously`. |
| <a id="phonenumber-2"></a> `phoneNumber?` | `readonly` | `string` | E.164 phone number, or `null`. Optional on the type; always populated by the sandbox backend. |
| <a id="photourl-2"></a> `photoURL?` | `readonly` | `string` | Profile photo URL, or `null`. Optional on the type (see [emailVerified](#emailverified-3)); always populated by the sandbox backend. |
| <a id="providerdata"></a> `providerData?` | `readonly` | [`UserInfo`](#userinfo)[] | One [UserInfo](#userinfo) per linked provider. Sandbox synthesizes a single entry from the user's own fields for non-anonymous users; empty for anonymous. Optional on the type; always populated by the sandbox backend. |
| <a id="providerid-14"></a> `providerId?` | `readonly` | `string` | The aggregate provider id (`'firebase'` for a real `User`; per-provider ids live in [providerData](#providerdata)). Optional on the type; always populated by the sandbox backend. |
| <a id="uid-4"></a> `uid` | `readonly` | `string` | Firebase UID — globally unique per project. Sandbox: minted by `signInAnonymously` or supplied via `seedUsers`. |

#### Methods

<a id="getidtoken"></a>

##### getIdToken()

```ts
getIdToken(forceRefresh?: boolean): Promise<string>;
```

Get the user's ID token, refreshing it if needed.

Sandbox: returns the cached opaque token; with
`forceRefresh: true` mints a fresh token, caches it, and fires
`onIdTokenChanged` listeners (matches prod — oracle:
`packages/conformance/observations/auth/auth-getidtoken-force-refresh.json`
and `…/auth-onidtokenchanged-force-refresh.json`).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `forceRefresh?` | `boolean` |

###### Returns

`Promise`\<`string`\>

<a id="getidtokenresult"></a>

##### getIdTokenResult()

```ts
getIdTokenResult(forceRefresh?: boolean): Promise<IdTokenResult>;
```

Get the full ID token + claims. See [IdTokenResult](#idtokenresult).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `forceRefresh?` | `boolean` |

###### Returns

`Promise`\<[`IdTokenResult`](#idtokenresult)\>

***

<a id="usercredential"></a>

### UserCredential

Result of every sign-in method. Mirrors `firebase/auth`.

`operationType` discriminates what produced it: `'signIn'` for a fresh
sign-in (including `createUserWithEmailAndPassword` — oracle-pinned),
`'link'` for `linkWith*`, `'reauthenticate'` for `reauthenticateWith*`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="operationtype"></a> `operationType` | `"signIn"` \| `"link"` \| `"reauthenticate"` |
| <a id="providerid-15"></a> `providerId` | `string` |
| <a id="user-2"></a> `user` | [`User`](#user-1) |

***

<a id="userinfo"></a>

### UserInfo

Per-provider profile info — mirror of `firebase/auth`'s `UserInfo`.
Each entry in [User.providerData](#providerdata) describes one linked provider.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="displayname-6"></a> `displayName` | `readonly` | `string` | Display name from this provider, or `null`. |
| <a id="email-8"></a> `email` | `readonly` | `string` | Email from this provider, or `null`. |
| <a id="phonenumber-3"></a> `phoneNumber` | `readonly` | `string` | E.164 phone number from this provider, or `null`. |
| <a id="photourl-3"></a> `photoURL` | `readonly` | `string` | Profile photo URL from this provider, or `null`. |
| <a id="providerid-16"></a> `providerId` | `readonly` | `string` | Provider id (e.g. `'password'`, `'google.com'`). |
| <a id="uid-5"></a> `uid` | `readonly` | `string` | The user's id as known to this provider. |

## Type Aliases

<a id="actioncodeoperation"></a>

### ActionCodeOperation

```ts
type ActionCodeOperation = typeof ActionCodeOperation[keyof typeof ActionCodeOperation];
```

***

<a id="appauth"></a>

### AppAuth

```ts
type AppAuth = Auth & {
  app: FirebaseApp;
};
```

Auth handle returned by Firebase-shaped app overloads.

#### Type Declaration

##### app

```ts
readonly app: FirebaseApp;
```

***

<a id="autherrormap"></a>

### AuthErrorMap()

```ts
type AuthErrorMap = () => Record<string, string>;
```

An error map — upstream's `AuthErrorMap`. Passed to `initializeAuth`
to control how much detail a thrown `FirebaseError` carries.

#### Returns

`Record`\<`string`, `string`\>

***

<a id="authobserver"></a>

### AuthObserver

```ts
type AuthObserver =
  | (user: User | null) => void
  | {
  complete?: () => void;
  error?: (err: Error) => void;
  next?: (user: User | null) => void;
};
```

Observer shape accepted by `onAuthStateChanged` / `onIdTokenChanged`.
Mirrors `firebase/auth`'s `NextOrObserver<User | null>`.

***

<a id="authprovider"></a>

### AuthProvider

```ts
type AuthProvider =
  | GoogleAuthProvider
  | FacebookAuthProvider
  | GithubAuthProvider
  | OAuthProvider
  | {
  providerId: string;
};
```

Union of all supported provider instance shapes. Used in the
`signInWithPopup` / `signInWithRedirect` overloads (the latter is
out of scope but the type makes the surface consistent).

***

<a id="federatedproviderid"></a>

### FederatedProviderId

```ts
type FederatedProviderId = typeof FEDERATED_PROVIDER_IDS[number];
```

One of the first-class federated provider ids ([FEDERATED\_PROVIDER\_IDS](#federated_provider_ids)).

***

<a id="mintsessionrequest"></a>

### MintSessionRequest

```ts
type MintSessionRequest =
  | {
  kind: "anonymous";
}
  | {
  email: string;
  kind: "password";
  password: string;
}
  | {
  email: string;
  kind: "createPassword";
  password: string;
}
  | {
  kind: "uid";
  uid: string;
};
```

Request for SandboxBackend.mintDetachedSession — one variant
per client sign-in shape, plus `uid` for existing identities
(session restore, provider-bridge accept).

***

<a id="operationtype-1"></a>

### OperationType

```ts
type OperationType = typeof OperationType[keyof typeof OperationType];
```

***

<a id="providerid-17"></a>

### ProviderId

```ts
type ProviderId = typeof ProviderId[keyof typeof ProviderId];
```

***

<a id="signinmethod-3"></a>

### SignInMethod

```ts
type SignInMethod = typeof SignInMethod[keyof typeof SignInMethod];
```

***

<a id="unsubscribe"></a>

### Unsubscribe()

```ts
type Unsubscribe = () => void;
```

Returned by `onAuthStateChanged` / `onIdTokenChanged`.

#### Returns

`void`

## Variables

<a id="actioncodeoperation-1"></a>

### ActionCodeOperation

```ts
const ActionCodeOperation: {
  EMAIL_SIGNIN: "EMAIL_SIGNIN";
  PASSWORD_RESET: "PASSWORD_RESET";
  RECOVER_EMAIL: "RECOVER_EMAIL";
  REVERT_SECOND_FACTOR_ADDITION: "REVERT_SECOND_FACTOR_ADDITION";
  VERIFY_AND_CHANGE_EMAIL: "VERIFY_AND_CHANGE_EMAIL";
  VERIFY_EMAIL: "VERIFY_EMAIL";
};
```

The operation an out-of-band action code authorizes. Mirrors
`firebase/auth`'s `ActionCodeOperation` — the value
[ActionCodeURL.operation](#operation) carries and [checkActionCode](#checkactioncode)
returns.

These are the SDK's normalized names, not the `mode` query param that
appears in the link: a link carrying `mode=resetPassword` parses to
operation `'PASSWORD_RESET'`, and `mode=signIn` parses to
`'EMAIL_SIGNIN'`. Oracle:
`observations/auth/auth-actioncodeurl-parse.json` captured both
mappings against firebase-js-sdk 12.13.0.

#### Type Declaration

<a id="email_signin"></a>

##### EMAIL\_SIGNIN

```ts
readonly EMAIL_SIGNIN: "EMAIL_SIGNIN";
```

<a id="password_reset"></a>

##### PASSWORD\_RESET

```ts
readonly PASSWORD_RESET: "PASSWORD_RESET";
```

<a id="recover_email"></a>

##### RECOVER\_EMAIL

```ts
readonly RECOVER_EMAIL: "RECOVER_EMAIL";
```

<a id="revert_second_factor_addition"></a>

##### REVERT\_SECOND\_FACTOR\_ADDITION

```ts
readonly REVERT_SECOND_FACTOR_ADDITION: "REVERT_SECOND_FACTOR_ADDITION";
```

<a id="verify_and_change_email"></a>

##### VERIFY\_AND\_CHANGE\_EMAIL

```ts
readonly VERIFY_AND_CHANGE_EMAIL: "VERIFY_AND_CHANGE_EMAIL";
```

<a id="verify_email"></a>

##### VERIFY\_EMAIL

```ts
readonly VERIFY_EMAIL: "VERIFY_EMAIL";
```

***

<a id="autherrorcodes"></a>

### AuthErrorCodes

```ts
const AuthErrorCodes: {
  ADMIN_ONLY_OPERATION: "auth/admin-restricted-operation";
  ALREADY_INITIALIZED: "auth/already-initialized";
  APP_NOT_AUTHORIZED: "auth/app-not-authorized";
  APP_NOT_INSTALLED: "auth/app-not-installed";
  ARGUMENT_ERROR: "auth/argument-error";
  CAPTCHA_CHECK_FAILED: "auth/captcha-check-failed";
  CODE_EXPIRED: "auth/code-expired";
  CORDOVA_NOT_READY: "auth/cordova-not-ready";
  CORS_UNSUPPORTED: "auth/cors-unsupported";
  CREDENTIAL_ALREADY_IN_USE: "auth/credential-already-in-use";
  CREDENTIAL_MISMATCH: "auth/custom-token-mismatch";
  CREDENTIAL_TOO_OLD_LOGIN_AGAIN: "auth/requires-recent-login";
  DEPENDENT_SDK_INIT_BEFORE_AUTH: "auth/dependent-sdk-initialized-before-auth";
  DYNAMIC_LINK_NOT_ACTIVATED: "auth/dynamic-link-not-activated";
  EMAIL_CHANGE_NEEDS_VERIFICATION: "auth/email-change-needs-verification";
  EMAIL_EXISTS: "auth/email-already-in-use";
  EMULATOR_CONFIG_FAILED: "auth/emulator-config-failed";
  EXPIRED_OOB_CODE: "auth/expired-action-code";
  EXPIRED_POPUP_REQUEST: "auth/cancelled-popup-request";
  INTERNAL_ERROR: "auth/internal-error";
  INVALID_API_KEY: "auth/invalid-api-key";
  INVALID_APP_CREDENTIAL: "auth/invalid-app-credential";
  INVALID_APP_ID: "auth/invalid-app-id";
  INVALID_AUTH: "auth/invalid-user-token";
  INVALID_AUTH_EVENT: "auth/invalid-auth-event";
  INVALID_CERT_HASH: "auth/invalid-cert-hash";
  INVALID_CODE: "auth/invalid-verification-code";
  INVALID_CONTINUE_URI: "auth/invalid-continue-uri";
  INVALID_CORDOVA_CONFIGURATION: "auth/invalid-cordova-configuration";
  INVALID_CUSTOM_TOKEN: "auth/invalid-custom-token";
  INVALID_DYNAMIC_LINK_DOMAIN: "auth/invalid-dynamic-link-domain";
  INVALID_EMAIL: "auth/invalid-email";
  INVALID_EMULATOR_SCHEME: "auth/invalid-emulator-scheme";
  INVALID_HOSTING_LINK_DOMAIN: "auth/invalid-hosting-link-domain";
  INVALID_IDP_RESPONSE: "auth/invalid-credential";
  INVALID_LOGIN_CREDENTIALS: "auth/invalid-credential";
  INVALID_MESSAGE_PAYLOAD: "auth/invalid-message-payload";
  INVALID_MFA_SESSION: "auth/invalid-multi-factor-session";
  INVALID_OAUTH_CLIENT_ID: "auth/invalid-oauth-client-id";
  INVALID_OAUTH_PROVIDER: "auth/invalid-oauth-provider";
  INVALID_OOB_CODE: "auth/invalid-action-code";
  INVALID_ORIGIN: "auth/unauthorized-domain";
  INVALID_PASSWORD: "auth/wrong-password";
  INVALID_PERSISTENCE: "auth/invalid-persistence-type";
  INVALID_PHONE_NUMBER: "auth/invalid-phone-number";
  INVALID_PROVIDER_ID: "auth/invalid-provider-id";
  INVALID_RECAPTCHA_ACTION: "auth/invalid-recaptcha-action";
  INVALID_RECAPTCHA_TOKEN: "auth/invalid-recaptcha-token";
  INVALID_RECAPTCHA_VERSION: "auth/invalid-recaptcha-version";
  INVALID_RECIPIENT_EMAIL: "auth/invalid-recipient-email";
  INVALID_REQ_TYPE: "auth/invalid-req-type";
  INVALID_SENDER: "auth/invalid-sender";
  INVALID_SESSION_INFO: "auth/invalid-verification-id";
  INVALID_TENANT_ID: "auth/invalid-tenant-id";
  MFA_INFO_NOT_FOUND: "auth/multi-factor-info-not-found";
  MFA_REQUIRED: "auth/multi-factor-auth-required";
  MISSING_ANDROID_PACKAGE_NAME: "auth/missing-android-pkg-name";
  MISSING_APP_CREDENTIAL: "auth/missing-app-credential";
  MISSING_AUTH_DOMAIN: "auth/auth-domain-config-required";
  MISSING_CLIENT_TYPE: "auth/missing-client-type";
  MISSING_CODE: "auth/missing-verification-code";
  MISSING_CONTINUE_URI: "auth/missing-continue-uri";
  MISSING_IFRAME_START: "auth/missing-iframe-start";
  MISSING_IOS_BUNDLE_ID: "auth/missing-ios-bundle-id";
  MISSING_MFA_INFO: "auth/missing-multi-factor-info";
  MISSING_MFA_SESSION: "auth/missing-multi-factor-session";
  MISSING_OR_INVALID_NONCE: "auth/missing-or-invalid-nonce";
  MISSING_PASSWORD: "auth/missing-password";
  MISSING_PHONE_NUMBER: "auth/missing-phone-number";
  MISSING_RECAPTCHA_TOKEN: "auth/missing-recaptcha-token";
  MISSING_RECAPTCHA_VERSION: "auth/missing-recaptcha-version";
  MISSING_SESSION_INFO: "auth/missing-verification-id";
  MODULE_DESTROYED: "auth/app-deleted";
  NEED_CONFIRMATION: "auth/account-exists-with-different-credential";
  NETWORK_REQUEST_FAILED: "auth/network-request-failed";
  NO_AUTH_EVENT: "auth/no-auth-event";
  NO_SUCH_PROVIDER: "auth/no-such-provider";
  NULL_USER: "auth/null-user";
  OPERATION_NOT_ALLOWED: "auth/operation-not-allowed";
  OPERATION_NOT_SUPPORTED: "auth/operation-not-supported-in-this-environment";
  POPUP_BLOCKED: "auth/popup-blocked";
  POPUP_CLOSED_BY_USER: "auth/popup-closed-by-user";
  PROVIDER_ALREADY_LINKED: "auth/provider-already-linked";
  QUOTA_EXCEEDED: "auth/quota-exceeded";
  RECAPTCHA_NOT_ENABLED: "auth/recaptcha-not-enabled";
  REDIRECT_CANCELLED_BY_USER: "auth/redirect-cancelled-by-user";
  REDIRECT_OPERATION_PENDING: "auth/redirect-operation-pending";
  REJECTED_CREDENTIAL: "auth/rejected-credential";
  SECOND_FACTOR_ALREADY_ENROLLED: "auth/second-factor-already-in-use";
  SECOND_FACTOR_LIMIT_EXCEEDED: "auth/maximum-second-factor-count-exceeded";
  TENANT_ID_MISMATCH: "auth/tenant-id-mismatch";
  TIMEOUT: "auth/timeout";
  TOKEN_EXPIRED: "auth/user-token-expired";
  TOO_MANY_ATTEMPTS_TRY_LATER: "auth/too-many-requests";
  UNAUTHORIZED_DOMAIN: "auth/unauthorized-continue-uri";
  UNSUPPORTED_FIRST_FACTOR: "auth/unsupported-first-factor";
  UNSUPPORTED_PERSISTENCE: "auth/unsupported-persistence-type";
  UNSUPPORTED_TENANT_OPERATION: "auth/unsupported-tenant-operation";
  UNVERIFIED_EMAIL: "auth/unverified-email";
  USER_CANCELLED: "auth/user-cancelled";
  USER_DELETED: "auth/user-not-found";
  USER_DISABLED: "auth/user-disabled";
  USER_MISMATCH: "auth/user-mismatch";
  USER_SIGNED_OUT: "auth/user-signed-out";
  WEAK_PASSWORD: "auth/weak-password";
  WEB_STORAGE_UNSUPPORTED: "auth/web-storage-unsupported";
};
```

The full `auth/*` error-code map, captured verbatim from Firebase Auth
12.13.0. The oracle suite pins representative values and the total count.

#### Type Declaration

<a id="admin_only_operation"></a>

##### ADMIN\_ONLY\_OPERATION

```ts
readonly ADMIN_ONLY_OPERATION: "auth/admin-restricted-operation";
```

<a id="already_initialized"></a>

##### ALREADY\_INITIALIZED

```ts
readonly ALREADY_INITIALIZED: "auth/already-initialized";
```

<a id="app_not_authorized"></a>

##### APP\_NOT\_AUTHORIZED

```ts
readonly APP_NOT_AUTHORIZED: "auth/app-not-authorized";
```

<a id="app_not_installed"></a>

##### APP\_NOT\_INSTALLED

```ts
readonly APP_NOT_INSTALLED: "auth/app-not-installed";
```

<a id="argument_error"></a>

##### ARGUMENT\_ERROR

```ts
readonly ARGUMENT_ERROR: "auth/argument-error";
```

<a id="captcha_check_failed"></a>

##### CAPTCHA\_CHECK\_FAILED

```ts
readonly CAPTCHA_CHECK_FAILED: "auth/captcha-check-failed";
```

<a id="code_expired"></a>

##### CODE\_EXPIRED

```ts
readonly CODE_EXPIRED: "auth/code-expired";
```

<a id="cordova_not_ready"></a>

##### CORDOVA\_NOT\_READY

```ts
readonly CORDOVA_NOT_READY: "auth/cordova-not-ready";
```

<a id="cors_unsupported"></a>

##### CORS\_UNSUPPORTED

```ts
readonly CORS_UNSUPPORTED: "auth/cors-unsupported";
```

<a id="credential_already_in_use"></a>

##### CREDENTIAL\_ALREADY\_IN\_USE

```ts
readonly CREDENTIAL_ALREADY_IN_USE: "auth/credential-already-in-use";
```

<a id="credential_mismatch"></a>

##### CREDENTIAL\_MISMATCH

```ts
readonly CREDENTIAL_MISMATCH: "auth/custom-token-mismatch";
```

<a id="credential_too_old_login_again"></a>

##### CREDENTIAL\_TOO\_OLD\_LOGIN\_AGAIN

```ts
readonly CREDENTIAL_TOO_OLD_LOGIN_AGAIN: "auth/requires-recent-login";
```

<a id="dependent_sdk_init_before_auth"></a>

##### DEPENDENT\_SDK\_INIT\_BEFORE\_AUTH

```ts
readonly DEPENDENT_SDK_INIT_BEFORE_AUTH: "auth/dependent-sdk-initialized-before-auth";
```

<a id="dynamic_link_not_activated"></a>

##### DYNAMIC\_LINK\_NOT\_ACTIVATED

```ts
readonly DYNAMIC_LINK_NOT_ACTIVATED: "auth/dynamic-link-not-activated";
```

<a id="email_change_needs_verification"></a>

##### EMAIL\_CHANGE\_NEEDS\_VERIFICATION

```ts
readonly EMAIL_CHANGE_NEEDS_VERIFICATION: "auth/email-change-needs-verification";
```

<a id="email_exists"></a>

##### EMAIL\_EXISTS

```ts
readonly EMAIL_EXISTS: "auth/email-already-in-use";
```

<a id="emulator_config_failed"></a>

##### EMULATOR\_CONFIG\_FAILED

```ts
readonly EMULATOR_CONFIG_FAILED: "auth/emulator-config-failed";
```

<a id="expired_oob_code"></a>

##### EXPIRED\_OOB\_CODE

```ts
readonly EXPIRED_OOB_CODE: "auth/expired-action-code";
```

<a id="expired_popup_request"></a>

##### EXPIRED\_POPUP\_REQUEST

```ts
readonly EXPIRED_POPUP_REQUEST: "auth/cancelled-popup-request";
```

<a id="internal_error"></a>

##### INTERNAL\_ERROR

```ts
readonly INTERNAL_ERROR: "auth/internal-error";
```

<a id="invalid_api_key"></a>

##### INVALID\_API\_KEY

```ts
readonly INVALID_API_KEY: "auth/invalid-api-key";
```

<a id="invalid_app_credential"></a>

##### INVALID\_APP\_CREDENTIAL

```ts
readonly INVALID_APP_CREDENTIAL: "auth/invalid-app-credential";
```

<a id="invalid_app_id"></a>

##### INVALID\_APP\_ID

```ts
readonly INVALID_APP_ID: "auth/invalid-app-id";
```

<a id="invalid_auth"></a>

##### INVALID\_AUTH

```ts
readonly INVALID_AUTH: "auth/invalid-user-token";
```

<a id="invalid_auth_event"></a>

##### INVALID\_AUTH\_EVENT

```ts
readonly INVALID_AUTH_EVENT: "auth/invalid-auth-event";
```

<a id="invalid_cert_hash"></a>

##### INVALID\_CERT\_HASH

```ts
readonly INVALID_CERT_HASH: "auth/invalid-cert-hash";
```

<a id="invalid_code"></a>

##### INVALID\_CODE

```ts
readonly INVALID_CODE: "auth/invalid-verification-code";
```

<a id="invalid_continue_uri"></a>

##### INVALID\_CONTINUE\_URI

```ts
readonly INVALID_CONTINUE_URI: "auth/invalid-continue-uri";
```

<a id="invalid_cordova_configuration"></a>

##### INVALID\_CORDOVA\_CONFIGURATION

```ts
readonly INVALID_CORDOVA_CONFIGURATION: "auth/invalid-cordova-configuration";
```

<a id="invalid_custom_token"></a>

##### INVALID\_CUSTOM\_TOKEN

```ts
readonly INVALID_CUSTOM_TOKEN: "auth/invalid-custom-token";
```

<a id="invalid_dynamic_link_domain"></a>

##### INVALID\_DYNAMIC\_LINK\_DOMAIN

```ts
readonly INVALID_DYNAMIC_LINK_DOMAIN: "auth/invalid-dynamic-link-domain";
```

<a id="invalid_email"></a>

##### INVALID\_EMAIL

```ts
readonly INVALID_EMAIL: "auth/invalid-email";
```

<a id="invalid_emulator_scheme"></a>

##### INVALID\_EMULATOR\_SCHEME

```ts
readonly INVALID_EMULATOR_SCHEME: "auth/invalid-emulator-scheme";
```

<a id="invalid_hosting_link_domain"></a>

##### INVALID\_HOSTING\_LINK\_DOMAIN

```ts
readonly INVALID_HOSTING_LINK_DOMAIN: "auth/invalid-hosting-link-domain";
```

<a id="invalid_idp_response"></a>

##### INVALID\_IDP\_RESPONSE

```ts
readonly INVALID_IDP_RESPONSE: "auth/invalid-credential";
```

<a id="invalid_login_credentials"></a>

##### INVALID\_LOGIN\_CREDENTIALS

```ts
readonly INVALID_LOGIN_CREDENTIALS: "auth/invalid-credential";
```

<a id="invalid_message_payload"></a>

##### INVALID\_MESSAGE\_PAYLOAD

```ts
readonly INVALID_MESSAGE_PAYLOAD: "auth/invalid-message-payload";
```

<a id="invalid_mfa_session"></a>

##### INVALID\_MFA\_SESSION

```ts
readonly INVALID_MFA_SESSION: "auth/invalid-multi-factor-session";
```

<a id="invalid_oauth_client_id"></a>

##### INVALID\_OAUTH\_CLIENT\_ID

```ts
readonly INVALID_OAUTH_CLIENT_ID: "auth/invalid-oauth-client-id";
```

<a id="invalid_oauth_provider"></a>

##### INVALID\_OAUTH\_PROVIDER

```ts
readonly INVALID_OAUTH_PROVIDER: "auth/invalid-oauth-provider";
```

<a id="invalid_oob_code"></a>

##### INVALID\_OOB\_CODE

```ts
readonly INVALID_OOB_CODE: "auth/invalid-action-code";
```

<a id="invalid_origin"></a>

##### INVALID\_ORIGIN

```ts
readonly INVALID_ORIGIN: "auth/unauthorized-domain";
```

<a id="invalid_password"></a>

##### INVALID\_PASSWORD

```ts
readonly INVALID_PASSWORD: "auth/wrong-password";
```

<a id="invalid_persistence"></a>

##### INVALID\_PERSISTENCE

```ts
readonly INVALID_PERSISTENCE: "auth/invalid-persistence-type";
```

<a id="invalid_phone_number"></a>

##### INVALID\_PHONE\_NUMBER

```ts
readonly INVALID_PHONE_NUMBER: "auth/invalid-phone-number";
```

<a id="invalid_provider_id"></a>

##### INVALID\_PROVIDER\_ID

```ts
readonly INVALID_PROVIDER_ID: "auth/invalid-provider-id";
```

<a id="invalid_recaptcha_action"></a>

##### INVALID\_RECAPTCHA\_ACTION

```ts
readonly INVALID_RECAPTCHA_ACTION: "auth/invalid-recaptcha-action";
```

<a id="invalid_recaptcha_token"></a>

##### INVALID\_RECAPTCHA\_TOKEN

```ts
readonly INVALID_RECAPTCHA_TOKEN: "auth/invalid-recaptcha-token";
```

<a id="invalid_recaptcha_version"></a>

##### INVALID\_RECAPTCHA\_VERSION

```ts
readonly INVALID_RECAPTCHA_VERSION: "auth/invalid-recaptcha-version";
```

<a id="invalid_recipient_email"></a>

##### INVALID\_RECIPIENT\_EMAIL

```ts
readonly INVALID_RECIPIENT_EMAIL: "auth/invalid-recipient-email";
```

<a id="invalid_req_type"></a>

##### INVALID\_REQ\_TYPE

```ts
readonly INVALID_REQ_TYPE: "auth/invalid-req-type";
```

<a id="invalid_sender"></a>

##### INVALID\_SENDER

```ts
readonly INVALID_SENDER: "auth/invalid-sender";
```

<a id="invalid_session_info"></a>

##### INVALID\_SESSION\_INFO

```ts
readonly INVALID_SESSION_INFO: "auth/invalid-verification-id";
```

<a id="invalid_tenant_id"></a>

##### INVALID\_TENANT\_ID

```ts
readonly INVALID_TENANT_ID: "auth/invalid-tenant-id";
```

<a id="mfa_info_not_found"></a>

##### MFA\_INFO\_NOT\_FOUND

```ts
readonly MFA_INFO_NOT_FOUND: "auth/multi-factor-info-not-found";
```

<a id="mfa_required"></a>

##### MFA\_REQUIRED

```ts
readonly MFA_REQUIRED: "auth/multi-factor-auth-required";
```

<a id="missing_android_package_name"></a>

##### MISSING\_ANDROID\_PACKAGE\_NAME

```ts
readonly MISSING_ANDROID_PACKAGE_NAME: "auth/missing-android-pkg-name";
```

<a id="missing_app_credential"></a>

##### MISSING\_APP\_CREDENTIAL

```ts
readonly MISSING_APP_CREDENTIAL: "auth/missing-app-credential";
```

<a id="missing_auth_domain"></a>

##### MISSING\_AUTH\_DOMAIN

```ts
readonly MISSING_AUTH_DOMAIN: "auth/auth-domain-config-required";
```

<a id="missing_client_type"></a>

##### MISSING\_CLIENT\_TYPE

```ts
readonly MISSING_CLIENT_TYPE: "auth/missing-client-type";
```

<a id="missing_code"></a>

##### MISSING\_CODE

```ts
readonly MISSING_CODE: "auth/missing-verification-code";
```

<a id="missing_continue_uri"></a>

##### MISSING\_CONTINUE\_URI

```ts
readonly MISSING_CONTINUE_URI: "auth/missing-continue-uri";
```

<a id="missing_iframe_start"></a>

##### MISSING\_IFRAME\_START

```ts
readonly MISSING_IFRAME_START: "auth/missing-iframe-start";
```

<a id="missing_ios_bundle_id"></a>

##### MISSING\_IOS\_BUNDLE\_ID

```ts
readonly MISSING_IOS_BUNDLE_ID: "auth/missing-ios-bundle-id";
```

<a id="missing_mfa_info"></a>

##### MISSING\_MFA\_INFO

```ts
readonly MISSING_MFA_INFO: "auth/missing-multi-factor-info";
```

<a id="missing_mfa_session"></a>

##### MISSING\_MFA\_SESSION

```ts
readonly MISSING_MFA_SESSION: "auth/missing-multi-factor-session";
```

<a id="missing_or_invalid_nonce"></a>

##### MISSING\_OR\_INVALID\_NONCE

```ts
readonly MISSING_OR_INVALID_NONCE: "auth/missing-or-invalid-nonce";
```

<a id="missing_password"></a>

##### MISSING\_PASSWORD

```ts
readonly MISSING_PASSWORD: "auth/missing-password";
```

<a id="missing_phone_number"></a>

##### MISSING\_PHONE\_NUMBER

```ts
readonly MISSING_PHONE_NUMBER: "auth/missing-phone-number";
```

<a id="missing_recaptcha_token"></a>

##### MISSING\_RECAPTCHA\_TOKEN

```ts
readonly MISSING_RECAPTCHA_TOKEN: "auth/missing-recaptcha-token";
```

<a id="missing_recaptcha_version"></a>

##### MISSING\_RECAPTCHA\_VERSION

```ts
readonly MISSING_RECAPTCHA_VERSION: "auth/missing-recaptcha-version";
```

<a id="missing_session_info"></a>

##### MISSING\_SESSION\_INFO

```ts
readonly MISSING_SESSION_INFO: "auth/missing-verification-id";
```

<a id="module_destroyed"></a>

##### MODULE\_DESTROYED

```ts
readonly MODULE_DESTROYED: "auth/app-deleted";
```

<a id="need_confirmation"></a>

##### NEED\_CONFIRMATION

```ts
readonly NEED_CONFIRMATION: "auth/account-exists-with-different-credential";
```

<a id="network_request_failed"></a>

##### NETWORK\_REQUEST\_FAILED

```ts
readonly NETWORK_REQUEST_FAILED: "auth/network-request-failed";
```

<a id="no_auth_event"></a>

##### NO\_AUTH\_EVENT

```ts
readonly NO_AUTH_EVENT: "auth/no-auth-event";
```

<a id="no_such_provider"></a>

##### NO\_SUCH\_PROVIDER

```ts
readonly NO_SUCH_PROVIDER: "auth/no-such-provider";
```

<a id="null_user"></a>

##### NULL\_USER

```ts
readonly NULL_USER: "auth/null-user";
```

<a id="operation_not_allowed"></a>

##### OPERATION\_NOT\_ALLOWED

```ts
readonly OPERATION_NOT_ALLOWED: "auth/operation-not-allowed";
```

<a id="operation_not_supported"></a>

##### OPERATION\_NOT\_SUPPORTED

```ts
readonly OPERATION_NOT_SUPPORTED: "auth/operation-not-supported-in-this-environment";
```

<a id="popup_blocked"></a>

##### POPUP\_BLOCKED

```ts
readonly POPUP_BLOCKED: "auth/popup-blocked";
```

<a id="popup_closed_by_user"></a>

##### POPUP\_CLOSED\_BY\_USER

```ts
readonly POPUP_CLOSED_BY_USER: "auth/popup-closed-by-user";
```

<a id="provider_already_linked"></a>

##### PROVIDER\_ALREADY\_LINKED

```ts
readonly PROVIDER_ALREADY_LINKED: "auth/provider-already-linked";
```

<a id="quota_exceeded"></a>

##### QUOTA\_EXCEEDED

```ts
readonly QUOTA_EXCEEDED: "auth/quota-exceeded";
```

<a id="recaptcha_not_enabled"></a>

##### RECAPTCHA\_NOT\_ENABLED

```ts
readonly RECAPTCHA_NOT_ENABLED: "auth/recaptcha-not-enabled";
```

<a id="redirect_cancelled_by_user"></a>

##### REDIRECT\_CANCELLED\_BY\_USER

```ts
readonly REDIRECT_CANCELLED_BY_USER: "auth/redirect-cancelled-by-user";
```

<a id="redirect_operation_pending"></a>

##### REDIRECT\_OPERATION\_PENDING

```ts
readonly REDIRECT_OPERATION_PENDING: "auth/redirect-operation-pending";
```

<a id="rejected_credential"></a>

##### REJECTED\_CREDENTIAL

```ts
readonly REJECTED_CREDENTIAL: "auth/rejected-credential";
```

<a id="second_factor_already_enrolled"></a>

##### SECOND\_FACTOR\_ALREADY\_ENROLLED

```ts
readonly SECOND_FACTOR_ALREADY_ENROLLED: "auth/second-factor-already-in-use";
```

<a id="second_factor_limit_exceeded"></a>

##### SECOND\_FACTOR\_LIMIT\_EXCEEDED

```ts
readonly SECOND_FACTOR_LIMIT_EXCEEDED: "auth/maximum-second-factor-count-exceeded";
```

<a id="tenant_id_mismatch"></a>

##### TENANT\_ID\_MISMATCH

```ts
readonly TENANT_ID_MISMATCH: "auth/tenant-id-mismatch";
```

<a id="timeout"></a>

##### TIMEOUT

```ts
readonly TIMEOUT: "auth/timeout";
```

<a id="token_expired"></a>

##### TOKEN\_EXPIRED

```ts
readonly TOKEN_EXPIRED: "auth/user-token-expired";
```

<a id="too_many_attempts_try_later"></a>

##### TOO\_MANY\_ATTEMPTS\_TRY\_LATER

```ts
readonly TOO_MANY_ATTEMPTS_TRY_LATER: "auth/too-many-requests";
```

<a id="unauthorized_domain"></a>

##### UNAUTHORIZED\_DOMAIN

```ts
readonly UNAUTHORIZED_DOMAIN: "auth/unauthorized-continue-uri";
```

<a id="unsupported_first_factor"></a>

##### UNSUPPORTED\_FIRST\_FACTOR

```ts
readonly UNSUPPORTED_FIRST_FACTOR: "auth/unsupported-first-factor";
```

<a id="unsupported_persistence"></a>

##### UNSUPPORTED\_PERSISTENCE

```ts
readonly UNSUPPORTED_PERSISTENCE: "auth/unsupported-persistence-type";
```

<a id="unsupported_tenant_operation"></a>

##### UNSUPPORTED\_TENANT\_OPERATION

```ts
readonly UNSUPPORTED_TENANT_OPERATION: "auth/unsupported-tenant-operation";
```

<a id="unverified_email"></a>

##### UNVERIFIED\_EMAIL

```ts
readonly UNVERIFIED_EMAIL: "auth/unverified-email";
```

<a id="user_cancelled"></a>

##### USER\_CANCELLED

```ts
readonly USER_CANCELLED: "auth/user-cancelled";
```

<a id="user_deleted"></a>

##### USER\_DELETED

```ts
readonly USER_DELETED: "auth/user-not-found";
```

<a id="user_disabled"></a>

##### USER\_DISABLED

```ts
readonly USER_DISABLED: "auth/user-disabled";
```

<a id="user_mismatch"></a>

##### USER\_MISMATCH

```ts
readonly USER_MISMATCH: "auth/user-mismatch";
```

<a id="user_signed_out"></a>

##### USER\_SIGNED\_OUT

```ts
readonly USER_SIGNED_OUT: "auth/user-signed-out";
```

<a id="weak_password"></a>

##### WEAK\_PASSWORD

```ts
readonly WEAK_PASSWORD: "auth/weak-password";
```

<a id="web_storage_unsupported"></a>

##### WEB\_STORAGE\_UNSUPPORTED

```ts
readonly WEB_STORAGE_UNSUPPORTED: "auth/web-storage-unsupported";
```

***

<a id="browsercookiepersistence"></a>

### browserCookiePersistence

```ts
const browserCookiePersistence: Persistence;
```

Cookie-backed, for SSR. The fourth member of upstream's
 `Persistence.type` union.

***

<a id="browserlocalpersistence"></a>

### browserLocalPersistence

```ts
const browserLocalPersistence: Persistence;
```

`localStorage`-backed. Firebase's default.

***

<a id="browserpopupredirectresolver"></a>

### browserPopupRedirectResolver

```ts
const browserPopupRedirectResolver: {
};
```

`browserPopupRedirectResolver` — upstream's default resolver, the thing
a browser `getAuth()` wires in so `signInWithPopup` can open a window.

The sandbox has no window to open, and it already has a FIRST-CLASS,
pluggable equivalent: [AuthFlowResolver](#authflowresolver), installed via
`sandbox.setAuthFlowResolver`. So this export exists to satisfy the
idiomatic `initializeAuth(app, { popupRedirectResolver:
browserPopupRedirectResolver })` without changing anything: passing it
is accepted and ignored, and popup/redirect sign-in resolves through
the sandbox's own resolver seam instead.

Branded rather than left as a bare `{}` so a host can recognize it.

***

<a id="browsersessionpersistence"></a>

### browserSessionPersistence

```ts
const browserSessionPersistence: Persistence;
```

`sessionStorage`-backed.

***

<a id="debugerrormap"></a>

### debugErrorMap

```ts
const debugErrorMap: AuthErrorMap;
```

`debugErrorMap` — upstream's verbose map: full human-readable messages
on every auth error, at the cost of bundle size.

The sandbox ALWAYS throws with a full message (see `auth-errors.ts`:
every `makeAuthError` call site passes real prose), so the debug map is
effectively already in force and installing it changes nothing. Exported
as an accepted no-op token.

***

<a id="federated_provider_ids"></a>

### FEDERATED\_PROVIDER\_IDS

```ts
const FEDERATED_PROVIDER_IDS: readonly ["google.com", "apple.com", "facebook.com", "github.com", "twitter.com", "microsoft.com", "yahoo.com"];
```

The canonical federated (OAuth) provider ids the sandbox supports as
FIRST-CLASS: the dedicated provider classes' `PROVIDER_ID`s
([GoogleAuthProvider](#googleauthprovider) / [FacebookAuthProvider](#facebookauthprovider) /
[GithubAuthProvider](#githubauthprovider)) plus the standard Firebase IdP set reached
through the generic [OAuthProvider](#oauthprovider) (Apple, Twitter, Microsoft,
Yahoo — the same federated ids the emulator console recognizes).

NOT an allowlist: the backend accepts ANY provider id (custom
`OAuthProvider('oidc.acme')` etc. work end-to-end). This constant exists
so admin surfaces (Studio's user editor, provider toggles) can enumerate
the supported set mechanically instead of hardcoding copies. `password`
/ `anonymous` / `phone` are deliberately absent — they're credential-
derived sign-in methods, not federated links.

***

<a id="indexeddblocalpersistence"></a>

### indexedDBLocalPersistence

```ts
const indexedDBLocalPersistence: Persistence;
```

IndexedDB-backed. Long-term, same observable class as
 `browserLocalPersistence` — hence the shared `'LOCAL'` type.

***

<a id="inmemorypersistence"></a>

### inMemoryPersistence

```ts
const inMemoryPersistence: Persistence;
```

No persistence — session dies with the tab.

***

<a id="operationtype-2"></a>

### OperationType

```ts
const OperationType: {
  LINK: "link";
  REAUTHENTICATE: "reauthenticate";
  SIGN_IN: "signIn";
};
```

What produced a `UserCredential`. Mirrors `firebase/auth`'s
`OperationType` — the discriminant `signInWith*` / `linkWith*` /
`reauthenticateWith*` set on their results.

`SIGN_IN` is `'signIn'`, NOT `'register'`: a fresh
`createUserWithEmailAndPassword` also reports `'signIn'`. Oracle:
`observations/auth/auth-createUser-operationType.json`.

#### Type Declaration

<a id="link-1"></a>

##### LINK

```ts
readonly LINK: "link";
```

<a id="reauthenticate"></a>

##### REAUTHENTICATE

```ts
readonly REAUTHENTICATE: "reauthenticate";
```

<a id="sign_in"></a>

##### SIGN\_IN

```ts
readonly SIGN_IN: "signIn";
```

***

<a id="proderrormap"></a>

### prodErrorMap

```ts
const prodErrorMap: AuthErrorMap;
```

`prodErrorMap` — upstream's minified map: error codes without the
message text, to save bytes in production builds.

NOT honored, deliberately. Installing it upstream STRIPS the messages;
doing that in a sandbox whose entire purpose is to tell a developer what
went wrong would be actively hostile. Accepted and ignored — the sandbox
keeps throwing full messages.

***

<a id="providerid-18"></a>

### ProviderId

```ts
const ProviderId: {
  FACEBOOK: "facebook.com";
  GITHUB: "github.com";
  GOOGLE: "google.com";
  PASSWORD: "password";
  PHONE: "phone";
  TWITTER: "twitter.com";
};
```

Aggregate provider ids. Mirrors `firebase/auth`'s `ProviderId`.

Note the shape upstream chose: the anonymous and custom-token sign-in
paths have NO entry here (they are not federated identity providers),
which is why [UserCredential.providerId](#providerid-15) is `null` for both.

#### Type Declaration

<a id="facebook"></a>

##### FACEBOOK

```ts
readonly FACEBOOK: "facebook.com";
```

<a id="github"></a>

##### GITHUB

```ts
readonly GITHUB: "github.com";
```

<a id="google"></a>

##### GOOGLE

```ts
readonly GOOGLE: "google.com";
```

<a id="password-4"></a>

##### PASSWORD

```ts
readonly PASSWORD: "password";
```

<a id="phone"></a>

##### PHONE

```ts
readonly PHONE: "phone";
```

<a id="twitter"></a>

##### TWITTER

```ts
readonly TWITTER: "twitter.com";
```

***

<a id="sandbox"></a>

### sandbox

```ts
const sandbox: {
  assertAuthProviderEnabled: void;
  clearUsers: void;
  createSignInCredential: UserCredential;
  createUser: AuthUserRecord;
  delegateProviderEnforcement: void;
  deleteUser: void;
  exportUsers: SeedUser[];
  getAuthProviderConfig: {
     enabled: boolean;
     providerId: string;
  }[];
  listAuthMail: OutboundAuthMail[];
  listIdentities: {
     customClaims: Record<string, unknown>;
     displayName: string | null;
     email: string | null;
     isAnonymous: boolean;
     providerId: string;
     providerUserInfo: ProviderUserInfo[];
     uid: string;
  }[];
  listUsers: AuthUserRecord[];
  mintSession: MintedSession;
  mockActionCode: void;
  mockSignInResult: void;
  restoreSession: User;
  seedUsers: void;
  setAuthFlowResolver: void;
  setAuthMailResolver: void;
  setAuthProviderConfig: void;
  setUser: void;
  subscribeAuthProviderConfig: Unsubscribe;
  subscribeUsers: Unsubscribe;
  takeAuthMail: OutboundAuthMail;
  updateProfile: AuthUserRecord;
  updateUser: AuthUserRecord;
};
```

#### Type Declaration

<a id="assertauthproviderenabled"></a>

##### assertAuthProviderEnabled()

```ts
assertAuthProviderEnabled(auth: Auth, providerId: string): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `providerId` | `string` |

###### Returns

`void`

<a id="clearusers"></a>

##### clearUsers()

```ts
clearUsers(auth: Auth): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

###### Returns

`void`

<a id="createsignincredential"></a>

##### createSignInCredential()

```ts
createSignInCredential(auth: Auth, request:
  | {
  providerId: string;
  uid: string;
}
  | {
  providerId: string;
  spec: SignInIdentitySpec;
}): UserCredential;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `request` | \| \{ `providerId`: `string`; `uid`: `string`; \} \| \{ `providerId`: `string`; `spec`: [`SignInIdentitySpec`](#signinidentityspec); \} |

###### Returns

[`UserCredential`](#usercredential)

<a id="createuser"></a>

##### createUser()

```ts
createUser(auth: Auth, request: CreateUserRequest): AuthUserRecord;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `request` | [`CreateUserRequest`](#createuserrequest) |

###### Returns

[`AuthUserRecord`](#authuserrecord)

<a id="delegateproviderenforcement"></a>

##### delegateProviderEnforcement()

```ts
delegateProviderEnforcement(auth: Auth, delegated: boolean): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `delegated` | `boolean` |

###### Returns

`void`

<a id="deleteuser"></a>

##### deleteUser()

```ts
deleteUser(auth: Auth, uid: string): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `uid` | `string` |

###### Returns

`void`

<a id="exportusers"></a>

##### exportUsers()

```ts
exportUsers(auth: Auth): SeedUser[];
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

###### Returns

[`SeedUser`](#seeduser)[]

<a id="getauthproviderconfig"></a>

##### getAuthProviderConfig()

```ts
getAuthProviderConfig(auth: Auth): {
  enabled: boolean;
  providerId: string;
}[];
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

###### Returns

\{
  `enabled`: `boolean`;
  `providerId`: `string`;
\}[]

<a id="listauthmail"></a>

##### listAuthMail()

```ts
listAuthMail(auth: Auth): OutboundAuthMail[];
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

###### Returns

[`OutboundAuthMail`](#outboundauthmail)[]

<a id="listidentities"></a>

##### listIdentities()

```ts
listIdentities(auth: Auth): {
  customClaims: Record<string, unknown>;
  displayName: string | null;
  email: string | null;
  isAnonymous: boolean;
  providerId: string;
  providerUserInfo: ProviderUserInfo[];
  uid: string;
}[];
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

###### Returns

\{
  `customClaims`: `Record`\<`string`, `unknown`\>;
  `displayName`: `string` \| `null`;
  `email`: `string` \| `null`;
  `isAnonymous`: `boolean`;
  `providerId`: `string`;
  `providerUserInfo`: [`ProviderUserInfo`](#provideruserinfo-2)[];
  `uid`: `string`;
\}[]

<a id="listusers"></a>

##### listUsers()

```ts
listUsers(auth: Auth): AuthUserRecord[];
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

###### Returns

[`AuthUserRecord`](#authuserrecord)[]

<a id="mintsession"></a>

##### mintSession()

```ts
mintSession(auth: Auth, request: MintSessionRequest): MintedSession;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `request` | [`MintSessionRequest`](#mintsessionrequest) |

###### Returns

[`MintedSession`](#mintedsession)

<a id="mockactioncode"></a>

##### mockActionCode()

```ts
mockActionCode(
   auth: Auth,
   code: string,
   spec: AuthActionCode): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `code` | `string` |
| `spec` | `AuthActionCode` |

###### Returns

`void`

<a id="mocksigninresult"></a>

##### mockSignInResult()

```ts
mockSignInResult(auth: Auth, result: UserCredential): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `result` | [`UserCredential`](#usercredential) |

###### Returns

`void`

<a id="restoresession"></a>

##### restoreSession()

```ts
restoreSession(auth: Auth, uid: string): User;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `uid` | `string` |

###### Returns

[`User`](#user-1)

<a id="seedusers"></a>

##### seedUsers()

```ts
seedUsers(auth: Auth, users: readonly SeedUser[]): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `users` | readonly [`SeedUser`](#seeduser)[] |

###### Returns

`void`

<a id="setauthflowresolver"></a>

##### setAuthFlowResolver()

```ts
setAuthFlowResolver(auth: Auth, resolver: AuthFlowResolver): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `resolver` | [`AuthFlowResolver`](#authflowresolver) |

###### Returns

`void`

<a id="setauthmailresolver"></a>

##### setAuthMailResolver()

```ts
setAuthMailResolver(auth: Auth, resolver: AuthMailResolver): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `resolver` | [`AuthMailResolver`](#authmailresolver) |

###### Returns

`void`

<a id="setauthproviderconfig"></a>

##### setAuthProviderConfig()

```ts
setAuthProviderConfig(
   auth: Auth,
   providerId: string,
   enabled: boolean): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `providerId` | `string` |
| `enabled` | `boolean` |

###### Returns

`void`

<a id="setuser"></a>

##### setUser()

```ts
setUser(auth: Auth, user: User): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `user` | [`User`](#user-1) |

###### Returns

`void`

<a id="subscribeauthproviderconfig"></a>

##### subscribeAuthProviderConfig()

```ts
subscribeAuthProviderConfig(auth: Auth, callback: () => void): Unsubscribe;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `callback` | () => `void` |

###### Returns

[`Unsubscribe`](#unsubscribe)

<a id="subscribeusers"></a>

##### subscribeUsers()

```ts
subscribeUsers(auth: Auth, callback: () => void): Unsubscribe;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `callback` | () => `void` |

###### Returns

[`Unsubscribe`](#unsubscribe)

<a id="takeauthmail"></a>

##### takeAuthMail()

```ts
takeAuthMail(auth: Auth, email?: string): OutboundAuthMail;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `email?` | `string` |

###### Returns

[`OutboundAuthMail`](#outboundauthmail)

<a id="updateprofile"></a>

##### updateProfile()

```ts
updateProfile(
   auth: Auth,
   uid: string,
   profile: {
  displayName?: string | null;
  photoURL?: string | null;
}): AuthUserRecord;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `uid` | `string` |
| `profile` | \{ `displayName?`: `string` \| `null`; `photoURL?`: `string` \| `null`; \} |
| `profile.displayName?` | `string` \| `null` |
| `profile.photoURL?` | `string` \| `null` |

###### Returns

[`AuthUserRecord`](#authuserrecord)

<a id="updateuser"></a>

##### updateUser()

```ts
updateUser(
   auth: Auth,
   uid: string,
   update: UpdateUserRequest): AuthUserRecord;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `uid` | `string` |
| `update` | [`UpdateUserRequest`](#updateuserrequest) |

###### Returns

[`AuthUserRecord`](#authuserrecord)

***

<a id="signinmethod-4"></a>

### SignInMethod

```ts
const SignInMethod: {
  EMAIL_LINK: "emailLink";
  EMAIL_PASSWORD: "password";
  FACEBOOK: "facebook.com";
  GITHUB: "github.com";
  GOOGLE: "google.com";
  PHONE: "phone";
  TWITTER: "twitter.com";
};
```

Sign-in method ids. Mirrors `firebase/auth`'s `SignInMethod`.

Distinct from [ProviderId](#providerid-18) precisely because one provider can
carry several methods: `EmailAuthProvider` (`'password'`) signs in
with EITHER `EMAIL_PASSWORD` (`'password'`) or `EMAIL_LINK`
(`'emailLink'`). That split is what `AuthCredential.signInMethod`
discriminates, and it is what the email-link family turns on.

#### Type Declaration

<a id="email_link"></a>

##### EMAIL\_LINK

```ts
readonly EMAIL_LINK: "emailLink";
```

<a id="email_password"></a>

##### EMAIL\_PASSWORD

```ts
readonly EMAIL_PASSWORD: "password";
```

<a id="facebook-1"></a>

##### FACEBOOK

```ts
readonly FACEBOOK: "facebook.com";
```

<a id="github-1"></a>

##### GITHUB

```ts
readonly GITHUB: "github.com";
```

<a id="google-1"></a>

##### GOOGLE

```ts
readonly GOOGLE: "google.com";
```

<a id="phone-1"></a>

##### PHONE

```ts
readonly PHONE: "phone";
```

<a id="twitter-1"></a>

##### TWITTER

```ts
readonly TWITTER: "twitter.com";
```

***

<a id="target_symbol-1"></a>

### TARGET\_SYMBOL

```ts
const TARGET_SYMBOL: unique symbol;
```

Branded handle for [Auth](#auth). Set on every handle returned by
 [getAuth](#getauth); consumers don't read it. Exposed only so the
 dispatch helpers in this package can recover routing without a
 WeakMap lookup.

## Functions

<a id="applyactioncode"></a>

### applyActionCode()

```ts
function applyActionCode(auth: Auth, code: string): Promise<void>;
```

`applyActionCode(auth, code)` — mirror of `firebase/auth`. Redeems a
code and performs its state change.

`auth/invalid-action-code` for a code the sandbox never issued —
ORACLE-BACKED (`auth-action-code-invalid` captured exactly this
against prod, for both a bogus code and the empty string).
`auth/expired-action-code` for a code staged as expired.

Single-use: the code is burned on redemption, so a replay throws
`auth/invalid-action-code` — matching prod.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `code` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="beforeauthstatechanged"></a>

### beforeAuthStateChanged()

```ts
function beforeAuthStateChanged(
   auth: Auth,
   callback: (user: User) => void | Promise<void>,
   onAbort?: () => void): Unsubscribe;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `callback` | (`user`: [`User`](#user-1)) => `void` \| `Promise`\<`void`\> |
| `onAbort?` | () => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="checkactioncode"></a>

### checkActionCode()

```ts
function checkActionCode(auth: Auth, code: string): Promise<ActionCodeInfo>;
```

`checkActionCode(auth, code)` — mirror of `firebase/auth`. Inspects a
code WITHOUT redeeming it, so the subsequent `applyActionCode` /
`confirmPasswordReset` still finds it. Throws
`auth/invalid-action-code` / `auth/expired-action-code` for a code
that is not live.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `code` | `string` |

#### Returns

`Promise`\<[`ActionCodeInfo`](#actioncodeinfo)\>

***

<a id="confirmpasswordreset"></a>

### confirmPasswordReset()

```ts
function confirmPasswordReset(
   auth: Auth,
   code: string,
newPassword: string): Promise<void>;
```

`confirmPasswordReset(auth, code, newPassword)` — mirror of
`firebase/auth`. Redeems a reset code and sets the new password.

Real behavior on the sandbox: afterwards
`signInWithEmailAndPassword(auth, email, newPassword)` succeeds and
the OLD password throws `auth/wrong-password`. The new password runs
the same strength check `createUserWithEmailAndPassword` does, so a
reset cannot install a password the create path would have rejected
(`auth/weak-password`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `code` | `string` |
| `newPassword` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="connectauthemulator"></a>

### connectAuthEmulator()

```ts
function connectAuthEmulator(
   auth: Auth,
   url: string,
   options?: {
  disableWarnings?: boolean;
}): void;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `url` | `string` |
| `options?` | \{ `disableWarnings?`: `boolean`; \} |
| `options.disableWarnings?` | `boolean` |

#### Returns

`void`

***

<a id="createuserwithemailandpassword"></a>

### createUserWithEmailAndPassword()

```ts
function createUserWithEmailAndPassword(
   auth: Auth,
   email: string,
password: string): Promise<UserCredential>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `email` | `string` |
| `password` | `string` |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="deleteuser-2"></a>

### deleteUser()

```ts
function deleteUser(user: User): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |

#### Returns

`Promise`\<`void`\>

***

<a id="getadditionaluserinfo"></a>

### getAdditionalUserInfo()

```ts
function getAdditionalUserInfo(userCredential: UserCredential): AdditionalUserInfo;
```

`getAdditionalUserInfo(userCredential)` — mirror of `firebase/auth`.

Reads the info the sandbox recorded on the credential when it minted
it. `isNewUser` is true only when the credential came from a flow that
CREATED the identity (`createUserWithEmailAndPassword`,
`signInAnonymously`, a first-time email-link sign-in, a link that
upgraded an anonymous account).

Oracle (`observations/auth/auth-additional-user-info-shape.json`):
against prod an anonymous sign-in yields
`{ isNewUser: true, providerId: null, profile: {} }` — note
`providerId: null`, not `'anonymous'`, because anonymous is not a
federated provider.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `userCredential` | [`UserCredential`](#usercredential) |

#### Returns

[`AdditionalUserInfo`](#additionaluserinfo)

***

<a id="getauth"></a>

### getAuth()

#### Call Signature

```ts
function getAuth(): AppAuth;
```

##### Returns

[`AppAuth`](#appauth)

#### Call Signature

```ts
function getAuth(sandbox: Sandbox): Auth;
```

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `Sandbox` |

##### Returns

[`Auth`](#auth)

#### Call Signature

```ts
function getAuth(app: FirebaseApp): AppAuth;
```

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | `FirebaseApp` |

##### Returns

[`AppAuth`](#appauth)

#### Call Signature

```ts
function getAuth(target?: any): Auth;
```

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `target?` | `any` |

##### Returns

[`Auth`](#auth)

***

<a id="getidtoken-2"></a>

### getIdToken()

```ts
function getIdToken(user: User, forceRefresh?: boolean): Promise<string>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `forceRefresh?` | `boolean` |

#### Returns

`Promise`\<`string`\>

***

<a id="getidtokenresult-2"></a>

### getIdTokenResult()

```ts
function getIdTokenResult(user: User, forceRefresh?: boolean): Promise<IdTokenResult>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `forceRefresh?` | `boolean` |

#### Returns

`Promise`\<[`IdTokenResult`](#idtokenresult)\>

***

<a id="getredirectresult"></a>

### getRedirectResult()

```ts
function getRedirectResult(auth: Auth, _resolver?: AuthFlowResolver): Promise<UserCredential>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `_resolver?` | [`AuthFlowResolver`](#authflowresolver) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="initializeauth"></a>

### initializeAuth()

#### Call Signature

```ts
function initializeAuth(app: FirebaseApp, deps?: unknown): AppAuth;
```

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | `FirebaseApp` |
| `deps?` | `unknown` |

##### Returns

[`AppAuth`](#appauth)

#### Call Signature

```ts
function initializeAuth(app: Sandbox, deps?: unknown): Auth;
```

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | `Sandbox` |
| `deps?` | `unknown` |

##### Returns

[`Auth`](#auth)

***

<a id="issigninwithemaillink"></a>

### isSignInWithEmailLink()

```ts
function isSignInWithEmailLink(auth: Auth, link: string): boolean;
```

`isSignInWithEmailLink(auth, link)` — mirror of `firebase/auth`.

A pure predicate over the string: no network, no project, no state.
True iff the link parses AND its operation is `EMAIL_SIGNIN`. Never
throws — garbage in, `false` out. Oracle-pinned on all five cases the
capture covers.

`auth` is unused (upstream takes it for signature symmetry and tenant
plumbing, neither of which changes the answer) but is kept in the
signature so consumer code is identical across the two SDKs.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `link` | `string` |

#### Returns

`boolean`

***

<a id="linkwithcredential"></a>

### linkWithCredential()

```ts
function linkWithCredential(user: User, credential: AuthCredential): Promise<UserCredential>;
```

`linkWithCredential(user, credential)` — mirror of `firebase/auth`.

The anonymous upgrade is the flow this exists for: a user who has been
writing data as `anonymous-1` links an email credential and keeps the
SAME uid, so everything they created is still theirs. `isAnonymous`
flips to false; `providerData` gains the provider.

Rejects with:
  - `auth/provider-already-linked` — the account already carries this
    provider (one identity per provider, always).
  - `auth/email-already-in-use` — the email credential belongs to a
    different account. An address can back only one identity, so the
    link cannot be granted without stealing it.

Returns a `UserCredential` with `operationType: 'link'`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `credential` | [`AuthCredential`](#authcredential) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="linkwithpopup"></a>

### linkWithPopup()

```ts
function linkWithPopup(
   user: User,
   provider: AuthProvider,
resolver?: AuthFlowResolver): Promise<UserCredential>;
```

`linkWithPopup(user, provider, resolver?)` — mirror of `firebase/auth`.

Runs the SAME resolver seam as `signInWithPopup`, with
`authType: 'link'` so a host UI can tell the two apart and say "link
your Google account" rather than "sign in". The resolved credential
names the provider to attach; the sandbox performs the attach.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `provider` | [`AuthProvider`](#authprovider) |
| `resolver?` | [`AuthFlowResolver`](#authflowresolver) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="linkwithredirect"></a>

### linkWithRedirect()

```ts
function linkWithRedirect(
   user: User,
   provider: AuthProvider,
resolver?: AuthFlowResolver): Promise<UserCredential>;
```

`linkWithRedirect(user, provider, resolver?)` — mirror of
`firebase/auth`. The sandbox has no navigation, so the resolver
resolves inline and the link completes immediately — the same
simplification `signInWithRedirect` makes, and the same observable
outcome a real redirect produces once it returns.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `provider` | [`AuthProvider`](#authprovider) |
| `resolver?` | [`AuthFlowResolver`](#authflowresolver) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="onauthstatechanged"></a>

### onAuthStateChanged()

```ts
function onAuthStateChanged(auth: Auth, observer: AuthObserver): Unsubscribe;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `observer` | [`AuthObserver`](#authobserver) |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="onidtokenchanged"></a>

### onIdTokenChanged()

```ts
function onIdTokenChanged(auth: Auth, observer: AuthObserver): Unsubscribe;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `observer` | [`AuthObserver`](#authobserver) |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="parseactioncodeurl"></a>

### parseActionCodeURL()

```ts
function parseActionCodeURL(link: string): ActionCodeURL;
```

`parseActionCodeURL(link)` — free-function mirror of
[ActionCodeURL.parseLink](#parselink). Upstream ships both and they agree;
the oracle capture asserts that agreement
(`parseActionCodeURLAgrees: true`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `link` | `string` |

#### Returns

[`ActionCodeURL`](#actioncodeurl)

***

<a id="reauthenticatewithcredential"></a>

### reauthenticateWithCredential()

```ts
function reauthenticateWithCredential(user: User, credential: AuthCredential): Promise<UserCredential>;
```

`reauthenticateWithCredential(user, credential)` — mirror of
`firebase/auth`.

Really re-verifies: an email credential is checked against the stored
password exactly as `signInWithEmailAndPassword` checks it, so a wrong
password throws `auth/wrong-password` and a credential belonging to a
DIFFERENT account throws `auth/user-mismatch` (the check that stops
"reauthenticate as someone else" from silently succeeding).

On success mints a fresh ID token, so `getIdTokenResult(user).authTime`
advances — the observable trace of a fresh sign-in, and the thing prod's
recent-login gate reads.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `credential` | [`AuthCredential`](#authcredential) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="reauthenticatewithpopup"></a>

### reauthenticateWithPopup()

```ts
function reauthenticateWithPopup(
   user: User,
   provider: AuthProvider,
resolver?: AuthFlowResolver): Promise<UserCredential>;
```

`reauthenticateWithPopup(user, provider, resolver?)` — mirror of
`firebase/auth`. Runs the shared resolver seam with
`authType: 'reauth'`, so a host UI can present "confirm it's you"
rather than a fresh sign-in.

The resolved credential must be for THE SAME user — a resolver that
hands back a different uid throws `auth/user-mismatch`. Without that
check, "re-authentication" would accept anyone.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `provider` | [`AuthProvider`](#authprovider) |
| `resolver?` | [`AuthFlowResolver`](#authflowresolver) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="reauthenticatewithredirect"></a>

### reauthenticateWithRedirect()

```ts
function reauthenticateWithRedirect(
   user: User,
   provider: AuthProvider,
resolver?: AuthFlowResolver): Promise<UserCredential>;
```

`reauthenticateWithRedirect(user, provider, resolver?)` — mirror of
`firebase/auth`. Resolves inline (the sandbox has no navigation), same
as `signInWithRedirect`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `provider` | [`AuthProvider`](#authprovider) |
| `resolver?` | [`AuthFlowResolver`](#authflowresolver) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="reload"></a>

### reload()

```ts
function reload(user: User): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |

#### Returns

`Promise`\<`void`\>

***

<a id="revokeaccesstoken"></a>

### revokeAccessToken()

```ts
function revokeAccessToken(auth: Auth, token: string): Promise<void>;
```

`revokeAccessToken(auth, token)` — mirror of `firebase/auth`.

In production this tells the IDENTITY PROVIDER (in practice: Apple) to
revoke an OAuth access token — a call that leaves Firebase entirely and
lands on Apple's servers. It exists because Apple requires an app that
offers "Sign in with Apple" to also offer account deletion that revokes
the token.

There is no external IdP behind a sandbox sign-in, so there is no token
out there to revoke and nothing this call could truthfully do. It is an
ACCEPTED NO-OP: it resolves, so the account-deletion flow an app must
ship runs end to end against the sandbox, and it changes no sandbox
state, because claiming otherwise would be a lie. `diverged-documented`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `token` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="sendemailverification"></a>

### sendEmailVerification()

```ts
function sendEmailVerification(user: User, settings?: ActionCodeSettings): Promise<void>;
```

`sendEmailVerification(user, settings?)` — mirror of `firebase/auth`.

Throws `auth/missing-email` for a user with no email on the account
(an anonymous user). Oracle-backed:
`auth-sendemailverification-shape` captured exactly that code against
prod for an anonymous user.

On success the message is mailed and NOTHING ELSE HAPPENS —
`user.emailVerified` stays false. Verification happens when the code
in that message is redeemed (`applyActionCode`), not when it is sent.
Modeling that gap faithfully is the whole point: agent code that
gates on `emailVerified` must see it stay false here, exactly as it
would in production.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `settings?` | [`ActionCodeSettings`](#actioncodesettings) |

#### Returns

`Promise`\<`void`\>

***

<a id="sendpasswordresetemail"></a>

### sendPasswordResetEmail()

```ts
function sendPasswordResetEmail(
   auth: Auth,
   email: string,
settings?: ActionCodeSettings): Promise<void>;
```

`sendPasswordResetEmail(auth, email, settings?)` — mirror of
`firebase/auth`.

Resolves for an address no account owns, WITHOUT throwing and without
mailing anything. That is not laziness: it is Email Enumeration
Protection, and the oracle confirmed prod behaves exactly this way
(`auth-sendpasswordresetemail-unknown-user`:
`resolvedForUnknownUser: true`). A shim that threw
`auth/user-not-found` here would hand agent code a working account
oracle that production deliberately took away.

A malformed address still throws `auth/invalid-email` — also
oracle-confirmed.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `email` | `string` |
| `settings?` | [`ActionCodeSettings`](#actioncodesettings) |

#### Returns

`Promise`\<`void`\>

***

<a id="sendsigninlinktoemail"></a>

### sendSignInLinkToEmail()

```ts
function sendSignInLinkToEmail(
   auth: Auth,
   email: string,
settings: ActionCodeSettings): Promise<void>;
```

`sendSignInLinkToEmail(auth, email, settings)` — mirror of
`firebase/auth`.

`settings.url` is REQUIRED and `settings.handleCodeInApp` must be
`true` — both enforced client-side, both oracle-pinned (see the file
docstring). Unlike `sendPasswordResetEmail`, this one does NOT require
an existing account: sending a sign-in link to an unknown address is
the sign-UP path, and the account is created when the link is redeemed.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `email` | `string` |
| `settings` | [`ActionCodeSettings`](#actioncodesettings) |

#### Returns

`Promise`\<`void`\>

***

<a id="setpersistence"></a>

### setPersistence()

```ts
function setPersistence(auth: Auth, persistence: Persistence): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `persistence` | [`Persistence`](#persistence) |

#### Returns

`Promise`\<`void`\>

***

<a id="signinanonymously"></a>

### signInAnonymously()

```ts
function signInAnonymously(auth: Auth): Promise<UserCredential>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="signinwithcredential"></a>

### signInWithCredential()

```ts
function signInWithCredential(auth: Auth, credential: AuthCredential): Promise<UserCredential>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `credential` | [`AuthCredential`](#authcredential) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="signinwithcustomtoken"></a>

### signInWithCustomToken()

```ts
function signInWithCustomToken(auth: Auth, customToken: string): Promise<UserCredential>;
```

`signInWithCustomToken(auth, customToken)` — mirror of `firebase/auth`.

In production a custom token is a JWT your BACKEND signs with a service
account, asserting "this is user X, with these claims". The client
exchanges it for a session. It is the standard bridge from an existing
auth system into Firebase.

The sandbox has no service-account key and no signature to verify, so
it treats the token as what it structurally is: a claim of identity.
It accepts a token in either of two shapes —

  1. a JSON object `{"uid": "...", "claims": {...}}` (optionally
     base64url-encoded), which is exactly the payload
     `admin.auth().createCustomToken(uid, claims)` signs. This is the
     shape the pyric-admin mirror mints, so the two sides compose: mint
     on the admin side, redeem here.
  2. a real three-part JWT, whose middle segment is decoded and read
     for `uid` / `claims`. The SIGNATURE IS NOT VERIFIED — the sandbox
     has no key and says so rather than pretending.

Anything else throws `auth/invalid-custom-token` — ORACLE-BACKED
(`auth-signinwithcustomtoken-invalid` captured exactly that code from
prod for both a malformed token and the empty string).

The identity is created if it does not exist (matching prod: a custom
token for an unknown uid mints that account), and the credential
carries `providerId: null` — custom-token sign-in is not a federated
provider, the same rule anonymous sign-in follows.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `customToken` | `string` |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="signinwithemailandpassword"></a>

### signInWithEmailAndPassword()

```ts
function signInWithEmailAndPassword(
   auth: Auth,
   email: string,
password: string): Promise<UserCredential>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `email` | `string` |
| `password` | `string` |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="signinwithemaillink"></a>

### signInWithEmailLink()

```ts
function signInWithEmailLink(
   auth: Auth,
   email: string,
link: string): Promise<UserCredential>;
```

`signInWithEmailLink(auth, email, link)` — mirror of `firebase/auth`.
Redeems the code in the link and signs the user in.

Creates the account if the address is new — a first-time email-link
sign-in IS a sign-up, and `getAdditionalUserInfo(cred).isNewUser`
reports it honestly. Either way the account comes out `emailVerified:
true`, because redeeming a code that was mailed to that address is
proof the user controls it. (An account born this way has NO password:
`signInWithEmailAndPassword` against it fails until one is set, exactly
as in prod.)

Throws `auth/argument-error` for a link with no `oobCode`
(oracle-backed), and `auth/invalid-action-code` for a code the sandbox
never issued or that has already been redeemed (single-use).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `email` | `string` |
| `link` | `string` |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="signinwithpopup"></a>

### signInWithPopup()

```ts
function signInWithPopup(
   auth: Auth,
   provider: AuthProvider,
resolver?: AuthFlowResolver): Promise<UserCredential>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `provider` | [`AuthProvider`](#authprovider) |
| `resolver?` | [`AuthFlowResolver`](#authflowresolver) |

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

<a id="signinwithredirect"></a>

### signInWithRedirect()

```ts
function signInWithRedirect(
   auth: Auth,
   provider: AuthProvider,
resolver?: AuthFlowResolver): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `provider` | [`AuthProvider`](#authprovider) |
| `resolver?` | [`AuthFlowResolver`](#authflowresolver) |

#### Returns

`Promise`\<`void`\>

***

<a id="signout-2"></a>

### signOut()

```ts
function signOut(auth: Auth): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

#### Returns

`Promise`\<`void`\>

***

<a id="unlink"></a>

### unlink()

```ts
function unlink(user: User, providerId: string): Promise<User>;
```

`unlink(user, providerId)` — mirror of `firebase/auth`. Detaches a
provider and returns the updated user.

`auth/no-such-provider` when it was never linked — ORACLE-BACKED
(`auth-unlink-provider` captured exactly this code against prod).

Unlinking the `'password'` provider takes the password with it, so
`signInWithEmailAndPassword` for that account stops working — which is
the observable point of doing it. Unlinking the LAST provider does not
re-anonymize the account: `isAnonymous` describes how an identity was
born, not what it currently carries.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `providerId` | `string` |

#### Returns

`Promise`\<[`User`](#user-1)\>

***

<a id="updatecurrentuser"></a>

### updateCurrentUser()

```ts
function updateCurrentUser(auth: Auth, user: User): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `user` | [`User`](#user-1) |

#### Returns

`Promise`\<`void`\>

***

<a id="updateemail"></a>

### updateEmail()

```ts
function updateEmail(user: User, newEmail: string): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `newEmail` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="updatepassword"></a>

### updatePassword()

```ts
function updatePassword(user: User, newPassword: string): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `newPassword` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="updateprofile-2"></a>

### updateProfile()

```ts
function updateProfile(user: User, profile: {
  displayName?: string;
  photoURL?: string;
}): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `profile` | \{ `displayName?`: `string`; `photoURL?`: `string`; \} |
| `profile.displayName?` | `string` |
| `profile.photoURL?` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="usedevicelanguage"></a>

### useDeviceLanguage()

```ts
function useDeviceLanguage(auth: Auth): void;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |

#### Returns

`void`

***

<a id="validatepassword"></a>

### validatePassword()

```ts
function validatePassword(auth: Auth, password: string): Promise<PasswordValidationStatus>;
```

`validatePassword(auth, password)` — mirror of `firebase/auth`.

Checks a password against the project policy WITHOUT attempting a
sign-up, so a UI can show live strength feedback as the user types.
Returns the same `PasswordValidationStatus` shape prod returns, with
only the requirements the policy actually sets — see the note on
SANDBOX\_PASSWORD\_POLICY about why unset is not `false`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `password` | `string` |

#### Returns

`Promise`\<[`PasswordValidationStatus`](#passwordvalidationstatus)\>

***

<a id="verifybeforeupdateemail"></a>

### verifyBeforeUpdateEmail()

```ts
function verifyBeforeUpdateEmail(
   user: User,
   newEmail: string,
settings?: ActionCodeSettings): Promise<void>;
```

`verifyBeforeUpdateEmail(user, newEmail, settings?)` — mirror of
`firebase/auth`.

Mails a code to the NEW address and returns. The account's email does
NOT change yet — it changes when that code is redeemed, which is the
one guarantee separating this API from a bare `updateEmail`: the user
must prove they control the new address before it becomes theirs.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`User`](#user-1) |
| `newEmail` | `string` |
| `settings?` | [`ActionCodeSettings`](#actioncodesettings) |

#### Returns

`Promise`\<`void`\>

***

<a id="verifypasswordresetcode"></a>

### verifyPasswordResetCode()

```ts
function verifyPasswordResetCode(auth: Auth, code: string): Promise<string>;
```

`verifyPasswordResetCode(auth, code)` — mirror of `firebase/auth`.
Checks a reset code and returns the account's email. Does NOT redeem
it — `confirmPasswordReset` does.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`Auth`](#auth) |
| `code` | `string` |

#### Returns

`Promise`\<`string`\>
