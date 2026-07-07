# playground

Astro + React playground that drives a `@inbrowser/agent` session against a
sandboxed Firestore, previews the generated app live, and ships the
resulting app + rules + indexes to the user's own Firebase project.


## Running locally

```bash
bun install
bun run dev                # http://localhost:4321
```

Create a `.env` in this directory or the monorepo root with at minimum:

```
PUBLIC_GIS_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
```

See the GCP Console setup below for how to get that client id.

## One-time GCP Console setup

The deploy flow uses Google Identity Services (GIS) to mint
`cloud-platform`-scoped OAuth access tokens that authorize the
playground to call Firebase Hosting / Firestore Admin / IAM REST APIs
against the user's target project. The short version:

### 1. Enable the APIs you'll call

In the **playground host project** (the GCP project that owns the
OAuth client below — typically the same project the playground itself
runs on), enable:

- Cloud Resource Manager API
- Firebase Hosting API
- Firebase Rules API
- Cloud Firestore API
- Identity and Access Management (IAM) API

These can be enabled at <https://console.cloud.google.com/apis/library>.

### 2. Configure the OAuth consent screen

<https://console.cloud.google.com/apis/credentials/consent>

- **User type**: External
- **Scopes**: add `https://www.googleapis.com/auth/cloud-platform`
- **Test users**: while the consent screen is in "Testing" mode, add
  every Google account that should be able to use the playground.
  ("Publish app" opens it to all Google accounts; that's required for
  general public release but not for the milestone.)

### 3. Create an OAuth 2.0 Web client

<https://console.cloud.google.com/apis/credentials>

- **Application type**: Web application
- **Authorized JavaScript origins**: add every origin the playground
  loads from. At minimum:
  - `http://localhost:4321` (local dev)
  - your production origin(s)

Copy the **Client ID** (looks like `123456789-abc...apps.googleusercontent.com`).

### 4. Set the env var

In `packages/playground/.env`:

```
PUBLIC_GIS_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
```

The `PUBLIC_` prefix makes Astro/Vite ship the value to the browser.
The client ID is not a secret. Local dev scripts load env files in this
order: original checkout root, current worktree root, then this app
directory. Existing shell env vars still win.

## How the auth + deploy flow works

1. User opens the playground and hits the **Deploy** tab.
2. They click **Sign in with Google** → GIS popup → consent → token
   minted (`cloud-platform` scope, ~1h TTL, cached in memory only).
3. They configure the **target project** (their own Firebase project)
   in the Deploy tab form.
4. They click **Deploy to Firebase**. The orchestrator runs pre-flight,
   then rules + hosting (parallel), then index creation.
5. If the token expires mid-call, GIS silently reissues against the
   active Google session (no popup, no UX interruption).

Tokens are bound to the OAuth client_id + user identity, **not** to a
GCP project — one sign-in on the playground host authorizes calls
against any project the user has IAM rights for. See the
`Auth IDP probe` decision log for the cross-project confirmation.

## Optional: persistent sign-in (BFF)

The GIS flow above caches tokens **in memory only**, so a page reload drops the
token and re-triggers sign-in. To sign in once and stay signed in across reloads
(no popup churn), enable the **backend-for-frontend** that ships with this app:
the Astro server holds the refresh token in an httpOnly cookie and mints
short-lived access tokens to the browser.

A browser can't do this itself. Google requires the OAuth **client secret** for
the code exchange (confirmed: a no-secret PKCE exchange returns
`client_secret is missing.`) and has no public client type, so the secret and the
refresh token must live on the server.

To enable it:

1. **Add the client secret** to `packages/playground/.env` (server-only, no
   `PUBLIC_` prefix, never shipped to the browser):
   ```
   GIS_CLIENT_SECRET=<your-oauth-client-secret>
   ```
2. **Register the callback** as an Authorized redirect URI on the same OAuth
   client (Step 3): `<origin>/api/auth/callback`
   (e.g. `http://localhost:4321/api/auth/callback`).

When `GIS_CLIENT_SECRET` is set, `lib/auth/access-strategy.ts` automatically
prefers the BFF (`/api/auth/{start,callback,token,logout}`). When it's unset the
endpoints return 503 and the app falls back to the in-memory GIS flow above,
unchanged.

## Failure modes

The Deploy tab surfaces these from `lib/auth/gis-token.ts`:

| Code | Meaning | Fix |
|---|---|---|
| `no-client-id` | `PUBLIC_GIS_CLIENT_ID` not set | Step 4 above. |
| `script-load-failed` | `accounts.google.com/gsi/client` won't load | Network / CSP / ad-blocker. |
| `popup-closed` | User dismissed the consent popup | Click "Sign in" again. |
| `popup-blocked` | Browser prevented the popup | Allow popups for this origin. |
| `access-denied` | User unchecked the requested scope | Sign in again, leave the box checked. |
| `scope-not-granted` | `cloud-platform` not in the returned scopes | Same as above. |
| `redirect-uri-mismatch` | Origin not in the OAuth client's allowed list | Step 3 above. |
| `interaction-required` | Silent reissue needs UI (lapsed Google session) | Sign in again. |
