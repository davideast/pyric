# Production oracle: RTDB (deploy, observe, restore)

RTDB has no server-side rules test endpoint. Production truth is captured by
deploying a scenario's rules to a dedicated database, running each operation as a
real client, recording ALLOW or DENY, and restoring. The runner is
`packages/conformance/src/run-rules-rtdb.ts`; read its header before the first
capture.

## What the runner guarantees

- Each scenario's rules are merged under a run-scoped namespace, never replacing
  the instance's existing rules.
- Two invariants gate every run, and observations are written only when both
  read back verified: **rules restored** (canonical JSON identical to the
  pre-run snapshot) and **data removed** (the run-scoped namespace is gone).
  Any mid-run failure still attempts both before exiting.
- Deploy scenarios (records with `deployCases`) are sent as dry runs
  (`PUT /.settings/rules.json?dryRun=true`): production validates and answers
  200 or 400 with its error text, and deploys nothing.
- Cases with `claims` sign in with a custom token minted by the service account;
  every Auth user created is deleted and the deletion proven.
- Without credentials it is inert: it prints what it would capture and makes no
  network calls.

## Before the first capture

1. **A dedicated instance.** Create a database instance used for nothing else.
   Its base rules are deny-all. Never point the runner at a database an app uses.
2. **Credentials.** `PYRIC_ORACLE_FIREBASE_CONFIG` (Web SDK config JSON with
   `databaseURL` and `apiKey`) gates capture. `PYRIC_ORACLE_SA_PATH` points at a
   service account that can mint a database-scoped token and seed data. If the
   available service account lacks database admin roles, stop and resolve access
   (a dedicated oracle service account, or an admin token from the Firebase CLI
   login wired through the runner's token path) rather than widening an app's
   credentials. Never print key material or tokens.
3. **Anonymous sign-in** must be enabled for cases that sign in anonymously.
4. **Preview.** Run the runner with no credentials and confirm the scenario list
   and observation paths.

## A capture

```sh
# preview (no network)
bun run packages/conformance/src/run-rules-rtdb.ts
# one scenario, credentialed
PYRIC_ORACLE_FIREBASE_CONFIG="$(cat <web-config.json>)" \
  PYRIC_ORACLE_SA_PATH=<service-account.json> \
  bun run packages/conformance/src/run-rules-rtdb.ts --scenario <scenario-id>
```

- One capture at a time. Only the coordinator runs captures.
- After each run, read the instance's rules back yourself and confirm the
  database root holds no run namespace.
- A deploy rejection is itself a finding. When a probe cannot even be deployed
  (for example `!` applied to a non-boolean), record the deploy verdict instead of
  forcing a runtime case.

## Writing a scenario

Scenarios live in `packages/conformance/rules-corpus/rtdb/` (`r<N>-<topic>.ts`,
registered in that directory's `index.ts`). Each carries `fm`, `rationale`,
`provenance` (what prompted it and when it was captured), `rules`, and `cases`
with an `expectation` per case. Write the expectation you believe production
gives, capture, and let production correct you: an expectation is never edited to
match pyric.

Include a control in each scenario (a case pyric already gets right), so a wrong
capture setup shows up as a failed control rather than a fake divergence.

## After the capture

- The observation lands in `packages/conformance/observations/rtdb-rules/`.
  Frozen: it changes only by re-capture.
- Add or extend the registry row in `packages/conformance/registry/rules.ts`;
  adjust `assurance-node-counts/` in the same change.
- Pin every disagreement in `KNOWN_DIVERGENCES` with both verdicts and the
  finding it belongs to.
- Regenerate the scorecard and baselines; the score drops if production disagrees.
