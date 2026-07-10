---
title: "Stand up the real Firebase project without leaving the terminal"
navLabel: "Set up the project"
group: "Ship & test"
section: ""
order: 21
description: "Enable providers, authorize domains, and provision databases, Storage, and hosting sites from the CLI or a script."
---

# Stand up the real Firebase project without leaving the terminal

Between "the app works in the sandbox" and "the app works in production" sits project configuration: sign-in providers to enable, domains to authorize, a database and a bucket to provision. That work usually means clicking through the Console. Pyric does it over REST with your credentials, from the CLI, a script, or an agent. Every step probes before it mutates, so rerunning is safe, and every step returns a typed outcome that says what actually happened.

These commands change a real project. There is no dry run. Pass `--project` when you want to be certain which one.

## Enable the sign-in providers your app uses
```bash
pyric auth:configure-provider anonymous true --project my-app
pyric auth:configure-provider email true --project my-app
```
`anonymous`, `email`, `phone`, and `google` are supported. Two have honest edges. Enabling `phone` succeeds, but SMS delivery needs a billing account, and the result carries a warning saying so. And `google` can only be toggled once its OAuth client exists: Google does not let that client be minted from scratch, so the first enable happens once in the Console (Authentication, Sign-in method, Google), after which Pyric can enable and disable it freely. When the client is missing, the command tells you exactly that instead of pretending.

## Authorize the domains you sign in from

Firebase Auth keeps an allowlist of domains for OAuth redirects. Deploy to a new hosting domain without adding it, and Google sign-in fails on the new site. That failure is one command:
```bash
pyric auth:manage-domains add app.example.com --project my-app
```
`list` shows the current allowlist and `remove` prunes it. Adding a domain that is already present succeeds unchanged, and removing `localhost` warns you, since dropping it breaks local development.

## Create a hosting site

A project's default site exists from the start, but additional named sites must be created explicitly, and deploying to a site that doesn't exist returns a bare 404. The deploy API makes it an ensure:
```ts
import { fromServiceAccount, hosting } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');
const result = await hosting.sites.ensure(scope, { siteId: 'my-app-staging' });
// result.kind: 'created' | 'existed'
```
## Provision a Firestore database
```ts
import { firestore } from 'pyric-tools/deploy';

const outcome = await firestore.databases.provision(scope);
// outcome.status: 'created' | 'already-exists'
```
The probe runs first; an existing database short-circuits with no writes. A newly created one takes about thirty seconds for its data plane to come online, so poll the returned operation before issuing writes that must land.

## Provision Storage, end to end

Storage enablement is a sequence, and the Console hides most of it. Pyric runs the whole thing:
```ts
import { provisionStorage, defaultPlaygroundCors } from 'pyric/storage';

const result = await provisionStorage(accessToken, 'my-app', {
  rules: storageRulesSource,
  cors: defaultPlaygroundCors('https://my-app.web.app'),
});
```
Five steps, each skipped when already done:

1. **Enable the Storage service**, then wait a few seconds for propagation, because immediate calls still return `SERVICE_DISABLED`.
2. **Finalize the project's default location.** This one is irreversible: once set, the location cannot be changed. Pyric skips it when a location already exists, so the only dangerous run is the first one. Pick the location on purpose.
3. **Create and link the default bucket** (`my-app.firebasestorage.app`) if it isn't linked yet.
4. **Deploy rules to the bucket's own release.** Storage rules apply through per-bucket release names. The project-wide `firebase.storage` release still exists as a legacy alias, but it is not bound to modern buckets, so deploying there quietly leaves the bucket's default deny-all in place. Pyric targets the per-bucket release.
5. **Set browser-ready CORS.** A bucket without CORS configuration blocks the Storage Web SDK from any non-Firebase origin, surfacing as `No 'Access-Control-Allow-Origin' header` on the first request. Pass the origins your app serves from.

The result reports which steps ran, so a second invocation returns with everything marked already done.

## APIs enable themselves

Each of these operations needs certain Google APIs active on the project. Deploys run a preflight that checks the required services and batch-enables the missing ones, polling the operation to completion, before the real work starts. When your credential lacks permission to enable an API, the preflight surfaces that as the actionable error instead of a downstream failure.

## And from an agent

The same operations ship as agent tools: the deploy factories, the auth configuration tools, and the Storage control plane. Given a service account, an agent can take a bare project to configured infrastructure and report each step's outcome. See [Set up your agent](../set-up-your-agent/).

## Where to go next

With the project stood up, [Ship to production](../ship-to-production/) covers rules, indexes, verification, and the deploy itself.
