# Production oracle: Firestore and Storage rules (Rules Test API)

Firestore and Storage rules can be evaluated by production without deploying
anything: the Firebase Rules `projects.test` endpoint takes a ruleset and test
cases and returns production's verdicts. Nothing is deployed, so there is
nothing to restore.

## Runners

| Engine | Runner | Observations |
|---|---|---|
| Firestore | `packages/conformance/src/run-rules.ts` | `observations/firestore-rules/rules-firestore-<id>.json` |
| Storage | `packages/conformance/src/run-rules-storage.ts` | `observations/storage-rules/rules-storage-<id>.json` |
| Live parity packs | `bun test packages/pyric/test/rules/parity` | none (CI job "Parity stress (live Rules Test API)") |

Corpus: `packages/conformance/rules-corpus/firestore/` and `.../storage/`.

## Credentials

Both runners and the parity packs resolve a credential in this order
(`packages/pyric/test/rules/parity/credential.ts`):

1. `GOOGLE_APPLICATION_CREDENTIALS`, an Application Default Credentials file;
2. a firebase-tools login (`~/.config/configstore/firebase-tools.json`);
3. the gcloud ADC file from `gcloud auth application-default login`.

The project under test depends on the source. With
`GOOGLE_APPLICATION_CREDENTIALS` or the gcloud ADC file it is
`PARITY_PROJECT_ID`, then `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`. With a
firebase-tools login it is `PARITY_PROJECT_ID` only. Either way the default is
`digame-mas`. A credential that holds only `firebaserules.rulesets.test`
cannot read or write data or deploy, so a capture cannot damage anything.

```sh
# one scenario, credentialed
GOOGLE_APPLICATION_CREDENTIALS=<credentials.json> \
  bun run packages/conformance/src/run-rules.ts --scenario <id>
```

## The bare run is a full capture

Always pass `--scenario <id>`. With no `--scenario`, the runner captures every
scenario in the corpus and rewrites every observation file. The no-credential
preview is inert only when no source above resolves: on a machine with a
firebase-tools login, `bun run packages/conformance/src/run-rules.ts` with
nothing else is a full capture against `digame-mas`. Run captures in a
scratch worktree ([SKILL.md](../SKILL.md#captures-run-in-a-scratch-worktree)):
if a full capture happens there, remove the scratch tree and capture again by
scenario.

## What the Rules Test API does not cover

It returns verdicts for the requests a test case describes. It does not
exercise the client SDK. Behavior that lives in the SDK or the backend's
delivery path (listener cancellation after revocation, transaction read
semantics, offline cache, query errors raised client-side) needs a capture
against a real database with a deployed ruleset:
[oracle-sdk-runtime.md](oracle-sdk-runtime.md). Treat such findings as
`NEEDS_RUNTIME` until one exists.

Check what a case shape supports before relying on it for a query or a batch:
read the handler the runner uses (`TestFirestoreRulesHandler`,
`TestStorageRulesHandler`) rather than assuming.

## Where Firestore defects are likely

The Firestore language is much larger than RTDB's, so the boundaries are too:
query proofs (a `list` rule must be provable from the query's constraints),
`getAfter` in batches and transactions, `get` and `exists` lookup budgets,
`request.resource` vs `resource`, map and list type coercion, `diff()` and
`affectedKeys()`, function and `let` scoping, compile limits, and `matches()`
patterns with nested counted repeats (#1264).
