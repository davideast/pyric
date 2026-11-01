# Production oracle: RTDB rules (deploy, observe, restore)

RTDB has no server-side rules test endpoint. Production truth is captured by
deploying a scenario's rules to a dedicated database, running each operation as
a real client, recording allow or deny, and restoring. The runner is
`packages/conformance/src/run-rules-rtdb.ts`; read its header before the first
capture.

## What the runner guarantees

- Each scenario's rules are merged under a run-scoped namespace, never
  replacing the instance's existing rules.
- Two invariants gate every run, and observations are written only when both
  read back verified: rules restored (canonical JSON identical to the pre-run
  snapshot) and data removed (the run-scoped namespace is gone). Any mid-run
  failure still attempts both before exiting.
- Deploy scenarios (records with `deployCases`) are sent as dry runs
  (`PUT /.settings/rules.json?dryRun=true`): production validates and answers
  200 or 400 with its error text, and deploys nothing.
- Cases with `claims` sign in with a custom token minted by the service
  account; every Auth user created is deleted and the deletion proven.
- Without `PYRIC_ORACLE_FIREBASE_CONFIG` it is inert: it prints what it would
  capture and makes no network calls.

## Before the first capture

1. **A dedicated instance.** A database instance used for nothing else, with
   deny-all base rules. Never point the runner at a database an app uses. The
   oracle project `digame-mas` has two: `pyric-oracle-rtdb` and
   `pyric-oracle-rtdb-2`, both dedicated, both with locked resting rules. The
   `databaseURL` in `PYRIC_ORACLE_FIREBASE_CONFIG` picks the instance.
2. **Credentials, by env.** `PYRIC_ORACLE_FIREBASE_CONFIG` (Web SDK config JSON
   with `databaseURL` and `apiKey`) gates capture. The oracle credential
   (`PYRIC_ORACLE_PROJECT_ID` with Application Default Credentials, or
   `PYRIC_ORACLE_SA_PATH` naming a key file outside the checkout) mints a
   database-scoped token and seeds data. If that account lacks database admin
   roles, stop and resolve access with a dedicated oracle service account, or
   an admin token from the Firebase CLI login wired through the runner's token
   path. Never widen an app's credentials.
3. **Anonymous sign-in** enabled, for cases that sign in anonymously.
4. **Readiness.** `PYRIC_ORACLE_FIREBASE_CONFIG=... bun run
   packages/conformance/src/check-rtdb-preflight.ts` checks the web config has
   a `databaseURL`, anonymous sign-in is enabled, and the oracle namespace is
   writable by a signed-in user. It exits 1 with a remediation per failure.
5. **Preview.** Run with no credentials and confirm the scenario list and
   observation paths.

## A capture

```sh
# preview (no network)
bun run packages/conformance/src/run-rules-rtdb.ts
# one scenario, credentialed
PYRIC_ORACLE_FIREBASE_CONFIG="$(cat <web-config.json>)" \
  PYRIC_ORACLE_PROJECT_ID=<oracle project id> \
  bun run packages/conformance/src/run-rules-rtdb.ts --scenario <scenario-id>
```

- Always pass `--scenario`. Without it the runner captures every scenario and
  deploy scenario in the corpus and rewrites every observation file.
- A clean run ends with `capture complete: rules restored, run data and run
  users removed, all read-back verified.` After every capture, with or without
  that line, read the instance's rules back yourself and confirm the database
  root holds no run namespace before the next one. It is cheap. A missing line
  (a crash, a kill, an error) makes it urgent.
- Huge inputs in a deploy dry run (a 2,000-term chain, a long or nested regex
  pattern) can rate-limit the oracle with HTTP 429. Put one limit probe in a
  scenario, not a ladder of them, and space limit scenarios minutes apart.
  When one instance is rate-limited, capture on the other, and later confirm
  the first is back at rest (rules read back locked, no run namespace).
- A deploy rejection is itself a finding. When a probe cannot be deployed (for
  example `!` applied to a non-boolean), record the deploy verdict instead of
  forcing a runtime case.

The `capture-rtdb-rules-text-dialect.ts` and `capture-rtdb-rules-type-check.ts`
dry-run captures in the same directory show `bun --env-file=.env` in their
headers. Pass the variables inline instead; credentials never go in `.env`.

## Writing a scenario

Scenarios live in `packages/conformance/rules-corpus/rtdb/`
(`r<N>-<topic>.ts`, registered in that directory's `index.ts`). Each carries
`fm`, `rationale`, `provenance` (what prompted it and when it was captured),
`rules`, and `cases` with an `expectation` per case. Write the expectation you
believe production gives, capture, and let production correct you: an
expectation is never edited to match pyric.

Include a control in each scenario (a case pyric already gets right), so a
wrong capture setup shows up as a failed control rather than a fake
divergence.

## After the capture

- The observation lands in `packages/conformance/observations/rtdb-rules/`. It
  changes only by re-capture.
- Add or extend the registry row in `packages/conformance/registry/rules.ts`,
  and add `assurance-node-counts/rules/<pr-number>.json` in the same change.
- Pin every disagreement in `KNOWN_DIVERGENCES` with both verdicts and the
  finding it belongs to.
- Regenerate the scorecard and baselines; the score drops if production
  disagrees.

## What this runner cannot express

It runs single operations and records allow or deny. Listener delivery after
revocation, transaction retries and onDisconnect timing need the SDK-level
probes in [oracle-sdk-runtime.md](oracle-sdk-runtime.md). In #1247, DF-4, DF-5
and LD-9 waited on exactly that.
