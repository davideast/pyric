# Replaying the policy oracle

Run these commands from the Pyric worktree containing this experiment. The default command inventories claims and verifies their input hashes and evidence. The complete replay needs Python 3, Bun, Node 22+, npm and the Linux tools used by the archived replay. It uses local package tarballs and runs without Firebase credentials.

```sh
python3 experiments/policy-oracle/core/oracle.py
python3 experiments/policy-oracle/core/oracle.py --all
python3 experiments/policy-oracle/core/test_oracle.py
```

The JSON report groups the registered obligations and probes by claim. Each probe names its cases. An eligible receipt makes a probe `evidenced`; replaying the candidate against all its observed answers can make it `conforms`. A probe awaiting a receipt stays `pending`, even if a local evaluator allows one proposal and refuses another. Incompatible receipts for the same probe yield `disputed` and retain both answers. A mismatch under replay yields `diverged`. A dispute, candidate mismatch, malformed input, or an evidenced claim whose mutation survives every required case makes the command exit unsuccessfully. New observations with the same answers do not increase the number of claims.

`--all` also rebuilds the pinned runtime with the original [offline Arcade replay](arcade/README.md) and checks its two claims, 21 decisions and mutation results. `--replay` uses a runtime already prepared by the archive. Use it in a private worktree with a stable install. The archived replay takes an exclusive lock during installation. The integrated runner holds the same lock in shared mode while its probe programs use that runtime.

## Adding a probe

Give the author a single directory in `suites/<family>/<subject>/claims/<claim>/v1/`. Use lowercase hyphenated IDs and add a separate file for each obligation. The following files form one claim.

| File | Contents |
|---|---|
| `claim.json` | A description and an eligible authority, currently `native-model`, `firestore-sdk` or `rtdb-production`. |
| `obligations/<id>.json` | A required local probe version, for example `{"probe":"at-cap/v1"}`. |
| `probes/<id>/v1/recipe.json` | The upstream repo, full revision and path under `source`, unique case names under `cases`, and the local replay filename under `replay`. The `pins` object maps the runner, its inputs and dependencies to SHA-256 digests. Use `@oracle/` paths for dependencies shared under this directory. |
| `probes/<id>/v1/observations/<run>.json` | An eligible `authority`, an `inputDigest`, and one observed result under `results` for every case. `evidence` gives the relative raw record path, its SHA-256 and one JSON Pointer per case under `pointers`. |
| Probe files | The raw observation or fixture, any adapter, and a replay program. The program runs with Bun in the probe directory and receives the oracle directory as `ORACLE_ROOT`. Its single JSON output has `candidate` and `mutant` maps keyed by exactly the declared case names. |

Compute `inputDigest` by hashing the original bytes of `claim.json`, one zero byte, and the original bytes of `recipe.json`, in that order. Every pinned file is verified separately. Record the native or hosted answer before implementing the candidate. Review the original source, authority, case bindings and all files the runner reads. In particular, a self-asserted authority string and a checksum do not authenticate a Firebase capture. The runnable probe programs are trusted, reviewed code and should execute offline without credentials. Use a separately supervised capture for new live evidence.

## Freezing a reviewed release

```sh
python3 experiments/policy-oracle/core/oracle.py --snapshot > /tmp/reviewed-oracle.json
python3 experiments/policy-oracle/core/oracle.py --all --baseline /tmp/reviewed-oracle.json
```

Take the first snapshot from a reviewed tree. A baseline pins every claim, obligation, recipe and observation in that release. A comparison allows additions and fails if an existing record changes or disappears. CI can supply a baseline from a protected revision. Keep snapshots for named releases, so routine probe authors never edit a shared manifest. The separate frozen Arcade archive keeps its own release hashes. [Parallel ownership and deployment scope](../../docs/conformance/policy-oracle-parallel-authorship.md)
