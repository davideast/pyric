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

Ninety-three tasks, counted by the first tag each one carries:

- 21 auth and tenant: seed a tenant user with claims, switch the active identity, list users, set
  or revoke claims, delete an account, import a team and read one back by address, and the app's
  own sign-in: with a password, anonymously, with a minted custom token, and out again. The
  sign-in tasks are the ones that separate the app session from the identity the agent's own calls
  run as; one of them starts from a password that does not work and has to find out why.
- 15 Firestore and Database data: write, update, add, delete, query, batch, and tree writes.
  Several run under a tenant identity so the rules gate them.
- 10 rules: lint a broken ruleset for each service, simulate a request, trace a denial, compare an
  allow expectation against a deny expectation, reach for a rules helper module.
- 8 storage: upload, read metadata, list, download, overwrite, delete.
- 22 sandbox: inspect, reset, seed, checkpoint and restore, page the operation log, export a fixture
  and reload it, and the branch lifecycle from fork through promote or discard. One reset task
  phrases the request so the natural first attempt omits `confirm`, which the destructive-method
  validator refuses; one branch task says plainly that nothing should land, and its assert fails if
  a promote call was made at all.
- 8 assurance: replay the last recorded session against a candidate ruleset and report the verdicts
  it changes, decide the cases a capture derives, ask the conformance registry about a feature, and
  drive an authorization campaign from cloning the sandbox through minimizing a counterexample and
  exporting it. One of them asks for Firebase's hosted rules test API by name, which no run may
  reach, and is not done until a local engine answered instead.
- 9 multi-step: two or three operations in sequence, such as seeding a tenant user, writing a
  document as that user, and reading it back. Three of these install rules with `set` and then read
  the effect back through `simulate`, one per service.

## Rules for new tasks

- A prompt never names a tool and never names a canonical operation id. It says what the developer
  wants, the way they would say it to an agent. Choosing the operation is the thing under test.
- Noise is welcome: an unrelated service in the sentence, or a misspelled collection name the agent
  is expected to keep verbatim.
- `assert` checks the outcome in state, not the path taken. Check the call log only when the task
  has no state effect, such as a read or a rules verdict.
- Every entry in `acceptedFirstOperations` must be a canonical operation id from the contract.
- A task that needs a file the app would have left behind, rather than sandbox state, declares it on
  the seed. `session` is the one such field today: the seeder writes it to
  `.pyric/last-session.json` in the run's project directory, which is where the assurance methods
  look for a capture.
