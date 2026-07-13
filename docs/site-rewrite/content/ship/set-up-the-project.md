---
title: Stand up the real Firebase project without leaving the terminal
navLabel: Set up the project
outcome: Enable providers, authorize domains, and provision databases, Storage, and hosting sites from the Console or firebase-tools.
status: draft
---

# Stand up the real Firebase project

Between "the app works in the sandbox" and "the app works in production" sits project configuration: sign-in providers to enable, domains to authorize, a database and a bucket to provision. Pyric does not replace that control plane — use the [Firebase Console](https://console.firebase.google.com/) and [`firebase-tools`](https://firebase.google.com/docs/cli) for production project administration.

These steps change a real project. There is no dry run. Confirm which project is selected (`firebase use` / Console project picker) before mutating.

## Enable the sign-in providers your app uses

In the Console: **Authentication → Sign-in method**. Enable `Anonymous`, `Email/Password`, `Phone`, and `Google` as your app needs.

Honest edges:

- Enabling phone succeeds in the Console, but SMS delivery needs a billing account.
- Google sign-in needs an OAuth client; the first enable happens in the Console (Authentication → Sign-in method → Google).

## Authorize the domains you sign in from

Firebase Auth keeps an allowlist of domains for OAuth redirects. Deploy to a new hosting domain without adding it, and Google sign-in fails on the new site. In the Console: **Authentication → Settings → Authorized domains**. Add the production (and preview) hosts; keep `localhost` for local development.

## Create a hosting site

A project's default site exists from the start; additional named sites are created in the Console (**Hosting**) or with `firebase hosting:sites:create`. Deploying to a site that doesn't exist fails — create the site first, then:

```bash
firebase deploy --only hosting
```

## Provision a Firestore database

Create the database in the Console (**Firestore Database → Create database**) or with the Firebase CLI / gcloud flow your org already uses. A newly created database can take a short while for its data plane to come online; wait before issuing writes that must land.

## Provision Storage, end to end

Storage enablement is a multi-step sequence. For a scripted path inside pyric (sandbox / playground-style hosts), `provisionStorage` from `pyric/storage` still covers the sequence:

```ts
import { provisionStorage, defaultPlaygroundCors } from 'pyric/storage';

const result = await provisionStorage(accessToken, 'my-app', {
  rules: storageRulesSource,
  cors: defaultPlaygroundCors('https://my-app.web.app'),
});
```

Five steps, each skipped when already done:

1. **Enable the Storage service**, then wait a few seconds for propagation, because immediate calls still return `SERVICE_DISABLED`.
2. **Finalize the project's default location.** This one is irreversible: once set, the location cannot be changed. Skip when a location already exists; pick the location on purpose the first time.
3. **Create and link the default bucket** (`my-app.firebasestorage.app`) if it isn't linked yet.
4. **Deploy rules to the bucket's own release.** Storage rules apply through per-bucket release names. The project-wide `firebase.storage` release still exists as a legacy alias, but it is not bound to modern buckets, so deploying there quietly leaves the bucket's default deny-all in place. Target the per-bucket release.
5. **Set browser-ready CORS.** A bucket without CORS configuration blocks the Storage Web SDK from any non-Firebase origin, surfacing as `No 'Access-Control-Allow-Origin' header` on the first request. Pass the origins your app serves from.

For ordinary production projects, prefer the Console / `firebase-tools` Storage setup unless you specifically need this scripted helper.

The result reports which steps ran, so a second invocation returns with everything marked already done.

## APIs enable themselves (firebase-tools)

Firebase CLI deploys typically enable required Google APIs as part of the deploy preflight. When your credential lacks permission to enable an API, that surfaces as an actionable error instead of a mysterious downstream failure.

## Where to go next

With the project stood up, [Ship to production](./ship-to-production.md) covers rules, indexes, verification, and the deploy itself.
