<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric/auth

## Classes

### ActionCodeURL

A parsed out-of-band action link. Mirrors `firebase/auth`'s
`ActionCodeURL`.

Construct one only via [ActionCodeURL.parseLink](#parselink) or
[parseActionCodeURL](#parseactioncodeurl) — upstream's constructor is internal, and
both entry points return `null` rather than throwing for a link that
does not carry the required `mode` + `oobCode`.

#### Properties

##### apiKey

> `readonly` **apiKey**: `string`

The project API key carried in the link, or `null`.

##### code

> `readonly` **code**: `string`

The out-of-band code — the bearer token the action-code consumers
 (`applyActionCode`, `confirmPasswordReset`, …) redeem.

##### continueUrl

> `readonly` **continueUrl**: `string`

Where to send the user after the action completes. URL-decoded.
 `null` when the link carried no `continueUrl`.

##### languageCode

> `readonly` **languageCode**: `string`

BCP-47 language tag from the link's `lang` param, or `null`.

##### operation

> `readonly` **operation**: `string`

The normalized operation the code authorizes. One of
 [ActionCodeOperation](#actioncodeoperation) — NOT the raw `mode` param.

##### tenantId

> `readonly` **tenantId**: `string`

Multi-tenant tenant id, or `null`. The sandbox does not model
 tenants, so this is always `null` on a sandbox-minted link — but a
 link produced elsewhere and parsed here round-trips it.

#### Methods

##### parseLink()

> `static` **parseLink**(`link`): [`ActionCodeURL`](#actioncodeurl)

Parse an action link. Returns `null` — never throws — when the input
is not a URL, carries no `mode`, carries an unrecognized `mode`, or
carries no `oobCode`. Oracle-pinned (see the file docstring).

###### Parameters

###### link

`string`

###### Returns

[`ActionCodeURL`](#actioncodeurl)

***

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

##### Constructor

> **new AuthCredential**(`providerId`, `signInMethod`): [`AuthCredential`](#authcredential)

###### Parameters

###### providerId

`string`

###### signInMethod

`string`

###### Returns

[`AuthCredential`](#authcredential)

#### Properties

##### providerId

> `readonly` **providerId**: `string`

Provider identifier (e.g. `'google.com'`, `'password'`).

##### signInMethod

> `readonly` **signInMethod**: `string`

Sign-in method identifier. Distinct from [providerId](#providerid): the
 `'password'` provider signs in via `'password'` OR `'emailLink'`.

#### Methods

##### toJSON()

> **toJSON**(): `Record`\<`string`, `unknown`\>

Serialize. Mirrors upstream's `AuthCredential.toJSON()`.

###### Returns

`Record`\<`string`, `unknown`\>

##### fromJSON()

> `static` **fromJSON**(`json`): [`AuthCredential`](#authcredential)

Deserialize a credential previously produced by [toJSON](#tojson).
Returns `null` for input that isn't a credential payload — matching
upstream, which never throws here.

###### Parameters

###### json

`string` | `Record`\<`string`, `unknown`\>

###### Returns

[`AuthCredential`](#authcredential)

***

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

##### Constructor

> **new EmailAuthCredential**(`email`, `secret`, `signInMethod?`): [`EmailAuthCredential`](#emailauthcredential)

###### Parameters

###### email

`string`

###### secret

`string`

###### signInMethod?

`string`

###### Returns

[`EmailAuthCredential`](#emailauthcredential)

###### Overrides

[`AuthCredential`](#authcredential).[`constructor`](#constructor)

#### Properties

##### email

> `readonly` **email**: `string`

The account this credential is for.

##### providerId

> `readonly` **providerId**: `string`

Provider identifier (e.g. `'google.com'`, `'password'`).

###### Inherited from

[`AuthCredential`](#authcredential).[`providerId`](#providerid)

##### signInMethod

> `readonly` **signInMethod**: `string`

Sign-in method identifier. Distinct from [providerId](#providerid): the
 `'password'` provider signs in via `'password'` OR `'emailLink'`.

###### Inherited from

[`AuthCredential`](#authcredential).[`signInMethod`](#signinmethod)

#### Accessors

##### emailLink

###### Get Signature

> **get** **emailLink**(): `string`

The email link carried by an `'emailLink'`-method credential, else `null`.

###### Returns

`string`

##### password

###### Get Signature

> **get** **password**(): `string`

The password carried by a `'password'`-method credential, else `null`.

###### Returns

`string`

#### Methods

##### toJSON()

> **toJSON**(): `Record`\<`string`, `unknown`\>

Serialize. Mirrors upstream's `AuthCredential.toJSON()`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Overrides

[`AuthCredential`](#authcredential).[`toJSON`](#tojson)

##### fromJSON()

> `static` **fromJSON**(`json`): [`AuthCredential`](#authcredential)

Deserialize a credential previously produced by [toJSON](#tojson).
Returns `null` for input that isn't a credential payload — matching
upstream, which never throws here.

###### Parameters

###### json

`string` | `Record`\<`string`, `unknown`\>

###### Returns

[`AuthCredential`](#authcredential)

###### Inherited from

[`AuthCredential`](#authcredential).[`fromJSON`](#fromjson)

***

### EmailAuthProvider

Email + password provider — marker class, used as the
 `providerId` on email/password credentials.

#### Constructors

##### Constructor

> **new EmailAuthProvider**(): [`EmailAuthProvider`](#emailauthprovider)

###### Returns

[`EmailAuthProvider`](#emailauthprovider)

#### Properties

##### providerId

> `readonly` **providerId**: `"password"` = `"password"`

##### EMAIL\_LINK\_SIGN\_IN\_METHOD

> `readonly` `static` **EMAIL\_LINK\_SIGN\_IN\_METHOD**: `"emailLink"` = `"emailLink"`

##### EMAIL\_PASSWORD\_SIGN\_IN\_METHOD

> `readonly` `static` **EMAIL\_PASSWORD\_SIGN\_IN\_METHOD**: `"password"` = `"password"`

##### PROVIDER\_ID

> `readonly` `static` **PROVIDER\_ID**: `"password"` = `"password"`

#### Methods

##### credential()

> `static` **credential**(`email`, `password`): [`EmailAuthCredential`](#emailauthcredential)

Build an email/password credential. The credential CARRIES THE
PASSWORD — which is what lets `linkWithCredential` and
`reauthenticateWithCredential` actually verify it against the sandbox
user DB, with no resolver and no mock. See `credentials.ts`.

###### Parameters

###### email

`string`

###### password

`string`

###### Returns

[`EmailAuthCredential`](#emailauthcredential)

##### credentialWithLink()

> `static` **credentialWithLink**(`email`, `emailLink`): [`EmailAuthCredential`](#emailauthcredential)

Build an email-LINK credential from a link the user received. Its
 secret is the link itself.

###### Parameters

###### email

`string`

###### emailLink

`string`

###### Returns

[`EmailAuthCredential`](#emailauthcredential)

***

### FacebookAuthProvider

Facebook OAuth provider.

#### Constructors

##### Constructor

> **new FacebookAuthProvider**(): [`FacebookAuthProvider`](#facebookauthprovider)

###### Returns

[`FacebookAuthProvider`](#facebookauthprovider)

#### Properties

##### providerId

> `readonly` **providerId**: `"facebook.com"` = `"facebook.com"`

##### FACEBOOK\_SIGN\_IN\_METHOD

> `readonly` `static` **FACEBOOK\_SIGN\_IN\_METHOD**: `"facebook.com"` = `"facebook.com"`

##### PROVIDER\_ID

> `readonly` `static` **PROVIDER\_ID**: `"facebook.com"` = `"facebook.com"`

#### Methods

##### addScope()

> **addScope**(`_scope`): [`FacebookAuthProvider`](#facebookauthprovider)

###### Parameters

###### \_scope

`string`

###### Returns

[`FacebookAuthProvider`](#facebookauthprovider)

##### setCustomParameters()

> **setCustomParameters**(`_params`): [`FacebookAuthProvider`](#facebookauthprovider)

###### Parameters

###### \_params

`Record`\<`string`, `unknown`\>

###### Returns

[`FacebookAuthProvider`](#facebookauthprovider)

##### credential()

> `static` **credential**(`accessToken`): [`AuthCredential`](#authcredential)

###### Parameters

###### accessToken

`string`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromError()

> `static` **credentialFromError**(`_err`): [`AuthCredential`](#authcredential)

###### Parameters

###### \_err

`unknown`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromResult()

> `static` **credentialFromResult**(`result`): [`AuthCredential`](#authcredential)

###### Parameters

###### result

[`UserCredential`](#usercredential)

###### Returns

[`AuthCredential`](#authcredential)

***

### GithubAuthProvider

GitHub OAuth provider.

#### Constructors

##### Constructor

> **new GithubAuthProvider**(): [`GithubAuthProvider`](#githubauthprovider)

###### Returns

[`GithubAuthProvider`](#githubauthprovider)

#### Properties

##### providerId

> `readonly` **providerId**: `"github.com"` = `"github.com"`

##### GITHUB\_SIGN\_IN\_METHOD

> `readonly` `static` **GITHUB\_SIGN\_IN\_METHOD**: `"github.com"` = `"github.com"`

##### PROVIDER\_ID

> `readonly` `static` **PROVIDER\_ID**: `"github.com"` = `"github.com"`

#### Methods

##### addScope()

> **addScope**(`_scope`): [`GithubAuthProvider`](#githubauthprovider)

###### Parameters

###### \_scope

`string`

###### Returns

[`GithubAuthProvider`](#githubauthprovider)

##### setCustomParameters()

> **setCustomParameters**(`_params`): [`GithubAuthProvider`](#githubauthprovider)

###### Parameters

###### \_params

`Record`\<`string`, `unknown`\>

###### Returns

[`GithubAuthProvider`](#githubauthprovider)

##### credential()

> `static` **credential**(`accessToken`): [`AuthCredential`](#authcredential)

###### Parameters

###### accessToken

`string`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromError()

> `static` **credentialFromError**(`_err`): [`AuthCredential`](#authcredential)

###### Parameters

###### \_err

`unknown`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromResult()

> `static` **credentialFromResult**(`result`): [`AuthCredential`](#authcredential)

###### Parameters

###### result

[`UserCredential`](#usercredential)

###### Returns

[`AuthCredential`](#authcredential)

***

### GoogleAuthProvider

Google OAuth provider. Sandbox marker; no real OAuth flow runs.

#### Constructors

##### Constructor

> **new GoogleAuthProvider**(): [`GoogleAuthProvider`](#googleauthprovider)

###### Returns

[`GoogleAuthProvider`](#googleauthprovider)

#### Properties

##### providerId

> `readonly` **providerId**: `"google.com"` = `"google.com"`

##### GOOGLE\_SIGN\_IN\_METHOD

> `readonly` `static` **GOOGLE\_SIGN\_IN\_METHOD**: `"google.com"` = `"google.com"`

##### PROVIDER\_ID

> `readonly` `static` **PROVIDER\_ID**: `"google.com"` = `"google.com"`

#### Methods

##### addScope()

> **addScope**(`_scope`): [`GoogleAuthProvider`](#googleauthprovider)

###### Parameters

###### \_scope

`string`

###### Returns

[`GoogleAuthProvider`](#googleauthprovider)

##### setCustomParameters()

> **setCustomParameters**(`_params`): [`GoogleAuthProvider`](#googleauthprovider)

###### Parameters

###### \_params

`Record`\<`string`, `unknown`\>

###### Returns

[`GoogleAuthProvider`](#googleauthprovider)

##### credential()

> `static` **credential**(`idToken?`, `accessToken?`): [`AuthCredential`](#authcredential)

Construct a credential directly from an OAuth id_token /
 access_token. Sandbox accepts any string; opaque marker only.

###### Parameters

###### idToken?

`string`

###### accessToken?

`string`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromError()

> `static` **credentialFromError**(`_err`): [`AuthCredential`](#authcredential)

###### Parameters

###### \_err

`unknown`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromResult()

> `static` **credentialFromResult**(`result`): [`AuthCredential`](#authcredential)

###### Parameters

###### result

[`UserCredential`](#usercredential)

###### Returns

[`AuthCredential`](#authcredential)

***

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

##### Constructor

> **new OAuthCredential**(`providerId`, `signInMethod`, `tokens?`): [`OAuthCredential`](#oauthcredential)

###### Parameters

###### providerId

`string`

###### signInMethod

`string`

###### tokens?

###### accessToken?

`string`

###### idToken?

`string`

###### secret?

`string`

###### Returns

[`OAuthCredential`](#oauthcredential)

###### Overrides

[`AuthCredential`](#authcredential).[`constructor`](#constructor)

#### Properties

##### accessToken?

> `readonly` `optional` **accessToken**: `string`

##### idToken?

> `readonly` `optional` **idToken**: `string`

##### providerId

> `readonly` **providerId**: `string`

Provider identifier (e.g. `'google.com'`, `'password'`).

###### Inherited from

[`AuthCredential`](#authcredential).[`providerId`](#providerid)

##### secret?

> `readonly` `optional` **secret**: `string`

##### signInMethod

> `readonly` **signInMethod**: `string`

Sign-in method identifier. Distinct from [providerId](#providerid): the
 `'password'` provider signs in via `'password'` OR `'emailLink'`.

###### Inherited from

[`AuthCredential`](#authcredential).[`signInMethod`](#signinmethod)

#### Methods

##### toJSON()

> **toJSON**(): `Record`\<`string`, `unknown`\>

Serialize. Mirrors upstream's `AuthCredential.toJSON()`.

###### Returns

`Record`\<`string`, `unknown`\>

###### Overrides

[`AuthCredential`](#authcredential).[`toJSON`](#tojson)

##### fromJSON()

> `static` **fromJSON**(`json`): [`AuthCredential`](#authcredential)

Deserialize a credential previously produced by [toJSON](#tojson).
Returns `null` for input that isn't a credential payload — matching
upstream, which never throws here.

###### Parameters

###### json

`string` | `Record`\<`string`, `unknown`\>

###### Returns

[`AuthCredential`](#authcredential)

###### Inherited from

[`AuthCredential`](#authcredential).[`fromJSON`](#fromjson)

***

### OAuthProvider

Generic OAuth provider — constructed with a providerId so callers
can target arbitrary OAuth IdPs (Twitter, Apple, etc.) that don't
have a dedicated class above.

#### Constructors

##### Constructor

> **new OAuthProvider**(`providerId`): [`OAuthProvider`](#oauthprovider)

###### Parameters

###### providerId

`string`

###### Returns

[`OAuthProvider`](#oauthprovider)

#### Properties

##### providerId

> `readonly` **providerId**: `string`

#### Methods

##### addScope()

> **addScope**(`_scope`): [`OAuthProvider`](#oauthprovider)

###### Parameters

###### \_scope

`string`

###### Returns

[`OAuthProvider`](#oauthprovider)

##### credential()

> **credential**(`args`): [`AuthCredential`](#authcredential)

###### Parameters

###### args

###### accessToken?

`string`

###### idToken?

`string`

###### rawNonce?

`string`

###### Returns

[`AuthCredential`](#authcredential)

##### setCustomParameters()

> **setCustomParameters**(`_params`): [`OAuthProvider`](#oauthprovider)

###### Parameters

###### \_params

`Record`\<`string`, `unknown`\>

###### Returns

[`OAuthProvider`](#oauthprovider)

##### credentialFromError()

> `static` **credentialFromError**(`_err`): [`AuthCredential`](#authcredential)

###### Parameters

###### \_err

`unknown`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromResult()

> `static` **credentialFromResult**(`result`): [`AuthCredential`](#authcredential)

###### Parameters

###### result

[`UserCredential`](#usercredential)

###### Returns

[`AuthCredential`](#authcredential)

***

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

##### Constructor

> **new SAMLAuthProvider**(`providerId`): [`SAMLAuthProvider`](#samlauthprovider)

###### Parameters

###### providerId

`string`

###### Returns

[`SAMLAuthProvider`](#samlauthprovider)

#### Properties

##### providerId

> `readonly` **providerId**: `string`

#### Methods

##### credentialFromError()

> `static` **credentialFromError**(`_err`): [`AuthCredential`](#authcredential)

###### Parameters

###### \_err

`unknown`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromResult()

> `static` **credentialFromResult**(`result`): [`AuthCredential`](#authcredential)

###### Parameters

###### result

[`UserCredential`](#usercredential)

###### Returns

[`AuthCredential`](#authcredential)

***

### TwitterAuthProvider

Twitter (X) OAuth provider. A dedicated class rather than a generic
`OAuthProvider('twitter.com')` because upstream ships one and consumer
code imports it by name.

Twitter is the one OAuth 1.0a provider in the set, which is why its
`credential()` takes a token AND a secret where the OAuth 2.0 providers
take a single access token.

#### Constructors

##### Constructor

> **new TwitterAuthProvider**(): [`TwitterAuthProvider`](#twitterauthprovider)

###### Returns

[`TwitterAuthProvider`](#twitterauthprovider)

#### Properties

##### providerId

> `readonly` **providerId**: `"twitter.com"` = `"twitter.com"`

##### PROVIDER\_ID

> `readonly` `static` **PROVIDER\_ID**: `"twitter.com"` = `"twitter.com"`

##### TWITTER\_SIGN\_IN\_METHOD

> `readonly` `static` **TWITTER\_SIGN\_IN\_METHOD**: `"twitter.com"` = `"twitter.com"`

#### Methods

##### addScope()

> **addScope**(`_scope`): [`TwitterAuthProvider`](#twitterauthprovider)

###### Parameters

###### \_scope

`string`

###### Returns

[`TwitterAuthProvider`](#twitterauthprovider)

##### setCustomParameters()

> **setCustomParameters**(`_params`): [`TwitterAuthProvider`](#twitterauthprovider)

###### Parameters

###### \_params

`Record`\<`string`, `unknown`\>

###### Returns

[`TwitterAuthProvider`](#twitterauthprovider)

##### credential()

> `static` **credential**(`token`, `secret`): [`AuthCredential`](#authcredential)

###### Parameters

###### token

`string`

###### secret

`string`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromError()

> `static` **credentialFromError**(`_err`): [`AuthCredential`](#authcredential)

###### Parameters

###### \_err

`unknown`

###### Returns

[`AuthCredential`](#authcredential)

##### credentialFromResult()

> `static` **credentialFromResult**(`result`): [`AuthCredential`](#authcredential)

###### Parameters

###### result

[`UserCredential`](#usercredential)

###### Returns

[`AuthCredential`](#authcredential)

## Interfaces

### ActionCodeInfo

What `checkActionCode` returns. Mirror of `firebase/auth`'s
`ActionCodeInfo`.

#### Properties

##### data

> **data**: `object`

###### email?

> `optional` **email**: `string`

The account the code acts on.

###### multiFactorInfo?

> `optional` **multiFactorInfo**: `null`

###### previousEmail?

> `optional` **previousEmail**: `string`

For `VERIFY_AND_CHANGE_EMAIL`: the address being moved AWAY from.

##### operation

> **operation**: `string`

One of [ActionCodeOperation](#actioncodeoperation).

***

### ActionCodeSettings

`ActionCodeSettings` — mirror of `firebase/auth`. The continue-URL
contract for a mailed link.

#### Properties

##### android?

> `optional` **android**: `object`

###### installApp?

> `optional` **installApp**: `boolean`

###### minimumVersion?

> `optional` **minimumVersion**: `string`

###### packageName

> **packageName**: `string`

##### dynamicLinkDomain?

> `optional` **dynamicLinkDomain**: `string`

Deprecated upstream alias of the Hosting link domain.

##### handleCodeInApp?

> `optional` **handleCodeInApp**: `boolean`

Handle the code inside the app rather than on the web widget.
 REQUIRED (`true`) for `sendSignInLinkToEmail`.

##### iOS?

> `optional` **iOS**: `object`

###### bundleId

> **bundleId**: `string`

##### linkDomain?

> `optional` **linkDomain**: `string`

##### url

> **url**: `string`

Where the link sends the user when they click it. REQUIRED.

***

### AdditionalUserInfo

Per-provider extra data attached to a sign-in. Mirrors
`firebase/auth`'s `AdditionalUserInfo`.

#### Properties

##### isNewUser

> `readonly` **isNewUser**: `boolean`

Was this credential produced by a sign-UP rather than a sign-IN?

##### profile

> `readonly` **profile**: `Record`\<`string`, `unknown`\>

IdP-specific profile blob. Empty object for the sandbox's own
 providers — there is no real IdP behind them to return a profile.

##### providerId

> `readonly` **providerId**: `string`

The provider that authenticated this user, or `null` for the
 anonymous and custom-token paths (neither is a federated provider —
 see the `ProviderId` docstring in `enums.ts`).

##### username?

> `readonly` `optional` **username**: `string`

Present only for GitHub / Twitter.

***

### Auth

Hidden brand on every [Auth](#auth) handle. Carries its owning sandbox
target. Consumers don't read it.

#### Properties

##### \[TARGET\_SYMBOL\]

> `readonly` **\[TARGET\_SYMBOL\]**: `SandboxTarget`

Internal — identifies the owning sandbox backend.

##### currentUser

> `readonly` **currentUser**: [`User`](#user-1)

Currently signed-in user, or `null`. Snapshot value — read
 through `onAuthStateChanged` for live updates.

#### Methods

##### signOut()

> **signOut**(): `Promise`\<`void`\>

Sign the current user out. Method form of the free `signOut(auth)`
 function — `firebase/auth`'s `Auth` exposes both, so consumer code
 written as `auth.signOut()` works unchanged (AUTH-GAP).

###### Returns

`Promise`\<`void`\>

***

### AuthFlowRequest

What a popup/redirect sign-in flow needs to know about the request.
Mirrors the params `firebase/auth` hands its emulator widget
(`providerId`, `authType`, `scopes`, `customParameters` — see
upstream `core/util/handler.ts`), so a resolver implementation has
the same inputs the real flow does.

#### Properties

##### authType

> **authType**: `"signIn"` \| `"reauth"` \| `"link"`

Why the popup/redirect opened. v0 only drives `'signIn'`; the
 others exist for parity with reauth/link flows.

##### customParameters?

> `optional` **customParameters**: `Record`\<`string`, `unknown`\>

Provider custom parameters (`setCustomParameters`). Sandbox-opaque.

##### providerId

> **providerId**: `string`

e.g. `'google.com'`, `'github.com'`, or a generic `OAuthProvider` id.

##### scopes?

> `optional` **scopes**: `string`[]

OAuth scopes the provider requested (`addScope`). Sandbox-opaque.

***

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

##### openPopup()

> **openPopup**(`req`): `Promise`\<[`UserCredential`](#usercredential)\>

Resolve a `signInWithPopup` flow to a credential.

###### Parameters

###### req

[`AuthFlowRequest`](#authflowrequest)

###### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

##### openRedirect()

> **openRedirect**(`req`): `Promise`\<[`UserCredential`](#usercredential)\>

Resolve a `signInWithRedirect` flow. In a real browser the redirect
 navigates away and the credential surfaces on return; the sandbox has
 no navigation, so this resolves inline to the credential and the SDK
 stashes it for the next `getRedirectResult`.

###### Parameters

###### req

[`AuthFlowRequest`](#authflowrequest)

###### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### AuthMailResolver

Notified for every message the sandbox's auth mail server emits — the
analog of [AuthFlowResolver](#authflowresolver) for the email family. A host (the
playground) installs one to surface the link in its UI; a headless
test reads AuthFlowRegistry.takeMail instead.

Advisory, not a gate: the message is written to the outbox whether or
not a resolver is installed, because in this model the sandbox IS the
mail server — the mail exists regardless of who is watching.

#### Methods

##### deliver()

> **deliver**(`mail`): `void`

###### Parameters

###### mail

[`OutboundAuthMail`](#outboundauthmail)

###### Returns

`void`

***

### AuthUserRecord

Public per-user record for the user-admin surface
(`sandbox.listUsers` & co.) — emulator-REST-shaped (Identity
Toolkit `accounts:lookup` field names, ISO timestamps).

#### Properties

##### createdAt

> **createdAt**: `string`

ISO timestamp.

##### customClaims

> **customClaims**: `Record`\<`string`, `unknown`\>

##### disabled

> **disabled**: `boolean`

##### displayName

> **displayName**: `string`

##### email

> **email**: `string`

##### emailVerified

> **emailVerified**: `boolean`

##### isAnonymous

> **isAnonymous**: `boolean`

##### lastLoginAt

> **lastLoginAt**: `string`

ISO timestamp, or null if the identity never signed in.

##### phoneNumber

> **phoneNumber**: `string`

##### photoUrl

> **photoUrl**: `string`

##### providerUserInfo

> **providerUserInfo**: [`ProviderUserInfo`](#provideruserinfo-2)[]

##### uid

> **uid**: `string`

***

### CreateUserRequest

`sandbox.createUser` request. Everything optional except that a
 `password` requires an `email` to be useful for sign-in.

#### Properties

##### customClaims?

> `optional` **customClaims**: `Record`\<`string`, `unknown`\>

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

##### photoUrl?

> `optional` **photoUrl**: `string`

##### providerUserInfo?

> `optional` **providerUserInfo**: [`ProviderUserInfo`](#provideruserinfo-2)[]

Linked OAuth providers to create the user with (dedup by
 providerId; multiple providers per user are supported). Same
 rules as [UpdateUserRequest.providerUserInfo](#provideruserinfo-3): `password`
 is credential-derived (send `password` to link it) and
 `anonymous` is token-level — neither can be forged here.

##### uid?

> `optional` **uid**: `string`

Defaults to a generated `user-<N>` uid.

***

### IdTokenResult

Result of `getIdTokenResult()`. Mirrors the `firebase/auth` shape.

On the sandbox backend `token` is an opaque sandbox-issued string
with a recognizable prefix (`sandbox-id-token-`) — NOT a JWT and
NOT cryptographically signed. `claims` echoes the user's
`customClaims` (from `sandbox.seedUsers`) plus a small set of
synthesized standard claims (`sub`, `aud`, `iss`). Expiration is
set far in the future since the sandbox has no refresh story.

#### Properties

##### authTime

> **authTime**: `string`

ISO string — when the user last *signed in* (not when the token
 was last refreshed).

##### claims

> **claims**: `Record`\<`string`, `unknown`\>

Custom + standard claims. Same map seen by the rules engine as
 `request.auth.token.*`.

##### expirationTime

> **expirationTime**: `string`

ISO string. Sandbox: far-future.

##### issuedAtTime

> **issuedAtTime**: `string`

ISO string.

##### signInProvider?

> `optional` **signInProvider**: `string`

Provider of the current sign-in session — `'password'`,
`'anonymous'`, `'google.com'`, etc., or `null` when unknown.
Mirrors `firebase/auth`'s `IdTokenResult.signInProvider`; the
sandbox synthesizes the same `firebase.sign_in_provider` claim.

Optional (`?`) for now: external `User` implementations built
before this field existed (the playground's helper-minted users,
until Track B's lockstep swap lands) omit it. The sandbox backend
always populates it. Tighten to required once all `User` minting
is backend-owned.

##### token

> **token**: `string`

Opaque sandbox token string: `sandbox-id-token-<uid>-<hash>`.

***

### MintedSession

A minted per-connection session: the `User` plus the AuthState
 its data contexts should carry (`sandbox.withAuth(state)`).

#### Properties

##### state

> **state**: `any`

##### user

> **user**: [`User`](#user-1)

***

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

##### code

> **code**: `string`

The out-of-band code the recipient would redeem.

##### email

> **email**: `string`

Recipient.

##### link

> **link**: `string`

The full action link the message would contain — the exact string
 `signInWithEmailLink` / `parseActionCodeURL` accept.

##### newEmail?

> `optional` **newEmail**: `string`

For `VERIFY_AND_CHANGE_EMAIL`: the address being moved TO.

##### operation

> **operation**: `string`

The [ActionCodeOperation](#actioncodeoperation) this message authorizes.

***

### PasswordPolicy

Mirror of `firebase/auth`'s `PasswordPolicy`.

#### Properties

##### allowedNonAlphanumericCharacters

> `readonly` **allowedNonAlphanumericCharacters**: `string`

##### customStrengthOptions

> `readonly` **customStrengthOptions**: `object`

###### containsLowercaseLetter?

> `readonly` `optional` **containsLowercaseLetter**: `boolean`

###### containsNonAlphanumericCharacter?

> `readonly` `optional` **containsNonAlphanumericCharacter**: `boolean`

###### containsNumericCharacter?

> `readonly` `optional` **containsNumericCharacter**: `boolean`

###### containsUppercaseLetter?

> `readonly` `optional` **containsUppercaseLetter**: `boolean`

###### maxPasswordLength?

> `readonly` `optional` **maxPasswordLength**: `number`

###### minPasswordLength?

> `readonly` `optional` **minPasswordLength**: `number`

##### enforcementState

> `readonly` **enforcementState**: `string`

`'ENFORCE'` or `'OFF'`.

##### forceUpgradeOnSignin

> `readonly` **forceUpgradeOnSignin**: `boolean`

***

### PasswordValidationStatus

Mirror of `firebase/auth`'s `PasswordValidationStatus`.

#### Properties

##### containsLowercaseLetter?

> `readonly` `optional` **containsLowercaseLetter**: `boolean`

##### containsNonAlphanumericCharacter?

> `readonly` `optional` **containsNonAlphanumericCharacter**: `boolean`

##### containsNumericCharacter?

> `readonly` `optional` **containsNumericCharacter**: `boolean`

##### containsUppercaseLetter?

> `readonly` `optional` **containsUppercaseLetter**: `boolean`

##### isValid

> `readonly` **isValid**: `boolean`

##### meetsMaxPasswordLength?

> `readonly` `optional` **meetsMaxPasswordLength**: `boolean`

##### meetsMinPasswordLength?

> `readonly` `optional` **meetsMinPasswordLength**: `boolean`

##### passwordPolicy

> `readonly` **passwordPolicy**: [`PasswordPolicy`](#passwordpolicy)

***

### Persistence

Opaque marker for `setPersistence`. The sandbox records the selected
session storage mode from the `type` field.

`'COOKIE'` is upstream's fourth type (`browserCookiePersistence`, for
SSR) — the union matches `firebase/auth`'s `Persistence.type` exactly.

#### Properties

##### type

> `readonly` **type**: `"SESSION"` \| `"LOCAL"` \| `"NONE"` \| `"COOKIE"`

***

### ProviderUserInfo

One linked provider on a stored user. Emulator-shaped (the
 Identity Toolkit `providerUserInfo` array) — an array rather than
 a single string so account linking can extend it later.

#### Properties

##### providerId

> **providerId**: `string`

***

### SeedUser

#### Properties

##### customClaims?

> `optional` **customClaims**: `Record`\<`string`, `unknown`\>

##### displayName?

> `optional` **displayName**: `string`

##### email

> **email**: `string`

##### password

> **password**: `string`

##### providerId?

> `optional` **providerId**: `string`

Originating provider for this identity (e.g. `'google.com'`).
 Defaults to `'password'` — the natural provider for a record
 seeded with an email + password. A host seeding popup-flow
 identities passes the real provider so `listIdentities` /
 `IdTokenResult.signInProvider` label them correctly.

##### uid

> **uid**: `string`

***

### SignInIdentitySpec

"Add account" field set for SandboxBackend.createSignInCredential
 — mirrors the emulator's add-user form (`customAttributes` →
 `customClaims`).

#### Properties

##### customClaims?

> `optional` **customClaims**: `Record`\<`string`, `unknown`\>

##### displayName?

> `optional` **displayName**: `string`

##### email

> **email**: `string`

##### uid?

> `optional` **uid**: `string`

Defaults to `'<providerId>:<email>'`.

***

### UpdateUserRequest

`sandbox.updateUser` request — `undefined` fields are left
 untouched; `displayName: null` clears it. `customClaims` replaces
 the whole map (admin `setCustomUserClaims` semantics).

#### Properties

##### customClaims?

> `optional` **customClaims**: `Record`\<`string`, `unknown`\>

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

##### providerUserInfo?

> `optional` **providerUserInfo**: [`ProviderUserInfo`](#provideruserinfo-2)[]

REPLACES the user's linked OAuth providers (dedup by providerId;
 multiple providers per user are supported — the record's
 `providerUserInfo` is an array precisely for account linking).
 The `password` entry is credential-derived and managed by the
 backend: it survives the replacement while the user has a
 password and cannot be linked through this field; `anonymous`
 is a token-level provider, never a linked entry.

***

### User

The signed-in user. Subset of `firebase/auth`'s `User` interface
containing the fields the sandbox can synthesize faithfully.

The heavier `User` surface the sandbox does NOT model (`metadata`,
`refreshToken`, `tenantId`, `reload()`, `delete()`, `toJSON()`) is
documented in `docs/auth/COMPAT.md` / the deny-list rather than
synthesized — see AUTH-GAP.

#### Properties

##### displayName

> `readonly` **displayName**: `string`

Display name, or `null` if none.

##### email

> `readonly` **email**: `string`

Email address, or `null` for anonymous users / providers that
 didn't supply one.

##### emailVerified?

> `readonly` `optional` **emailVerified**: `boolean`

Whether the email has been verified. Sandbox: `false` unless the
 seeded/mock user set it (no verification flow). Optional on the
 type so host helpers that synthesize a partial `User` aren't forced
 to specify it; the sandbox backend always populates it.

##### isAnonymous

> `readonly` **isAnonymous**: `boolean`

True iff this user signed in via `signInAnonymously`.

##### phoneNumber?

> `readonly` `optional` **phoneNumber**: `string`

E.164 phone number, or `null`. Optional on the type; always
 populated by the sandbox backend.

##### photoURL?

> `readonly` `optional` **photoURL**: `string`

Profile photo URL, or `null`. Optional on the type (see
 [emailVerified](#emailverified-3)); always populated by the sandbox backend.

##### providerData?

> `readonly` `optional` **providerData**: [`UserInfo`](#userinfo)[]

One [UserInfo](#userinfo) per linked provider. Sandbox synthesizes a
 single entry from the user's own fields for non-anonymous users;
 empty for anonymous. Optional on the type; always populated by the
 sandbox backend.

##### providerId?

> `readonly` `optional` **providerId**: `string`

The aggregate provider id (`'firebase'` for a real `User`;
 per-provider ids live in [providerData](#providerdata)). Optional on the
 type; always populated by the sandbox backend.

##### uid

> `readonly` **uid**: `string`

Firebase UID — globally unique per project. Sandbox: minted by
 `signInAnonymously` or supplied via `seedUsers`.

#### Methods

##### getIdToken()

> **getIdToken**(`forceRefresh?`): `Promise`\<`string`\>

Get the user's ID token, refreshing it if needed.

Sandbox: returns the cached opaque token; with
`forceRefresh: true` mints a fresh token, caches it, and fires
`onIdTokenChanged` listeners (matches prod — oracle:
`packages/conformance/observations/auth/auth-getidtoken-force-refresh.json`
and `…/auth-onidtokenchanged-force-refresh.json`).

###### Parameters

###### forceRefresh?

`boolean`

###### Returns

`Promise`\<`string`\>

##### getIdTokenResult()

> **getIdTokenResult**(`forceRefresh?`): `Promise`\<[`IdTokenResult`](#idtokenresult)\>

Get the full ID token + claims. See [IdTokenResult](#idtokenresult).

###### Parameters

###### forceRefresh?

`boolean`

###### Returns

`Promise`\<[`IdTokenResult`](#idtokenresult)\>

***

### UserCredential

Result of every sign-in method. Mirrors `firebase/auth`.

`operationType` discriminates what produced it: `'signIn'` for a fresh
sign-in (including `createUserWithEmailAndPassword` — oracle-pinned),
`'link'` for `linkWith*`, `'reauthenticate'` for `reauthenticateWith*`.

#### Properties

##### \_additionalUserInfo?

> `optional` **\_additionalUserInfo**: `object`

What `getAdditionalUserInfo(cred)` returns. Carried on the credential
rather than derived, because `isNewUser` is a fact only the flow that
MINTED the credential knows: `createUserWithEmailAndPassword` created
the identity, `signInWithEmailAndPassword` did not, and nothing about
the finished credential can tell them apart after the fact.

Underscore-prefixed and optional: it is not part of the shape a host
or a test fixture has to synthesize (a credential without it degrades
honestly — see `getAdditionalUserInfo`).

###### isNewUser

> `readonly` **isNewUser**: `boolean`

###### profile

> `readonly` **profile**: `Record`\<`string`, `unknown`\>

###### providerId

> `readonly` **providerId**: `string`

###### username?

> `readonly` `optional` **username**: `string`

##### operationType

> **operationType**: `"signIn"` \| `"link"` \| `"reauthenticate"`

##### providerId

> **providerId**: `string`

##### user

> **user**: [`User`](#user-1)

***

### UserInfo

Per-provider profile info — mirror of `firebase/auth`'s `UserInfo`.
Each entry in [User.providerData](#providerdata) describes one linked provider.

#### Properties

##### displayName

> `readonly` **displayName**: `string`

Display name from this provider, or `null`.

##### email

> `readonly` **email**: `string`

Email from this provider, or `null`.

##### phoneNumber

> `readonly` **phoneNumber**: `string`

E.164 phone number from this provider, or `null`.

##### photoURL

> `readonly` **photoURL**: `string`

Profile photo URL from this provider, or `null`.

##### providerId

> `readonly` **providerId**: `string`

Provider id (e.g. `'password'`, `'google.com'`).

##### uid

> `readonly` **uid**: `string`

The user's id as known to this provider.

## Type Aliases

### ActionCodeOperation

> **ActionCodeOperation** = *typeof* [`ActionCodeOperation`](#actioncodeoperation-1)\[keyof *typeof* [`ActionCodeOperation`](#actioncodeoperation-1)\]

***

### AuthErrorMap()

> **AuthErrorMap** = () => `Record`\<`string`, `string`\>

An error map — upstream's `AuthErrorMap`. Passed to `initializeAuth`
to control how much detail a thrown `FirebaseError` carries.

#### Returns

`Record`\<`string`, `string`\>

***

### AuthObserver

> **AuthObserver** = (`user`) => `void` \| \{ `complete?`: () => `void`; `error?`: (`err`) => `void`; `next?`: (`user`) => `void`; \}

Observer shape accepted by `onAuthStateChanged` / `onIdTokenChanged`.
Mirrors `firebase/auth`'s `NextOrObserver<User | null>`.

***

### AuthProvider

> **AuthProvider** = [`GoogleAuthProvider`](#googleauthprovider) \| [`FacebookAuthProvider`](#facebookauthprovider) \| [`GithubAuthProvider`](#githubauthprovider) \| [`OAuthProvider`](#oauthprovider) \| \{ `providerId`: `string`; \}

Union of all supported provider instance shapes. Used in the
`signInWithPopup` / `signInWithRedirect` overloads (the latter is
out of scope but the type makes the surface consistent).

***

### FederatedProviderId

> **FederatedProviderId** = *typeof* [`FEDERATED_PROVIDER_IDS`](#federated_provider_ids)\[`number`\]

One of the first-class federated provider ids ([FEDERATED\_PROVIDER\_IDS](#federated_provider_ids)).

***

### MintSessionRequest

> **MintSessionRequest** = \{ `kind`: `"anonymous"`; \} \| \{ `email`: `string`; `kind`: `"password"`; `password`: `string`; \} \| \{ `email`: `string`; `kind`: `"createPassword"`; `password`: `string`; \} \| \{ `kind`: `"uid"`; `uid`: `string`; \}

Request for SandboxBackend.mintDetachedSession — one variant
per client sign-in shape, plus `uid` for existing identities
(session restore, provider-bridge accept).

***

### OperationType

> **OperationType** = *typeof* [`OperationType`](#operationtype-2)\[keyof *typeof* [`OperationType`](#operationtype-2)\]

***

### ProviderId

> **ProviderId** = *typeof* [`ProviderId`](#providerid-18)\[keyof *typeof* [`ProviderId`](#providerid-18)\]

***

### SignInMethod

> **SignInMethod** = *typeof* [`SignInMethod`](#signinmethod-4)\[keyof *typeof* [`SignInMethod`](#signinmethod-4)\]

***

### Unsubscribe()

> **Unsubscribe** = () => `void`

Returned by `onAuthStateChanged` / `onIdTokenChanged`.

#### Returns

`void`

## Variables

### ActionCodeOperation

> `const` **ActionCodeOperation**: `object`

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

##### EMAIL\_SIGNIN

> `readonly` **EMAIL\_SIGNIN**: `"EMAIL_SIGNIN"`

##### PASSWORD\_RESET

> `readonly` **PASSWORD\_RESET**: `"PASSWORD_RESET"`

##### RECOVER\_EMAIL

> `readonly` **RECOVER\_EMAIL**: `"RECOVER_EMAIL"`

##### REVERT\_SECOND\_FACTOR\_ADDITION

> `readonly` **REVERT\_SECOND\_FACTOR\_ADDITION**: `"REVERT_SECOND_FACTOR_ADDITION"`

##### VERIFY\_AND\_CHANGE\_EMAIL

> `readonly` **VERIFY\_AND\_CHANGE\_EMAIL**: `"VERIFY_AND_CHANGE_EMAIL"`

##### VERIFY\_EMAIL

> `readonly` **VERIFY\_EMAIL**: `"VERIFY_EMAIL"`

***

### AuthErrorCodes

> `const` **AuthErrorCodes**: `object`

The full `auth/*` error-code map, captured verbatim from Firebase Auth
12.13.0. The oracle suite pins representative values and the total count.

#### Type Declaration

##### ADMIN\_ONLY\_OPERATION

> `readonly` **ADMIN\_ONLY\_OPERATION**: `"auth/admin-restricted-operation"`

##### ALREADY\_INITIALIZED

> `readonly` **ALREADY\_INITIALIZED**: `"auth/already-initialized"`

##### APP\_NOT\_AUTHORIZED

> `readonly` **APP\_NOT\_AUTHORIZED**: `"auth/app-not-authorized"`

##### APP\_NOT\_INSTALLED

> `readonly` **APP\_NOT\_INSTALLED**: `"auth/app-not-installed"`

##### ARGUMENT\_ERROR

> `readonly` **ARGUMENT\_ERROR**: `"auth/argument-error"`

##### CAPTCHA\_CHECK\_FAILED

> `readonly` **CAPTCHA\_CHECK\_FAILED**: `"auth/captcha-check-failed"`

##### CODE\_EXPIRED

> `readonly` **CODE\_EXPIRED**: `"auth/code-expired"`

##### CORDOVA\_NOT\_READY

> `readonly` **CORDOVA\_NOT\_READY**: `"auth/cordova-not-ready"`

##### CORS\_UNSUPPORTED

> `readonly` **CORS\_UNSUPPORTED**: `"auth/cors-unsupported"`

##### CREDENTIAL\_ALREADY\_IN\_USE

> `readonly` **CREDENTIAL\_ALREADY\_IN\_USE**: `"auth/credential-already-in-use"`

##### CREDENTIAL\_MISMATCH

> `readonly` **CREDENTIAL\_MISMATCH**: `"auth/custom-token-mismatch"`

##### CREDENTIAL\_TOO\_OLD\_LOGIN\_AGAIN

> `readonly` **CREDENTIAL\_TOO\_OLD\_LOGIN\_AGAIN**: `"auth/requires-recent-login"`

##### DEPENDENT\_SDK\_INIT\_BEFORE\_AUTH

> `readonly` **DEPENDENT\_SDK\_INIT\_BEFORE\_AUTH**: `"auth/dependent-sdk-initialized-before-auth"`

##### DYNAMIC\_LINK\_NOT\_ACTIVATED

> `readonly` **DYNAMIC\_LINK\_NOT\_ACTIVATED**: `"auth/dynamic-link-not-activated"`

##### EMAIL\_CHANGE\_NEEDS\_VERIFICATION

> `readonly` **EMAIL\_CHANGE\_NEEDS\_VERIFICATION**: `"auth/email-change-needs-verification"`

##### EMAIL\_EXISTS

> `readonly` **EMAIL\_EXISTS**: `"auth/email-already-in-use"`

##### EMULATOR\_CONFIG\_FAILED

> `readonly` **EMULATOR\_CONFIG\_FAILED**: `"auth/emulator-config-failed"`

##### EXPIRED\_OOB\_CODE

> `readonly` **EXPIRED\_OOB\_CODE**: `"auth/expired-action-code"`

##### EXPIRED\_POPUP\_REQUEST

> `readonly` **EXPIRED\_POPUP\_REQUEST**: `"auth/cancelled-popup-request"`

##### INTERNAL\_ERROR

> `readonly` **INTERNAL\_ERROR**: `"auth/internal-error"`

##### INVALID\_API\_KEY

> `readonly` **INVALID\_API\_KEY**: `"auth/invalid-api-key"`

##### INVALID\_APP\_CREDENTIAL

> `readonly` **INVALID\_APP\_CREDENTIAL**: `"auth/invalid-app-credential"`

##### INVALID\_APP\_ID

> `readonly` **INVALID\_APP\_ID**: `"auth/invalid-app-id"`

##### INVALID\_AUTH

> `readonly` **INVALID\_AUTH**: `"auth/invalid-user-token"`

##### INVALID\_AUTH\_EVENT

> `readonly` **INVALID\_AUTH\_EVENT**: `"auth/invalid-auth-event"`

##### INVALID\_CERT\_HASH

> `readonly` **INVALID\_CERT\_HASH**: `"auth/invalid-cert-hash"`

##### INVALID\_CODE

> `readonly` **INVALID\_CODE**: `"auth/invalid-verification-code"`

##### INVALID\_CONTINUE\_URI

> `readonly` **INVALID\_CONTINUE\_URI**: `"auth/invalid-continue-uri"`

##### INVALID\_CORDOVA\_CONFIGURATION

> `readonly` **INVALID\_CORDOVA\_CONFIGURATION**: `"auth/invalid-cordova-configuration"`

##### INVALID\_CUSTOM\_TOKEN

> `readonly` **INVALID\_CUSTOM\_TOKEN**: `"auth/invalid-custom-token"`

##### INVALID\_DYNAMIC\_LINK\_DOMAIN

> `readonly` **INVALID\_DYNAMIC\_LINK\_DOMAIN**: `"auth/invalid-dynamic-link-domain"`

##### INVALID\_EMAIL

> `readonly` **INVALID\_EMAIL**: `"auth/invalid-email"`

##### INVALID\_EMULATOR\_SCHEME

> `readonly` **INVALID\_EMULATOR\_SCHEME**: `"auth/invalid-emulator-scheme"`

##### INVALID\_HOSTING\_LINK\_DOMAIN

> `readonly` **INVALID\_HOSTING\_LINK\_DOMAIN**: `"auth/invalid-hosting-link-domain"`

##### INVALID\_IDP\_RESPONSE

> `readonly` **INVALID\_IDP\_RESPONSE**: `"auth/invalid-credential"`

##### INVALID\_LOGIN\_CREDENTIALS

> `readonly` **INVALID\_LOGIN\_CREDENTIALS**: `"auth/invalid-credential"`

##### INVALID\_MESSAGE\_PAYLOAD

> `readonly` **INVALID\_MESSAGE\_PAYLOAD**: `"auth/invalid-message-payload"`

##### INVALID\_MFA\_SESSION

> `readonly` **INVALID\_MFA\_SESSION**: `"auth/invalid-multi-factor-session"`

##### INVALID\_OAUTH\_CLIENT\_ID

> `readonly` **INVALID\_OAUTH\_CLIENT\_ID**: `"auth/invalid-oauth-client-id"`

##### INVALID\_OAUTH\_PROVIDER

> `readonly` **INVALID\_OAUTH\_PROVIDER**: `"auth/invalid-oauth-provider"`

##### INVALID\_OOB\_CODE

> `readonly` **INVALID\_OOB\_CODE**: `"auth/invalid-action-code"`

##### INVALID\_ORIGIN

> `readonly` **INVALID\_ORIGIN**: `"auth/unauthorized-domain"`

##### INVALID\_PASSWORD

> `readonly` **INVALID\_PASSWORD**: `"auth/wrong-password"`

##### INVALID\_PERSISTENCE

> `readonly` **INVALID\_PERSISTENCE**: `"auth/invalid-persistence-type"`

##### INVALID\_PHONE\_NUMBER

> `readonly` **INVALID\_PHONE\_NUMBER**: `"auth/invalid-phone-number"`

##### INVALID\_PROVIDER\_ID

> `readonly` **INVALID\_PROVIDER\_ID**: `"auth/invalid-provider-id"`

##### INVALID\_RECAPTCHA\_ACTION

> `readonly` **INVALID\_RECAPTCHA\_ACTION**: `"auth/invalid-recaptcha-action"`

##### INVALID\_RECAPTCHA\_TOKEN

> `readonly` **INVALID\_RECAPTCHA\_TOKEN**: `"auth/invalid-recaptcha-token"`

##### INVALID\_RECAPTCHA\_VERSION

> `readonly` **INVALID\_RECAPTCHA\_VERSION**: `"auth/invalid-recaptcha-version"`

##### INVALID\_RECIPIENT\_EMAIL

> `readonly` **INVALID\_RECIPIENT\_EMAIL**: `"auth/invalid-recipient-email"`

##### INVALID\_REQ\_TYPE

> `readonly` **INVALID\_REQ\_TYPE**: `"auth/invalid-req-type"`

##### INVALID\_SENDER

> `readonly` **INVALID\_SENDER**: `"auth/invalid-sender"`

##### INVALID\_SESSION\_INFO

> `readonly` **INVALID\_SESSION\_INFO**: `"auth/invalid-verification-id"`

##### INVALID\_TENANT\_ID

> `readonly` **INVALID\_TENANT\_ID**: `"auth/invalid-tenant-id"`

##### MFA\_INFO\_NOT\_FOUND

> `readonly` **MFA\_INFO\_NOT\_FOUND**: `"auth/multi-factor-info-not-found"`

##### MFA\_REQUIRED

> `readonly` **MFA\_REQUIRED**: `"auth/multi-factor-auth-required"`

##### MISSING\_ANDROID\_PACKAGE\_NAME

> `readonly` **MISSING\_ANDROID\_PACKAGE\_NAME**: `"auth/missing-android-pkg-name"`

##### MISSING\_APP\_CREDENTIAL

> `readonly` **MISSING\_APP\_CREDENTIAL**: `"auth/missing-app-credential"`

##### MISSING\_AUTH\_DOMAIN

> `readonly` **MISSING\_AUTH\_DOMAIN**: `"auth/auth-domain-config-required"`

##### MISSING\_CLIENT\_TYPE

> `readonly` **MISSING\_CLIENT\_TYPE**: `"auth/missing-client-type"`

##### MISSING\_CODE

> `readonly` **MISSING\_CODE**: `"auth/missing-verification-code"`

##### MISSING\_CONTINUE\_URI

> `readonly` **MISSING\_CONTINUE\_URI**: `"auth/missing-continue-uri"`

##### MISSING\_IFRAME\_START

> `readonly` **MISSING\_IFRAME\_START**: `"auth/missing-iframe-start"`

##### MISSING\_IOS\_BUNDLE\_ID

> `readonly` **MISSING\_IOS\_BUNDLE\_ID**: `"auth/missing-ios-bundle-id"`

##### MISSING\_MFA\_INFO

> `readonly` **MISSING\_MFA\_INFO**: `"auth/missing-multi-factor-info"`

##### MISSING\_MFA\_SESSION

> `readonly` **MISSING\_MFA\_SESSION**: `"auth/missing-multi-factor-session"`

##### MISSING\_OR\_INVALID\_NONCE

> `readonly` **MISSING\_OR\_INVALID\_NONCE**: `"auth/missing-or-invalid-nonce"`

##### MISSING\_PASSWORD

> `readonly` **MISSING\_PASSWORD**: `"auth/missing-password"`

##### MISSING\_PHONE\_NUMBER

> `readonly` **MISSING\_PHONE\_NUMBER**: `"auth/missing-phone-number"`

##### MISSING\_RECAPTCHA\_TOKEN

> `readonly` **MISSING\_RECAPTCHA\_TOKEN**: `"auth/missing-recaptcha-token"`

##### MISSING\_RECAPTCHA\_VERSION

> `readonly` **MISSING\_RECAPTCHA\_VERSION**: `"auth/missing-recaptcha-version"`

##### MISSING\_SESSION\_INFO

> `readonly` **MISSING\_SESSION\_INFO**: `"auth/missing-verification-id"`

##### MODULE\_DESTROYED

> `readonly` **MODULE\_DESTROYED**: `"auth/app-deleted"`

##### NEED\_CONFIRMATION

> `readonly` **NEED\_CONFIRMATION**: `"auth/account-exists-with-different-credential"`

##### NETWORK\_REQUEST\_FAILED

> `readonly` **NETWORK\_REQUEST\_FAILED**: `"auth/network-request-failed"`

##### NO\_AUTH\_EVENT

> `readonly` **NO\_AUTH\_EVENT**: `"auth/no-auth-event"`

##### NO\_SUCH\_PROVIDER

> `readonly` **NO\_SUCH\_PROVIDER**: `"auth/no-such-provider"`

##### NULL\_USER

> `readonly` **NULL\_USER**: `"auth/null-user"`

##### OPERATION\_NOT\_ALLOWED

> `readonly` **OPERATION\_NOT\_ALLOWED**: `"auth/operation-not-allowed"`

##### OPERATION\_NOT\_SUPPORTED

> `readonly` **OPERATION\_NOT\_SUPPORTED**: `"auth/operation-not-supported-in-this-environment"`

##### POPUP\_BLOCKED

> `readonly` **POPUP\_BLOCKED**: `"auth/popup-blocked"`

##### POPUP\_CLOSED\_BY\_USER

> `readonly` **POPUP\_CLOSED\_BY\_USER**: `"auth/popup-closed-by-user"`

##### PROVIDER\_ALREADY\_LINKED

> `readonly` **PROVIDER\_ALREADY\_LINKED**: `"auth/provider-already-linked"`

##### QUOTA\_EXCEEDED

> `readonly` **QUOTA\_EXCEEDED**: `"auth/quota-exceeded"`

##### RECAPTCHA\_NOT\_ENABLED

> `readonly` **RECAPTCHA\_NOT\_ENABLED**: `"auth/recaptcha-not-enabled"`

##### REDIRECT\_CANCELLED\_BY\_USER

> `readonly` **REDIRECT\_CANCELLED\_BY\_USER**: `"auth/redirect-cancelled-by-user"`

##### REDIRECT\_OPERATION\_PENDING

> `readonly` **REDIRECT\_OPERATION\_PENDING**: `"auth/redirect-operation-pending"`

##### REJECTED\_CREDENTIAL

> `readonly` **REJECTED\_CREDENTIAL**: `"auth/rejected-credential"`

##### SECOND\_FACTOR\_ALREADY\_ENROLLED

> `readonly` **SECOND\_FACTOR\_ALREADY\_ENROLLED**: `"auth/second-factor-already-in-use"`

##### SECOND\_FACTOR\_LIMIT\_EXCEEDED

> `readonly` **SECOND\_FACTOR\_LIMIT\_EXCEEDED**: `"auth/maximum-second-factor-count-exceeded"`

##### TENANT\_ID\_MISMATCH

> `readonly` **TENANT\_ID\_MISMATCH**: `"auth/tenant-id-mismatch"`

##### TIMEOUT

> `readonly` **TIMEOUT**: `"auth/timeout"`

##### TOKEN\_EXPIRED

> `readonly` **TOKEN\_EXPIRED**: `"auth/user-token-expired"`

##### TOO\_MANY\_ATTEMPTS\_TRY\_LATER

> `readonly` **TOO\_MANY\_ATTEMPTS\_TRY\_LATER**: `"auth/too-many-requests"`

##### UNAUTHORIZED\_DOMAIN

> `readonly` **UNAUTHORIZED\_DOMAIN**: `"auth/unauthorized-continue-uri"`

##### UNSUPPORTED\_FIRST\_FACTOR

> `readonly` **UNSUPPORTED\_FIRST\_FACTOR**: `"auth/unsupported-first-factor"`

##### UNSUPPORTED\_PERSISTENCE

> `readonly` **UNSUPPORTED\_PERSISTENCE**: `"auth/unsupported-persistence-type"`

##### UNSUPPORTED\_TENANT\_OPERATION

> `readonly` **UNSUPPORTED\_TENANT\_OPERATION**: `"auth/unsupported-tenant-operation"`

##### UNVERIFIED\_EMAIL

> `readonly` **UNVERIFIED\_EMAIL**: `"auth/unverified-email"`

##### USER\_CANCELLED

> `readonly` **USER\_CANCELLED**: `"auth/user-cancelled"`

##### USER\_DELETED

> `readonly` **USER\_DELETED**: `"auth/user-not-found"`

##### USER\_DISABLED

> `readonly` **USER\_DISABLED**: `"auth/user-disabled"`

##### USER\_MISMATCH

> `readonly` **USER\_MISMATCH**: `"auth/user-mismatch"`

##### USER\_SIGNED\_OUT

> `readonly` **USER\_SIGNED\_OUT**: `"auth/user-signed-out"`

##### WEAK\_PASSWORD

> `readonly` **WEAK\_PASSWORD**: `"auth/weak-password"`

##### WEB\_STORAGE\_UNSUPPORTED

> `readonly` **WEB\_STORAGE\_UNSUPPORTED**: `"auth/web-storage-unsupported"`

***

### browserCookiePersistence

> `const` **browserCookiePersistence**: [`Persistence`](#persistence)

Cookie-backed, for SSR. The fourth member of upstream's
 `Persistence.type` union.

***

### browserLocalPersistence

> `const` **browserLocalPersistence**: [`Persistence`](#persistence)

`localStorage`-backed. Firebase's default.

***

### browserPopupRedirectResolver

> `const` **browserPopupRedirectResolver**: `object`

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

#### Type Declaration

##### \_pyricResolverToken

> `readonly` **\_pyricResolverToken**: `"browser-popup-redirect"`

***

### browserSessionPersistence

> `const` **browserSessionPersistence**: [`Persistence`](#persistence)

`sessionStorage`-backed.

***

### debugErrorMap

> `const` **debugErrorMap**: [`AuthErrorMap`](#autherrormap)

`debugErrorMap` — upstream's verbose map: full human-readable messages
on every auth error, at the cost of bundle size.

The sandbox ALWAYS throws with a full message (see `auth-errors.ts`:
every `makeAuthError` call site passes real prose), so the debug map is
effectively already in force and installing it changes nothing. Exported
as an accepted no-op token.

***

### FEDERATED\_PROVIDER\_IDS

> `const` **FEDERATED\_PROVIDER\_IDS**: readonly \[`"google.com"`, `"apple.com"`, `"facebook.com"`, `"github.com"`, `"twitter.com"`, `"microsoft.com"`, `"yahoo.com"`\]

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

### indexedDBLocalPersistence

> `const` **indexedDBLocalPersistence**: [`Persistence`](#persistence)

IndexedDB-backed. Long-term, same observable class as
 `browserLocalPersistence` — hence the shared `'LOCAL'` type.

***

### inMemoryPersistence

> `const` **inMemoryPersistence**: [`Persistence`](#persistence)

No persistence — session dies with the tab.

***

### OperationType

> `const` **OperationType**: `object`

What produced a `UserCredential`. Mirrors `firebase/auth`'s
`OperationType` — the discriminant `signInWith*` / `linkWith*` /
`reauthenticateWith*` set on their results.

`SIGN_IN` is `'signIn'`, NOT `'register'`: a fresh
`createUserWithEmailAndPassword` also reports `'signIn'`. Oracle:
`observations/auth/auth-createUser-operationType.json`.

#### Type Declaration

##### LINK

> `readonly` **LINK**: `"link"`

##### REAUTHENTICATE

> `readonly` **REAUTHENTICATE**: `"reauthenticate"`

##### SIGN\_IN

> `readonly` **SIGN\_IN**: `"signIn"`

***

### prodErrorMap

> `const` **prodErrorMap**: [`AuthErrorMap`](#autherrormap)

`prodErrorMap` — upstream's minified map: error codes without the
message text, to save bytes in production builds.

NOT honored, deliberately. Installing it upstream STRIPS the messages;
doing that in a sandbox whose entire purpose is to tell a developer what
went wrong would be actively hostile. Accepted and ignored — the sandbox
keeps throwing full messages.

***

### ProviderId

> `const` **ProviderId**: `object`

Aggregate provider ids. Mirrors `firebase/auth`'s `ProviderId`.

Note the shape upstream chose: the anonymous and custom-token sign-in
paths have NO entry here (they are not federated identity providers),
which is why [UserCredential.providerId](#providerid-15) is `null` for both.

#### Type Declaration

##### FACEBOOK

> `readonly` **FACEBOOK**: `"facebook.com"`

##### GITHUB

> `readonly` **GITHUB**: `"github.com"`

##### GOOGLE

> `readonly` **GOOGLE**: `"google.com"`

##### PASSWORD

> `readonly` **PASSWORD**: `"password"`

##### PHONE

> `readonly` **PHONE**: `"phone"`

##### TWITTER

> `readonly` **TWITTER**: `"twitter.com"`

***

### sandbox

> `const` **sandbox**: `object`

Sandbox-only lifecycle / test-driver surface. Every operation requires
an Auth handle produced by this mirror.

**Naming note:** the `sandbox` export name collides with the
common `const sandbox = initializeSandbox()` local. Alias on
import if both are in scope:

```ts
import { sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
authSandbox.seedUsers(auth, […]);
```

#### Type Declaration

##### assertAuthProviderEnabled()

> **assertAuthProviderEnabled**(`auth`, `providerId`): `void`

Assert a provider is enabled — throws `auth/operation-not-allowed`
(the exact gate every provider entry point uses) when it is off.
For hosts that ARE the enforcement authority for identities
resolved elsewhere: the served SharedWorker calls this before
accepting a page-resolved popup/redirect identity
(`auth.acceptIdentity`), so Studio's provider toggles gate served
OAuth sign-in at the shared backend, not at each page's UI shim.

###### Parameters

###### auth

[`Auth`](#auth)

###### providerId

`string`

###### Returns

`void`

##### clearUsers()

> **clearUsers**(`auth`): `void`

Drop every user record — the emulator's "delete all accounts".

###### Parameters

###### auth

[`Auth`](#auth)

###### Returns

`void`

##### createSignInCredential()

> **createSignInCredential**(`auth`, `request`): [`UserCredential`](#usercredential)

Mint a sign-in credential for a host-driven flow — the account
picker's "pick existing" (`{providerId, uid}`) and "add account"
(`{providerId, spec}`) actions. Token + claims synthesis is
backend-owned (routed through the same token cache as every
other sign-in), replacing host-synthesized token strings.

The credential does NOT sign anyone in — resolve the pending
`AuthFlowResolver` promise with it and the in-flight
`signInWithPopup` / `signInWithRedirect` completes the sign-in.

###### Parameters

###### auth

[`Auth`](#auth)

###### request

\{ `providerId`: `string`; `uid`: `string`; \} | \{ `providerId`: `string`; `spec`: [`SignInIdentitySpec`](#signinidentityspec); \}

###### Returns

[`UserCredential`](#usercredential)

##### createUser()

> **createUser**(`auth`, `request`): [`AuthUserRecord`](#authuserrecord)

Create a user without signing them in (admin semantics — the
client-mirror `createUserWithEmailAndPassword` is the
signs-you-in variant). Throws `auth/uid-already-exists`,
`auth/email-already-in-use`, `auth/invalid-email`,
`auth/weak-password` on bad input.

###### Parameters

###### auth

[`Auth`](#auth)

###### request

[`CreateUserRequest`](#createuserrequest)

###### Returns

[`AuthUserRecord`](#authuserrecord)

##### delegateProviderEnforcement()

> **delegateProviderEnforcement**(`auth`, `delegated`): `void`

Delegate (or reclaim) THIS handle's provider-enablement gate to a
remote authority. Serve-layer wiring: in SharedWorker mode the
page-local sandbox is only the UI vehicle for popup/redirect
resolution — the worker's `auth.acceptIdentity` gate (against the
worker's own, undelegated config) is the real toggle enforcement —
so the served `firebase/auth` entry sets `true` on the in-page
handle to let the picker open regardless of local defaults. Do NOT
set this on a backend that is itself the authority.

###### Parameters

###### auth

[`Auth`](#auth)

###### delegated

`boolean`

###### Returns

`void`

##### deleteUser()

> **deleteUser**(`auth`, `uid`): `void`

Delete a user record. Throws `auth/user-not-found` for unknown
 uids. Active sessions are not terminated (prod parity).

###### Parameters

###### auth

[`Auth`](#auth)

###### uid

`string`

###### Returns

`void`

##### exportUsers()

> **exportUsers**(`auth`): [`SeedUser`](#seeduser)[]

Export the user DB in the exact shape [sandbox.seedUsers](#seedusers)
accepts — `exportUsers` → `seedUsers` round-trips losslessly (the
persistence substrate, the design rationale section 3c).
Provider-flow identities without a password export with a documented
sentinel; anonymous users are not exported (ephemeral by design).

###### Parameters

###### auth

[`Auth`](#auth)

###### Returns

[`SeedUser`](#seeduser)[]

##### getAuthProviderConfig()

> **getAuthProviderConfig**(`auth`): `object`[]

Every provider this sandbox has an explicit enablement for —
seeded defaults (`password`, `anonymous` — both `true`) plus
anything toggled via [sandbox.setAuthProviderConfig](#setauthproviderconfig). Every
OTHER providerId (`google.com`, a custom OAuth id, …) is disabled
until explicitly enabled.

###### Parameters

###### auth

[`Auth`](#auth)

###### Returns

`object`[]

##### listAuthMail()

> **listAuthMail**(`auth`): [`OutboundAuthMail`](#outboundauthmail)[]

Every message currently in the outbox, oldest first.
 Non-destructive — unlike [sandbox.takeAuthMail](#takeauthmail).

###### Parameters

###### auth

[`Auth`](#auth)

###### Returns

[`OutboundAuthMail`](#outboundauthmail)[]

##### listIdentities()

> **listIdentities**(`auth`): `object`[]

Snapshot every known identity (seeded + created), for a host
account-picker UI. Sandbox-only — no `firebase/auth` equivalent.

###### Parameters

###### auth

[`Auth`](#auth)

###### Returns

`object`[]

##### listUsers()

> **listUsers**(`auth`): [`AuthUserRecord`](#authuserrecord)[]

Every user in the sandbox user DB (seeded, created,
signed-in-via-provider, anonymous) as [AuthUserRecord](#authuserrecord)s.
Snapshot — subscribe to changes via [sandbox.subscribeUsers](#subscribeusers).

###### Parameters

###### auth

[`Auth`](#auth)

###### Returns

[`AuthUserRecord`](#authuserrecord)[]

##### mintSession()

> **mintSession**(`auth`, `request`): [`MintedSession`](#mintedsession)

Mint a session identity WITHOUT signing it in globally — the
substrate for **per-connection identity** at the serve layer
(issue #754): one shared sandbox, N connections (tabs / clients),
each with its own authenticated session. Performs a real sign-in's
bookkeeping (provider record, `lastLoginAt`, a fresh token, the
`sign_in` activity event) but leaves `auth.currentUser`, the
auth-state listeners, and session persistence untouched.

Returns the `User` plus the `AuthState` its data contexts should
carry — `getFirestore(sandbox.withAuth(session.state))` evaluates
rules exactly as a real sign-in would (`request.auth.uid` +
custom claims on `request.auth.token`).

This is an AUTHENTIC session (credentials are validated / an
identity is really minted) — distinct from the rules-debugging
impersonation lens, which asserts a uid without authenticating.

###### Parameters

###### auth

[`Auth`](#auth)

###### request

[`MintSessionRequest`](#mintsessionrequest)

###### Returns

[`MintedSession`](#mintedsession)

##### mockActionCode()

> **mockActionCode**(`auth`, `code`, `spec`): `void`

Pre-stage an out-of-band action code with a KNOWN value — the
action-code tier of the same "stage a result" pattern
[sandbox.mockSignInResult](#mocksigninresult) uses for OAuth.

Two things this buys that the mail outbox cannot:
  - a code whose string the test chose, so an assertion can name it;
  - `expired: true`, which makes the `auth/expired-action-code` branch
    reachable without waiting out a real TTL. That branch is otherwise
    untestable, in the sandbox AND in production.

###### Parameters

###### auth

[`Auth`](#auth)

###### code

`string`

###### spec

`AuthActionCode`

###### Returns

`void`

##### mockSignInResult()

> **mockSignInResult**(`auth`, `result`): `void`

Pre-stage the result that the next `signInWithPopup` /
`signInWithCredential` call for the matching `providerId`
returns. The one-shot tier of the resolver precedence (used when no
resolver is injected) — consumed by the next sign-in call; stage
again for repeat tests.

###### Parameters

###### auth

[`Auth`](#auth)

###### result

[`UserCredential`](#usercredential)

###### Returns

`void`

##### restoreSession()

> **restoreSession**(`auth`, `uid`): [`User`](#user-1)

Re-establish a signed-in session for an EXISTING identity — the
substrate behind web-storage session persistence at the host layer.
Fires auth-state listeners like a real restored session. Throws
`auth/user-not-found` for unknown uids, `auth/user-disabled` for
disabled accounts (a restore is a sign-in).

###### Parameters

###### auth

[`Auth`](#auth)

###### uid

`string`

###### Returns

[`User`](#user-1)

##### seedUsers()

> **seedUsers**(`auth`, `users`): `void`

Bulk-load test users for email/password lookup. Idempotent for
a given uid+email — re-seeding the same uid overwrites.

###### Parameters

###### auth

[`Auth`](#auth)

###### users

readonly [`SeedUser`](#seeduser)[]

###### Returns

`void`

##### setAuthFlowResolver()

> **setAuthFlowResolver**(`auth`, `resolver`): `void`

Install the popup/redirect resolver — the analog of browser
`getAuth` wiring `browserPopupRedirectResolver`. The host
(playground) sets this once; `signInWithPopup` / `signInWithRedirect`
then delegate the experience to it. Pass `null` to clear.

Precedence at sign-in time: a per-call resolver arg wins, then this
injected one, then a one-shot `mockSignInResult`, else
`auth/argument-error`.

###### Parameters

###### auth

[`Auth`](#auth)

###### resolver

[`AuthFlowResolver`](#authflowresolver)

###### Returns

`void`

##### setAuthMailResolver()

> **setAuthMailResolver**(`auth`, `resolver`): `void`

Install the auth MAIL resolver — the email family's analog of
[sandbox.setAuthFlowResolver](#setauthflowresolver). Notified for every message the
sandbox's mail server emits (a sign-in link, a password reset, a
verification link). A host (the playground) installs one to surface
the link in its UI. Pass `null` to clear.

Advisory, not a gate: the message lands in the outbox whether or not
a resolver is installed, and a throwing resolver does not fail the
`sendPasswordResetEmail` that produced it. Read the outbox with
[sandbox.takeAuthMail](#takeauthmail).

###### Parameters

###### auth

[`Auth`](#auth)

###### resolver

[`AuthMailResolver`](#authmailresolver)

###### Returns

`void`

##### setAuthProviderConfig()

> **setAuthProviderConfig**(`auth`, `providerId`, `enabled`): `void`

Enable/disable a sign-in provider. Gated at every provider entry
point of the ENFORCING backend (`signInWithPopup`/`signInWithRedirect`,
`signInWithCredential`, `createUserWithEmailAndPassword`/
`signInWithEmailAndPassword` for `'password'`, `signInAnonymously`
for `'anonymous'`) — disabling a provider makes the matching sign-in
call throw real Firebase's `auth/operation-not-allowed`, exactly
like flipping the toggle off in the real console. Survives
`enablePersistence` round-trips (rides the `auth` service's
snapshot alongside the user DB). A backend whose enforcement is
delegated ([sandbox.delegateProviderEnforcement](#delegateproviderenforcement)) does NOT
gate locally — the remote authority it fronts does.

###### Parameters

###### auth

[`Auth`](#auth)

###### providerId

`string`

###### enabled

`boolean`

###### Returns

`void`

##### setUser()

> **setUser**(`auth`, `user`): `void`

Force the current user (and emit to listeners). Pass `null` to
sign out. Bypasses the email/password lookup — useful for
driving auth state directly in tests without seeding.

###### Parameters

###### auth

[`Auth`](#auth)

###### user

[`User`](#user-1)

###### Returns

`void`

##### subscribeAuthProviderConfig()

> **subscribeAuthProviderConfig**(`auth`, `callback`): [`Unsubscribe`](#unsubscribe)

Subscribe to provider-config mutations. Coarse contract: no
payload, no initial fire — re-read via
[sandbox.getAuthProviderConfig](#getauthproviderconfig) in the callback (same shape
as [sandbox.subscribeUsers](#subscribeusers)).

###### Parameters

###### auth

[`Auth`](#auth)

###### callback

() => `void`

###### Returns

[`Unsubscribe`](#unsubscribe)

##### subscribeUsers()

> **subscribeUsers**(`auth`, `callback`): [`Unsubscribe`](#unsubscribe)

Subscribe to user-DB mutations (seed / create / update / delete /
clear / provider links / lastLoginAt bumps). Coarse contract: no
payload, no initial fire — re-list via [sandbox.listUsers](#listusers)
in the callback.

###### Parameters

###### auth

[`Auth`](#auth)

###### callback

() => `void`

###### Returns

[`Unsubscribe`](#unsubscribe)

##### takeAuthMail()

> **takeAuthMail**(`auth`, `email?`): [`OutboundAuthMail`](#outboundauthmail)

Read and remove the oldest message from the sandbox's mail outbox,
optionally for one recipient. THE PROGRAM'S SUBSTITUTE FOR A HUMAN
OPENING THEIR INBOX — and the reason the email-link flow can be
driven end to end here when it cannot be in production:

```ts
await sendSignInLinkToEmail(auth, 'ada@example.com', settings);
const mail = authSandbox.takeAuthMail(auth);  // the "inbox"
await signInWithEmailLink(auth, 'ada@example.com', mail!.link);
```

The code in that message is the REAL code the redemption consumes —
nothing here is faked except the human. Returns `null` when the
outbox is empty.

###### Parameters

###### auth

[`Auth`](#auth)

###### email?

`string`

###### Returns

[`OutboundAuthMail`](#outboundauthmail)

##### updateProfile()

> **updateProfile**(`auth`, `uid`, `profile`): [`AuthUserRecord`](#authuserrecord)

Update a user's PROFILE (`displayName` / `photoURL`) by uid — the
backend behind the served worker path's `updateProfile`. `undefined`
fields untouched; `null` clears. Returns the refreshed record; throws
`auth/user-not-found` for an unknown uid. (The client-facing
`updateProfile(user, …)` free function is the app-code surface; this is
the by-uid op the SharedWorker host calls.)

###### Parameters

###### auth

[`Auth`](#auth)

###### uid

`string`

###### profile

###### displayName?

`string` \| `null`

###### photoURL?

`string` \| `null`

###### Returns

[`AuthUserRecord`](#authuserrecord)

##### updateUser()

> **updateUser**(`auth`, `uid`, `update`): [`AuthUserRecord`](#authuserrecord)

Update a user. `undefined` fields untouched; `customClaims`
replaces the whole map; setting `disabled: true` blocks future
sign-ins with `auth/user-disabled` (active sessions continue —
same as prod until token revocation).

###### Parameters

###### auth

[`Auth`](#auth)

###### uid

`string`

###### update

[`UpdateUserRequest`](#updateuserrequest)

###### Returns

[`AuthUserRecord`](#authuserrecord)

***

### SignInMethod

> `const` **SignInMethod**: `object`

Sign-in method ids. Mirrors `firebase/auth`'s `SignInMethod`.

Distinct from [ProviderId](#providerid-18) precisely because one provider can
carry several methods: `EmailAuthProvider` (`'password'`) signs in
with EITHER `EMAIL_PASSWORD` (`'password'`) or `EMAIL_LINK`
(`'emailLink'`). That split is what `AuthCredential.signInMethod`
discriminates, and it is what the email-link family turns on.

#### Type Declaration

##### EMAIL\_LINK

> `readonly` **EMAIL\_LINK**: `"emailLink"`

##### EMAIL\_PASSWORD

> `readonly` **EMAIL\_PASSWORD**: `"password"`

##### FACEBOOK

> `readonly` **FACEBOOK**: `"facebook.com"`

##### GITHUB

> `readonly` **GITHUB**: `"github.com"`

##### GOOGLE

> `readonly` **GOOGLE**: `"google.com"`

##### PHONE

> `readonly` **PHONE**: `"phone"`

##### TWITTER

> `readonly` **TWITTER**: `"twitter.com"`

***

### TARGET\_SYMBOL

> `const` **TARGET\_SYMBOL**: unique `symbol`

Branded handle for [Auth](#auth). Set on every handle returned by
 [getAuth](#getauth); consumers don't read it. Exposed only so the
 dispatch helpers in this package can recover routing without a
 WeakMap lookup.

## Functions

### applyActionCode()

> **applyActionCode**(`auth`, `code`): `Promise`\<`void`\>

`applyActionCode(auth, code)` — mirror of `firebase/auth`. Redeems a
code and performs its state change.

`auth/invalid-action-code` for a code the sandbox never issued —
ORACLE-BACKED (`auth-action-code-invalid` captured exactly this
against prod, for both a bogus code and the empty string).
`auth/expired-action-code` for a code staged as expired.

Single-use: the code is burned on redemption, so a replay throws
`auth/invalid-action-code` — matching prod.

#### Parameters

##### auth

[`Auth`](#auth)

##### code

`string`

#### Returns

`Promise`\<`void`\>

***

### beforeAuthStateChanged()

> **beforeAuthStateChanged**(`auth`, `callback`, `onAbort?`): [`Unsubscribe`](#unsubscribe)

Top-level mirror of `firebase/auth`'s `beforeAuthStateChanged(auth,
callback, onAbort?)` — a BLOCKING gate that runs before a real
sign-in/sign-out transition commits. Registered callbacks run in
registration order; if one throws (or its returned promise rejects),
the transition is aborted: the pending `signInWith…` / `signOut`
call rejects with `auth/login-blocked`, `currentUser` is left
unchanged, and `onAuthStateChanged` / `onIdTokenChanged` do NOT fire.
Every `onAbort` registered by a callback that already ran
successfully in this pass is invoked (in reverse registration order)
so side effects can be undone.

Fires for both directions — a real sign-in (`nextUser` non-null) and
a real sign-out (`nextUser === null`). Does NOT fire for
`sandbox.setUser` — that test driver bypasses the gate the same way
it bypasses provider enforcement (no prod analog; see its doc
comment under [sandbox](#sandbox)).

Sandbox target only runs one queue per `Auth` handle — mirrors
upstream, where the queue lives on the `AuthImpl` instance.

#### Parameters

##### auth

[`Auth`](#auth)

##### callback

(`user`) => `void` \| `Promise`\<`void`\>

##### onAbort?

() => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### checkActionCode()

> **checkActionCode**(`auth`, `code`): `Promise`\<[`ActionCodeInfo`](#actioncodeinfo)\>

`checkActionCode(auth, code)` — mirror of `firebase/auth`. Inspects a
code WITHOUT redeeming it, so the subsequent `applyActionCode` /
`confirmPasswordReset` still finds it. Throws
`auth/invalid-action-code` / `auth/expired-action-code` for a code
that is not live.

#### Parameters

##### auth

[`Auth`](#auth)

##### code

`string`

#### Returns

`Promise`\<[`ActionCodeInfo`](#actioncodeinfo)\>

***

### confirmPasswordReset()

> **confirmPasswordReset**(`auth`, `code`, `newPassword`): `Promise`\<`void`\>

`confirmPasswordReset(auth, code, newPassword)` — mirror of
`firebase/auth`. Redeems a reset code and sets the new password.

Real behavior on the sandbox: afterwards
`signInWithEmailAndPassword(auth, email, newPassword)` succeeds and
the OLD password throws `auth/wrong-password`. The new password runs
the same strength check `createUserWithEmailAndPassword` does, so a
reset cannot install a password the create path would have rejected
(`auth/weak-password`).

#### Parameters

##### auth

[`Auth`](#auth)

##### code

`string`

##### newPassword

`string`

#### Returns

`Promise`\<`void`\>

***

### connectAuthEmulator()

> **connectAuthEmulator**(`auth`, `url`, `options?`): `void`

`connectAuthEmulator(auth, url, options?)` is a no-op because the mirror is
already the sandbox.

Same signature as upstream so canonical consumer code keeps working
when package resolution selects this mirror.

#### Parameters

##### auth

[`Auth`](#auth)

##### url

`string`

##### options?

###### disableWarnings?

`boolean`

#### Returns

`void`

***

### createUserWithEmailAndPassword()

> **createUserWithEmailAndPassword**(`auth`, `email`, `password`): `Promise`\<[`UserCredential`](#usercredential)\>

#### Parameters

##### auth

[`Auth`](#auth)

##### email

`string`

##### password

`string`

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### deleteUser()

> **deleteUser**(`user`): `Promise`\<`void`\>

Top-level mirror of `firebase/auth`'s `deleteUser(user)`. Deletes the
account from the store and signs the user out if they are the current
user (fires `onAuthStateChanged(null)`) — matching prod, where deleting
the signed-in user clears `auth.currentUser`. Real behavior on the
sandbox: a subsequent `signInWithEmailAndPassword` for that identity
throws `auth/user-not-found`.

Routes through the hidden USER\_INTERNAL hook (user-only
signature, no `auth` handle) to the owning sandbox.

#### Parameters

##### user

[`User`](#user-1)

#### Returns

`Promise`\<`void`\>

***

### getAdditionalUserInfo()

> **getAdditionalUserInfo**(`userCredential`): [`AdditionalUserInfo`](#additionaluserinfo)

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

##### userCredential

[`UserCredential`](#usercredential)

#### Returns

[`AdditionalUserInfo`](#additionaluserinfo)

***

### getAuth()

#### Call Signature

> **getAuth**(): [`Auth`](#auth)

Construct a sandbox-backed [Auth](#auth) handle. `getAuth()` uses the
default sandbox app initialized through the package-resolution adapter;
`getAuth(app)` unwraps that app; and `getAuth(sandbox)` binds directly.
Repeat calls for the same sandbox return the same handle.

##### Returns

[`Auth`](#auth)

##### Example

```ts
// Sandbox.
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
await signInAnonymously(auth);

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
const app = initializeApp({ projectId: 'demo-project' });
const auth = getAuth(app);
```

#### Call Signature

> **getAuth**(`sandbox`): [`Auth`](#auth)

Construct a sandbox-backed [Auth](#auth) handle. `getAuth()` uses the
default sandbox app initialized through the package-resolution adapter;
`getAuth(app)` unwraps that app; and `getAuth(sandbox)` binds directly.
Repeat calls for the same sandbox return the same handle.

##### Parameters

###### sandbox

`Sandbox`

##### Returns

[`Auth`](#auth)

##### Example

```ts
// Sandbox.
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
await signInAnonymously(auth);

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
const app = initializeApp({ projectId: 'demo-project' });
const auth = getAuth(app);
```

#### Call Signature

> **getAuth**(`app`): [`Auth`](#auth)

Construct a sandbox-backed [Auth](#auth) handle. `getAuth()` uses the
default sandbox app initialized through the package-resolution adapter;
`getAuth(app)` unwraps that app; and `getAuth(sandbox)` binds directly.
Repeat calls for the same sandbox return the same handle.

##### Parameters

###### app

`PyricApp`

##### Returns

[`Auth`](#auth)

##### Example

```ts
// Sandbox.
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
await signInAnonymously(auth);

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
const app = initializeApp({ projectId: 'demo-project' });
const auth = getAuth(app);
```

#### Call Signature

> **getAuth**(`target?`): [`Auth`](#auth)

Construct a sandbox-backed [Auth](#auth) handle. `getAuth()` uses the
default sandbox app initialized through the package-resolution adapter;
`getAuth(app)` unwraps that app; and `getAuth(sandbox)` binds directly.
Repeat calls for the same sandbox return the same handle.

##### Parameters

###### target?

`any`

##### Returns

[`Auth`](#auth)

##### Example

```ts
// Sandbox.
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
await signInAnonymously(auth);

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
const app = initializeApp({ projectId: 'demo-project' });
const auth = getAuth(app);
```

***

### getIdToken()

> **getIdToken**(`user`, `forceRefresh?`): `Promise`\<`string`\>

Top-level mirror of `firebase/auth`'s `getIdToken(user)`. Delegates
to the method on the sandbox user handle.

Parity provenance: W1.5 grid (2026-06-10) — generated apps import
the modular free function, and its absence failed every render of
the claims-driven fixtures.

#### Parameters

##### user

[`User`](#user-1)

##### forceRefresh?

`boolean`

#### Returns

`Promise`\<`string`\>

***

### getIdTokenResult()

> **getIdTokenResult**(`user`, `forceRefresh?`): `Promise`\<[`IdTokenResult`](#idtokenresult)\>

Top-level mirror of `firebase/auth`'s `getIdTokenResult(user)`.

#### Parameters

##### user

[`User`](#user-1)

##### forceRefresh?

`boolean`

#### Returns

`Promise`\<[`IdTokenResult`](#idtokenresult)\>

***

### getRedirectResult()

> **getRedirectResult**(`auth`, `_resolver?`): `Promise`\<[`UserCredential`](#usercredential)\>

#### Parameters

##### auth

[`Auth`](#auth)

##### \_resolver?

[`AuthFlowResolver`](#authflowresolver)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### initializeAuth()

> **initializeAuth**(`app`, `deps?`): [`Auth`](#auth)

`initializeAuth(app, deps?)` — mirror of `firebase/auth`'s explicit
initializer. Aliases [getAuth](#getauth): returns the same stable `Auth`
handle for the app, so an app that calls `initializeAuth` instead of
`getAuth` gets an equivalent, working instance.

The optional `Dependencies` argument (persistence / popupRedirectResolver)
is accepted for signature parity but not applied — persistence is already
a documented no-op in the sandbox model (`setPersistence`, the persistence
markers), so there is nothing new to configure. Unlike prod, calling this
twice for the same app does NOT throw `auth/already-initialized`; it
returns the cached handle (same leniency as repeated `getAuth`).

#### Parameters

##### app

`any`

##### deps?

`unknown`

#### Returns

[`Auth`](#auth)

***

### isSignInWithEmailLink()

> **isSignInWithEmailLink**(`auth`, `link`): `boolean`

`isSignInWithEmailLink(auth, link)` — mirror of `firebase/auth`.

A pure predicate over the string: no network, no project, no state.
True iff the link parses AND its operation is `EMAIL_SIGNIN`. Never
throws — garbage in, `false` out. Oracle-pinned on all five cases the
capture covers.

`auth` is unused (upstream takes it for signature symmetry and tenant
plumbing, neither of which changes the answer) but is kept in the
signature so consumer code is identical across the two SDKs.

#### Parameters

##### auth

[`Auth`](#auth)

##### link

`string`

#### Returns

`boolean`

***

### linkWithCredential()

> **linkWithCredential**(`user`, `credential`): `Promise`\<[`UserCredential`](#usercredential)\>

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

##### user

[`User`](#user-1)

##### credential

[`AuthCredential`](#authcredential)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### linkWithPopup()

> **linkWithPopup**(`user`, `provider`, `resolver?`): `Promise`\<[`UserCredential`](#usercredential)\>

`linkWithPopup(user, provider, resolver?)` — mirror of `firebase/auth`.

Runs the SAME resolver seam as `signInWithPopup`, with
`authType: 'link'` so a host UI can tell the two apart and say "link
your Google account" rather than "sign in". The resolved credential
names the provider to attach; the sandbox performs the attach.

#### Parameters

##### user

[`User`](#user-1)

##### provider

[`AuthProvider`](#authprovider)

##### resolver?

[`AuthFlowResolver`](#authflowresolver)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### linkWithRedirect()

> **linkWithRedirect**(`user`, `provider`, `resolver?`): `Promise`\<[`UserCredential`](#usercredential)\>

`linkWithRedirect(user, provider, resolver?)` — mirror of
`firebase/auth`. The sandbox has no navigation, so the resolver
resolves inline and the link completes immediately — the same
simplification `signInWithRedirect` makes, and the same observable
outcome a real redirect produces once it returns.

#### Parameters

##### user

[`User`](#user-1)

##### provider

[`AuthProvider`](#authprovider)

##### resolver?

[`AuthFlowResolver`](#authflowresolver)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### onAuthStateChanged()

> **onAuthStateChanged**(`auth`, `observer`): [`Unsubscribe`](#unsubscribe)

#### Parameters

##### auth

[`Auth`](#auth)

##### observer

[`AuthObserver`](#authobserver)

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### onIdTokenChanged()

> **onIdTokenChanged**(`auth`, `observer`): [`Unsubscribe`](#unsubscribe)

#### Parameters

##### auth

[`Auth`](#auth)

##### observer

[`AuthObserver`](#authobserver)

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### parseActionCodeURL()

> **parseActionCodeURL**(`link`): [`ActionCodeURL`](#actioncodeurl)

`parseActionCodeURL(link)` — free-function mirror of
[ActionCodeURL.parseLink](#parselink). Upstream ships both and they agree;
the oracle capture asserts that agreement
(`parseActionCodeURLAgrees: true`).

#### Parameters

##### link

`string`

#### Returns

[`ActionCodeURL`](#actioncodeurl)

***

### reauthenticateWithCredential()

> **reauthenticateWithCredential**(`user`, `credential`): `Promise`\<[`UserCredential`](#usercredential)\>

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

##### user

[`User`](#user-1)

##### credential

[`AuthCredential`](#authcredential)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### reauthenticateWithPopup()

> **reauthenticateWithPopup**(`user`, `provider`, `resolver?`): `Promise`\<[`UserCredential`](#usercredential)\>

`reauthenticateWithPopup(user, provider, resolver?)` — mirror of
`firebase/auth`. Runs the shared resolver seam with
`authType: 'reauth'`, so a host UI can present "confirm it's you"
rather than a fresh sign-in.

The resolved credential must be for THE SAME user — a resolver that
hands back a different uid throws `auth/user-mismatch`. Without that
check, "re-authentication" would accept anyone.

#### Parameters

##### user

[`User`](#user-1)

##### provider

[`AuthProvider`](#authprovider)

##### resolver?

[`AuthFlowResolver`](#authflowresolver)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### reauthenticateWithRedirect()

> **reauthenticateWithRedirect**(`user`, `provider`, `resolver?`): `Promise`\<[`UserCredential`](#usercredential)\>

`reauthenticateWithRedirect(user, provider, resolver?)` — mirror of
`firebase/auth`. Resolves inline (the sandbox has no navigation), same
as `signInWithRedirect`.

#### Parameters

##### user

[`User`](#user-1)

##### provider

[`AuthProvider`](#authprovider)

##### resolver?

[`AuthFlowResolver`](#authflowresolver)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### reload()

> **reload**(`user`): `Promise`\<`void`\>

Top-level mirror of `firebase/auth`'s `reload(user)`. Re-reads the stored
record into the `user` object in place so out-of-band changes (e.g.
`sandbox.updateUser`) are reflected — matching prod's server refresh.
After `deleteUser`, rejects with `auth/user-token-expired`.

#### Parameters

##### user

[`User`](#user-1)

#### Returns

`Promise`\<`void`\>

***

### revokeAccessToken()

> **revokeAccessToken**(`auth`, `token`): `Promise`\<`void`\>

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

##### auth

[`Auth`](#auth)

##### token

`string`

#### Returns

`Promise`\<`void`\>

***

### sendEmailVerification()

> **sendEmailVerification**(`user`, `settings?`): `Promise`\<`void`\>

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

##### user

[`User`](#user-1)

##### settings?

[`ActionCodeSettings`](#actioncodesettings)

#### Returns

`Promise`\<`void`\>

***

### sendPasswordResetEmail()

> **sendPasswordResetEmail**(`auth`, `email`, `settings?`): `Promise`\<`void`\>

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

##### auth

[`Auth`](#auth)

##### email

`string`

##### settings?

[`ActionCodeSettings`](#actioncodesettings)

#### Returns

`Promise`\<`void`\>

***

### sendSignInLinkToEmail()

> **sendSignInLinkToEmail**(`auth`, `email`, `settings`): `Promise`\<`void`\>

`sendSignInLinkToEmail(auth, email, settings)` — mirror of
`firebase/auth`.

`settings.url` is REQUIRED and `settings.handleCodeInApp` must be
`true` — both enforced client-side, both oracle-pinned (see the file
docstring). Unlike `sendPasswordResetEmail`, this one does NOT require
an existing account: sending a sign-in link to an unknown address is
the sign-UP path, and the account is created when the link is redeemed.

#### Parameters

##### auth

[`Auth`](#auth)

##### email

`string`

##### settings

[`ActionCodeSettings`](#actioncodesettings)

#### Returns

`Promise`\<`void`\>

***

### setPersistence()

> **setPersistence**(`auth`, `persistence`): `Promise`\<`void`\>

#### Parameters

##### auth

[`Auth`](#auth)

##### persistence

[`Persistence`](#persistence)

#### Returns

`Promise`\<`void`\>

***

### signInAnonymously()

> **signInAnonymously**(`auth`): `Promise`\<[`UserCredential`](#usercredential)\>

#### Parameters

##### auth

[`Auth`](#auth)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### signInWithCredential()

> **signInWithCredential**(`auth`, `credential`): `Promise`\<[`UserCredential`](#usercredential)\>

#### Parameters

##### auth

[`Auth`](#auth)

##### credential

[`AuthCredential`](#authcredential)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### signInWithCustomToken()

> **signInWithCustomToken**(`auth`, `customToken`): `Promise`\<[`UserCredential`](#usercredential)\>

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

##### auth

[`Auth`](#auth)

##### customToken

`string`

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### signInWithEmailAndPassword()

> **signInWithEmailAndPassword**(`auth`, `email`, `password`): `Promise`\<[`UserCredential`](#usercredential)\>

#### Parameters

##### auth

[`Auth`](#auth)

##### email

`string`

##### password

`string`

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### signInWithEmailLink()

> **signInWithEmailLink**(`auth`, `email`, `link`): `Promise`\<[`UserCredential`](#usercredential)\>

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

##### auth

[`Auth`](#auth)

##### email

`string`

##### link

`string`

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### signInWithPopup()

> **signInWithPopup**(`auth`, `provider`, `resolver?`): `Promise`\<[`UserCredential`](#usercredential)\>

The optional `resolver` argument is a sandbox-only injection seam.
Production imports remain on `firebase/auth`, which owns its platform
resolver independently.

#### Parameters

##### auth

[`Auth`](#auth)

##### provider

[`AuthProvider`](#authprovider)

##### resolver?

[`AuthFlowResolver`](#authflowresolver)

#### Returns

`Promise`\<[`UserCredential`](#usercredential)\>

***

### signInWithRedirect()

> **signInWithRedirect**(`auth`, `provider`, `resolver?`): `Promise`\<`void`\>

The `resolver` argument is sandbox-only — see [signInWithPopup](#signinwithpopup).

#### Parameters

##### auth

[`Auth`](#auth)

##### provider

[`AuthProvider`](#authprovider)

##### resolver?

[`AuthFlowResolver`](#authflowresolver)

#### Returns

`Promise`\<`void`\>

***

### signOut()

> **signOut**(`auth`): `Promise`\<`void`\>

#### Parameters

##### auth

[`Auth`](#auth)

#### Returns

`Promise`\<`void`\>

***

### unlink()

> **unlink**(`user`, `providerId`): `Promise`\<[`User`](#user-1)\>

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

##### user

[`User`](#user-1)

##### providerId

`string`

#### Returns

`Promise`\<[`User`](#user-1)\>

***

### updateCurrentUser()

> **updateCurrentUser**(`auth`, `user`): `Promise`\<`void`\>

Top-level mirror of `firebase/auth`'s `updateCurrentUser(auth, user)`.
Sets the sandbox's current user (pass `null` to sign out), firing
`onAuthStateChanged`. Real behavior — `auth.currentUser` reflects the
passed user afterward.

#### Parameters

##### auth

[`Auth`](#auth)

##### user

[`User`](#user-1)

#### Returns

`Promise`\<`void`\>

***

### updateEmail()

> **updateEmail**(`user`, `newEmail`): `Promise`\<`void`\>

Top-level mirror of `firebase/auth`'s `updateEmail(user, newEmail)`.
Changes the signed-in user's email in the store (rejecting
`auth/email-already-in-use` / `auth/invalid-email`) and mutates the held
`user` in place. Real behavior: the next sign-in resolves against the
new email.

Leniency vs prod: the sandbox does NOT enforce `auth/requires-recent-login`
and does not route through `verifyBeforeUpdateEmail` — see the COMPAT row.

#### Parameters

##### user

[`User`](#user-1)

##### newEmail

`string`

#### Returns

`Promise`\<`void`\>

***

### updatePassword()

> **updatePassword**(`user`, `newPassword`): `Promise`\<`void`\>

Top-level mirror of `firebase/auth`'s `updatePassword(user, newPassword)`.
Sets the stored password (validated for strength). Real behavior: the
sandbox stores AND verifies passwords, so the next
`signInWithEmailAndPassword` with the new password succeeds and the old
one throws `auth/wrong-password`.

Leniency vs prod: no `auth/requires-recent-login` enforcement — see the
COMPAT row.

#### Parameters

##### user

[`User`](#user-1)

##### newPassword

`string`

#### Returns

`Promise`\<`void`\>

***

### updateProfile()

> **updateProfile**(`user`, `profile`): `Promise`\<`void`\>

Top-level mirror of `firebase/auth`'s `updateProfile(user, profile)`.
Updates the signed-in user's `displayName` / `photoURL` — pass `null` to
clear a field, omit it to leave it untouched. Mutates the user object in
place (held references, including `auth.currentUser`, reflect the change).

Dispatches through the hidden USER\_INTERNAL hook the sandbox
backend stamps on every `User`, so it works WITHOUT an `auth` handle —
matching upstream's user-only signature.

Per `firebase/auth`, this does NOT fire `onAuthStateChanged` /
`onIdTokenChanged`.

#### Parameters

##### user

[`User`](#user-1)

##### profile

###### displayName?

`string`

###### photoURL?

`string`

#### Returns

`Promise`\<`void`\>

***

### useDeviceLanguage()

> **useDeviceLanguage**(`auth`): `void`

`useDeviceLanguage(auth)` — accepted no-op. The sandbox has no device
locale to read, so there is no language to set; the call is accepted so
init code that calls it compiles + runs. `diverged-documented`.

#### Parameters

##### auth

[`Auth`](#auth)

#### Returns

`void`

***

### validatePassword()

> **validatePassword**(`auth`, `password`): `Promise`\<[`PasswordValidationStatus`](#passwordvalidationstatus)\>

`validatePassword(auth, password)` — mirror of `firebase/auth`.

Checks a password against the project policy WITHOUT attempting a
sign-up, so a UI can show live strength feedback as the user types.
Returns the same `PasswordValidationStatus` shape prod returns, with
only the requirements the policy actually sets — see the note on
SANDBOX\_PASSWORD\_POLICY about why unset is not `false`.

#### Parameters

##### auth

[`Auth`](#auth)

##### password

`string`

#### Returns

`Promise`\<[`PasswordValidationStatus`](#passwordvalidationstatus)\>

***

### verifyBeforeUpdateEmail()

> **verifyBeforeUpdateEmail**(`user`, `newEmail`, `settings?`): `Promise`\<`void`\>

`verifyBeforeUpdateEmail(user, newEmail, settings?)` — mirror of
`firebase/auth`.

Mails a code to the NEW address and returns. The account's email does
NOT change yet — it changes when that code is redeemed, which is the
one guarantee separating this API from a bare `updateEmail`: the user
must prove they control the new address before it becomes theirs.

#### Parameters

##### user

[`User`](#user-1)

##### newEmail

`string`

##### settings?

[`ActionCodeSettings`](#actioncodesettings)

#### Returns

`Promise`\<`void`\>

***

### verifyPasswordResetCode()

> **verifyPasswordResetCode**(`auth`, `code`): `Promise`\<`string`\>

`verifyPasswordResetCode(auth, code)` — mirror of `firebase/auth`.
Checks a reset code and returns the account's email. Does NOT redeem
it — `confirmPasswordReset` does.

#### Parameters

##### auth

[`Auth`](#auth)

##### code

`string`

#### Returns

`Promise`\<`string`\>
