# Production oracle: Firestore and Storage (Rules Test API)

Firestore and Storage rules can be evaluated by production without deploying
anything: the Firebase Rules `projects.test` endpoint takes a ruleset and test
cases and returns production's verdicts. That makes the oracle cheap, safe, and
parallel-friendly compared with RTDB.

## Runners

| Engine | Runner | Observations |
|---|---|---|
| Firestore | `packages/conformance/src/run-rules.ts` | `observations/firestore-rules/rules-firestore-<id>.json` |
| Storage | `packages/conformance/src/run-rules-storage.ts` | `observations/storage/rules-storage-<id>.json` |
| Live parity packs | `bun test packages/pyric/test/rules/parity` | none (CI job "Parity stress (live Rules Test API)") |

Corpus: `packages/conformance/rules-corpus/firestore/` and `.../storage/`.
Both runners take `--scenario <id>` and are inert without credentials.

## Credentials

`PARITY_SA_BASE64` (or `PARITY_SA_PATH`): a service account holding only the
permission to test rulesets. The project it belongs to is the project rules are
tested against. Holding only that permission, it cannot read or write data or
deploy, so a capture cannot damage anything. Still, run captures from the
coordinator, never print the credential, and keep it out of shell history
(`PARITY_SA_PATH` is converted in-process).

```sh
bun run packages/conformance/src/run-rules.ts                  # preview
PARITY_SA_PATH=<sa.json> bun run packages/conformance/src/run-rules.ts --scenario <id>
```

## What the Rules Test API does not cover

It returns verdicts for the requests a test case describes. It does not exercise
the client SDK. Behavior that lives in the SDK or the backend's delivery path —
listener cancellation after revocation, transaction read semantics, offline
cache, query-construction errors raised client-side — needs a capture against a
real database with a deployed ruleset, as the SDK-level observations under
`observations/firestore/` were captured. Treat such findings as
`NEEDS_RUNTIME_MRE` until one exists.

Check what a case shape supports before relying on it for a query or a batch:
read the handler the runner uses (`TestFirestoreRulesHandler`,
`TestStorageRulesHandler`) rather than assuming.

## Where Firestore defects are likely

The Firestore language is much larger than RTDB's, so the boundaries are too:
query proofs (a `list` rule must be provable from the query's constraints),
`getAfter` in batches and transactions, `get`/`exists` lookup budgets,
`request.resource` vs `resource`, map and list type coercion, `diff()` and
`affectedKeys()`, function and `let` scoping, compile limits. The Firestore engine
has no constraints DSL, so the RTDB DSL workstream does not apply; the contract
sweep moves to the rules API, sandbox and index tooling instead.
