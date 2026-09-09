# Corpus

One task per file, `<task-id>.ts`, default exporting an `EvalTask` as defined in the shared
contract. The `id` field equals the filename without its extension. A record carries five things:

- `prompt`: what a developer asks, in their own words.
- `seed`: the state loaded through the sandbox before the run. Minimal and self-contained, so a
  task never depends on another task or on a fixture file.
- `acceptedFirstOperations`: every canonical operation id that is a reasonable opening move. An
  empty array means any first move is acceptable, which is the normal case for multi-step tasks.
- `assert`: takes the final state plus the call log and returns `true` or a short reason string.
- `tags`: service and shape labels used to slice the report.

## Distribution

Sixty-four tasks:

- 15 auth and tenant: seed a tenant user with claims, switch the active identity, list users, set
  or revoke claims, delete an account.
- 15 Firestore and Database data: write, update, add, delete, query, batch, and tree writes.
  Several run under a tenant identity so the rules gate them.
- 10 rules: lint a broken ruleset for each service, simulate a request, trace a denial, compare an
  allow expectation against a deny expectation, reach for a rules helper module.
- 8 storage: upload, read metadata, list, download, overwrite, delete.
- 7 sandbox: inspect, reset, seed. One of the reset tasks phrases the request so the natural first
  attempt omits `confirm`, which the destructive-method validator refuses; the task is not done
  until a reset call actually succeeds.
- 9 multi-step: two or three operations in sequence, such as seeding a tenant user, writing a
  document as that user, and reading it back. Three of these install rules with `set` and then
  read the effect back through `simulate`, one per service.

## Rules for new tasks

- A prompt never names a tool and never names a canonical operation id. It says what the developer
  wants, the way they would say it to an agent. Choosing the operation is the thing under test.
- Noise is welcome: an unrelated service in the sentence, or a misspelled collection name the agent
  is expected to keep verbatim.
- `assert` checks the outcome in state, not the path taken. Check the call log only when the task
  has no state effect, such as a read or a rules verdict.
- Every entry in `acceptedFirstOperations` must be a canonical operation id from the contract.
