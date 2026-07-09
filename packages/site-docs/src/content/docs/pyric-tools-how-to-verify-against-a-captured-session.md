---
title: "How to verify your rules against a captured session"
navLabel: "Verify rules against prod"
group: "pyric-tools"
section: "How-to"
order: 11
---
# How to verify your rules against a captured session

`pyric verify` replays a captured sandbox session against candidate rules and
reports service-labelled divergences. It works for Firestore and Realtime
Database captures. It answers the question that makes "build in the sandbox,
swap to prod" safe: *will the rules I'm about to ship break what I built?*

## Capture a session, then verify

Capture is on by default in `pyric dev`, so the loop is just three steps.

1. Start the sandbox. The session is written to `.pyric/last-session.json` as
   you go:
   ```sh
   pyric dev
   ```
   (Pass `--no-capture` to disable the recording.)

2. Exercise your app against the running sandbox — sign in, create documents,
   run the journeys you care about. Every write is recorded.

3. Replay the latest capture against the rules you intend to deploy:
   ```sh
   pyric verify
   ```
   With no positional argument, `verify` reads `.pyric/last-session.json`.
   It verifies the Firestore and RTDB services present in that capture.
   Candidate rules are resolved from `firebase.json`:
   ```json
   {
     "firestore": { "rules": "firestore.rules" },
     "database": { "rules": "database.rules.json" }
   }
   ```
## Verify against edited rules

If you've tightened or rewritten your rules and want to check them before
deploying, pass service-qualified rules overrides:
```sh
pyric verify --rules firestore=path/to/firestore.rules
pyric verify --rules rtdb=path/to/database.rules.json
```
The capture stays fixed; only the ruleset changes. The diff between what the
sandbox allowed and what these rules allow is exactly what surfaces.

For a mixed capture, repeat `--rules`:
```sh
pyric verify \
  --rules firestore=firestore.rules \
  --rules rtdb=database.rules.json
```
To check only one service in a mixed capture, use `--service`:
```sh
pyric verify --service rtdb --rules rtdb=database.rules.json
```
## Choose a verification engine

The default engine is `sandbox`: Firestore uses local replay and RTDB uses the
local RTDB replay primitive. This is the fast loop for development and CI:
```sh
pyric verify journeys/checkout.json --engine sandbox
```
For Firestore, you can also derive Rules Test API cases from the same fixture
and send them to Firebase's hosted Rules Test API:
```sh
pyric verify journeys/checkout.json \
  --service firestore \
  --engine rules-test-api \
  --project demo-app \
  --rules firestore=firestore.rules
```
Use `both` when you want the local sandbox replay and hosted Firestore result in
one run:
```sh
pyric verify journeys/checkout.json \
  --service firestore \
  --engine both \
  --project demo-app \
  --rules firestore=firestore.rules
```
RTDB verification is sandbox-only. RTDB constraints still feed verification as
RTDB rules JSON or an in-process `RtdbRulesDocument`; they are not a separate
verification service.

## Inspect derived Firestore cases

When you want to see exactly what will be sent to the Rules Test API, derive the
cases without running verification:
```sh
pyric verify cases journeys/checkout.json \
  --service firestore \
  --out journeys/checkout.cases.json
```
The output contains `testCases`, warnings, and unsupported events. Admin/setup
traffic and listener re-evaluations are excluded so the cases describe user
behavior protected by rules.

## Verify a specific fixture

To replay a saved fixture instead of the latest capture, pass its path:
```sh
pyric verify journeys/checkout.json
```
## Interpreting the result

A session **fails** (exit code `1`) when replay finds a failing divergence:
a write that succeeded in the sandbox would now be denied, an operation is not
replayable, or the replayed state differs from the captured state. Each failure
is labelled by service:
```
✗ chat - rtdb: 1 failure(s)
    [rtdb] now-denied: set /rooms/r1/messages/m1 (PERMISSION_DENIED)
```
Firestore auto-id aliases, time drift, and sentinel drift are informational.
They are expected artefacts of replaying generated values, so they do not fail
the run. A clean run exits `0`:
```
✓ chat - firestore: ok (0 informational), rtdb: ok (0 informational)

✓ all selected services replay cleanly.
```
## Run a suite in CI

To verify many captured journeys at once, point `verify` at a directory. Every
`*.json` fixture in it is replayed and the command exits non-zero if any one
diverges:
```sh
pyric verify journeys/ --rules firestore=firestore.rules
```
Add `--json` for machine-readable output to feed into a dashboard or gate.

A minimal CI step — fail the build if any captured journey would break under
the rules being shipped:
```yaml
- name: Verify rules against captured journeys
  run: pyric verify journeys/ --rules firestore=firestore.rules
```
The non-zero exit on a real divergence is what blocks the merge.

## Verify from code

Use `pyric-tools/verify` when your RTDB rules are authored in memory:
```ts
import { verifyFixture } from 'pyric-tools/verify';
import { rules } from './database.rules.js';

const fixture = JSON.parse(await Bun.file('.pyric/last-session.json').text());

const result = await verifyFixture(fixture, {
  engines: ['sandbox'],
  rules: { rtdb: rules },
});

if (!result.ok) process.exit(1);
```
`rules` can be an RTDB rules JSON object or an `RtdbRulesDocument` from
`defineRtdbRules()`.

Firestore can use the hosted engine from code:
```ts
import { verifyFixture } from 'pyric-tools/verify';

const result = await verifyFixture(fixture, {
  engines: ['rulesTestApi'],
  services: ['firestore'],
  rules: { firestore: firestoreRulesSource },
  rulesTestApi: {
    scope,
    expressionReportLevel: 'VISITED',
  },
});
```
For the full flag list, see the [`pyric verify` reference](../pyric-tools-reference-cli/).
