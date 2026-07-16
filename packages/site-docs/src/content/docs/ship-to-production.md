---
title: "The same code goes live"
navLabel: "Ship to production"
group: "Ship unchanged"
section: ""
order: 5001
description: "Deploy rules, indexes, hosting, and functions, and learn what would change before production does."
---

# The same code goes live

There is no graduation step. The `firebase/*` imports that resolved to the sandbox all through development resolve to real Firebase in your production build, and the config you passed to `initializeApp`, ignored in dev, is the config the built app uses in production. Your source does not change.

```bash
vite build            # ships the real firebase package, your config, your code
firebase deploy --only hosting
```

One guard stands between the two worlds. A sandbox build (from `vite build --mode development`) carries a marker in its `index.html`. Production hosting deploys should use an unmarked build (`vite build` / production mode) so a sandbox-wired dist never reaches production by accident. Prefer `firebase-tools` (or the Console) for the deploy itself.

## Deploy your rules

```bash
firebase deploy --only firestore:rules
```

This pushes the `firestore.rules` named in `firebase.json` to your project. By the time you run it, those rules have already been exercised: every operation your app performed in development was evaluated against them, verdict by verdict. You are not deploying a guess.

## Deploy indexes from your query shapes

Composite indexes usually live in a hand-kept file that drifts from the queries. Pyric derives them instead: index extraction reads your `query(collection, where, orderBy)` call sites in source and produces the `firestore.indexes.json` those shapes require (`pyric firestore indexes generate src`). Then:

```bash
firebase deploy --only firestore:indexes
```

Index builds are long-running on Firebase's side; the Firebase CLI starts them and reports status.

## Learn what flips before production does

This is the step the others earn. While you worked, `pyric dev` captured the session to `.pyric/last-session.json`: every write, every identity, every timestamp. Replay that session against the rules you are about to ship:

```bash
pyric verify --rules firestore=firestore.rules
```

The output names each operation whose verdict changed:

```
✗ chat - rtdb: 1 failure(s)
    [rtdb] now-denied: set /rooms/r1/messages/m1 (PERMISSION_DENIED)
```

`now-denied` means a write that succeeded during development would be rejected under the new rules. `now-allowed` means the reverse, a loosening. Auto-id aliases and timestamp drift are reported as informational, not failures, because replaying generated values is supposed to produce them. The exit code is 1 on any real divergence, which makes the CI gate one line:

```yaml
- run: pyric verify journeys/ --rules firestore=firestore.rules
```

By default verification runs on the local sandbox engine. For Firestore you can also send the derived cases to Firebase's hosted Rules Test API, or run both:

```bash
pyric verify --service firestore --engine both --project my-app --rules firestore=firestore.rules
```

`both` cross-checks the two engines against each other and flags any disagreement. That checks your rules and, at the same time, checks Pyric's own engine against Google's answer for your exact traffic. The Rules Test API evaluates cases only: it does not deploy rules or change a project. Hosted verification needs a project id plus `FIREBASE_SA_BASE64` or `GOOGLE_APPLICATION_CREDENTIALS` (or ADC); build a `ProjectScope` programmatically with `@pyric/cli/credentials/node` (`fromServiceAccount` / `fromAdc`).

## Deploy hosting and functions

```bash
firebase deploy --only hosting                      # preview channels via firebase hosting:channel:deploy
firebase deploy --only functions
```

Use `firebase-tools` (or the Console) for production shipping. Preview channels give you a shareable URL with an expiry before anything touches the live site.

## Credentials for verify (and CI)

`pyric verify` with the default `sandbox` engine needs no cloud credentials. For `--engine rules-test-api` or `both`:

- **CI / local**: a service account via `FIREBASE_SA_BASE64` or `GOOGLE_APPLICATION_CREDENTIALS`.
- **Fallback**: ambient application-default credentials.

The full flag list is in the [CLI reference](../pyric-cli-reference-cli/).

## Where to go next

If the project itself isn't stood up yet, providers, domains, database, Storage, that is [Set up the project](../set-up-the-project/). To make the captured sessions you verify richer, see [Shape your data](../shape-your-data/).
