---
title: The same code goes live
navLabel: Ship to production
outcome: Deploy rules, indexes, hosting, and functions, and learn what would change before production does.
status: draft
---

# The same code goes live

There is no graduation step. The `firebase/*` imports that resolved to the sandbox all through development resolve to real Firebase in your production build, and the config you passed to `initializeApp`, ignored in dev, is the config the built app uses in production. Your source does not change.

```bash
vite build            # ships the real firebase package, your config, your code
pyric deploy hosting
```

One guard stands between the two worlds. A sandbox build (from `vite build --mode development`) carries a marker in its `index.html`, and `pyric deploy hosting` refuses a marked dist. A build wired to the sandbox never reaches production by accident.

## Deploy your rules

```bash
pyric deploy rules
```

This pushes the `firestore.rules` named in `firebase.json` to your project over REST. By the time you run it, those rules have already been exercised: every operation your app performed in development was evaluated against them, verdict by verdict. You are not deploying a guess.

## Deploy indexes from your query shapes

Composite indexes usually live in a hand-kept file that drifts from the queries. Pyric derives them instead: index extraction reads your `query(collection, where, orderBy)` call sites in source and produces the `firestore.indexes.json` those shapes require. Then:

```bash
pyric deploy indexes
```

Index builds are long-running on Firebase's side; the deploy starts them, reports per-index status, and tells you which already existed.

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

`both` cross-checks the two engines against each other and flags any disagreement. That checks your rules and, at the same time, checks Pyric's own engine against production's answer for your exact traffic.

## Deploy hosting and functions

```bash
pyric deploy hosting                      # or --channel <id> for a preview URL
pyric deploy functions
```

Both run over REST against the live APIs, each step idempotent with a typed outcome. Preview channels give you a shareable URL with an expiry before anything touches the live site.

## Sign in for deploys

Local deploys use `pyric login`, a loopback OAuth flow that stores a refresh token at `~/.pyric/credentials.json`. CI uses a service account via `FIREBASE_SA_BASE64` or `GOOGLE_APPLICATION_CREDENTIALS`, and ambient application-default credentials work as the fallback. Deploy commands resolve whichever is present, service account first. The full precedence and flag list is in the [CLI reference](../../../../packages/pyric-tools/docs/reference/cli.md).

## Where to go next

If the project itself isn't stood up yet, providers, domains, database, Storage, that is [Set up the project](./set-up-the-project.md). To make the captured sessions you verify richer, see [Shape your data](../observe/shape-your-data.md).
