# How to run the conformance system

This is the operations manual for Pyric's conformance system: the machinery
that proves the public Firebase mirror matches real Firebase behavior. It
assumes you know what the system is and want to run it. Each section is a
task. Every command runs from the repository root.

`../README.md` is the map: what lives where, and how a claim links to its
evidence. This document is the other half: what to run, what the output
means, and how to find out what is not covered.

The one rule that governs every task here: **evidence flows in, claims flow
out, and only the registry changes claims.** Everything below either
produces evidence, checks evidence against claims, or regenerates a view of
claims. Nothing edits a generated file by hand, ever.

## Contents

- [Run the daily gate](#run-the-daily-gate)
- [The command inventory](#the-command-inventory)
- [Read the reports](#read-the-reports)
- [Find the gaps, by name](#find-the-gaps-by-name)
- [Capture new evidence](#capture-new-evidence)
- [Add to the system](#add-to-the-system)
- [Bump the firebase dependency](#bump-the-firebase-dependency)
- [Known rough edges](#known-rough-edges)

## Run the daily gate

One command answers "is the conformance graph coherent right now":

```sh
bash scripts/build.sh    # first, if src/ changed: the census imports the BUILT packages
bun run compat:check
```

`compat:check` is not a script of its own. It chains six gates, in this
order, cheapest and most specific first:

| # | Gate | Fails when |
|---|------|-----------|
| 1 | `compat:validate` | A link in the evidence graph is broken: a row cites a missing observation, an observation sits in the wrong surface directory, a probe has no observation twin, a rules-corpus scenario is orphaned, or an entry-path expected-failure cites a gap that does not exist. |
| 2 | `compat:census-gate` | A change introduced a NEW unmapped upstream symbol, or left a stale/redundant deny-list entry behind. Ratchets against `baselines/census-baseline.json`. |
| 3 | `compat:entry-path` | A canonical initialization program went red without a cited, currently-real gap. This is a CLIFF, not a ratchet. |
| 4 | `generate-docs.ts --check` | A `COMPAT.md` on disk no longer matches what the registry generates. Someone hand-edited a generated file, or edited the registry and forgot to regenerate. |
| 5 | `compat:conformance:check` | The ignored runtime node-verdict lookup is missing or no longer matches the conformance graph. Run the CLI prebuild or `compat:conformance`. |
| 6 | `compat:coverage` | A published number regressed: a `conforms` row flipped or vanished, surface coverage dropped, a new orphan observation appeared, or the high-risk-unverified count went up. Never fails for being low, only for going down. |

Green looks like this (trimmed):

```
$ bun run compat:check
# Compatibility registry validation
Rows: 827
Observations: 225
Conformance checks: 5
Problems: 0

# Compat census gate
Current unmapped total: 53. Baseline tolerates 53.
✓ No new unmapped symbols, no stale/redundant denials. Gate clean.

# Entry-path conformance (CLIFF gate)
  GREEN       auth
  GREEN       database
  GREEN       firestore
  GREEN       storage
4 green, 0 red-known, 0 red, 0 stale-expected-failure — 4 program(s) total.
✓ Entry-path gate clean (every program green or red-known-with-citation).

Compatibility markdown is generated from the registry.
Conformance verdicts: 1067 nodes (851 supported, 135 qualified, 81 unsupported)
Generated lookup: 38511 bytes raw, 5090 bytes gzip

# Compatibility coverage
[… the coverage table …]
✓ No regressions vs. coverage-baseline.json.
```

Exit code 0. Generated outputs are always rebuilt from their source:

```sh
bun run compat:generate     # rewrites generated COMPAT pages + the scoreboard from the registry
bun run compat:conformance  # rewrites the ignored CLI runtime verdict lookup
git diff                    # the diff IS the report: it shows exactly what changed
```

If the diff shows something you did not intend, the registry is wrong, not the
generated file.

CI runs these same gates in `.github/workflows/build.yml`, plus
`compat:lint-terms` and the audit gate, and publishes the coverage table to the
job summary.

## The command inventory

Seventeen commands. Every one is `bun run <name>` from the repo root unless
noted. Exit codes below were captured from a clean tree.

### Gates (run in CI, fail the build)

**`compat:validate`** (exit 0) walks every link in the evidence graph in both
directions: row to observation, observation to row, observation to surface
directory, probe to observation, rules-corpus scenario to observation,
entry-path citation to live gap. It reports `Problems: 0` or names each broken
link. A failure means the graph lies: something claims evidence that is not
there. Run it after any edit to `registry/`, `observations/`, `probes/`,
`rules-corpus/`, or `exceptions/`.

**`compat:census-gate`** (exit 0) is the surface ratchet. It compares the
current unmapped runtime and type sets against
`baselines/census-baseline.json`. Passing means "no NEW debt". It does not mean
"no debt": today it tolerates 34 unmapped runtime symbols and 159 unmapped
type names. A failure names the new symbol. Mirror it, give a missing public
runtime export an honest disposition in `src/surface-denylist.ts`, or record
the known gap with `bun run compat:census-gate --update`. The baseline prevents
new gaps from arriving silently. It never gives an existing gap coverage
credit.

**`compat:entry-path`** (exit 0) is the one cliff in a system of ratchets. It
runs each `entry-path/<service>.ts` program in-process: import from `pyric/*`
subpaths as a user would, initialize, configure, perform one real operation,
assert it succeeded. Initialization failing is total and immediate for a user,
so there is no baseline and no tolerance. A program either passes, or its
failure is cited by an `entry-path/expected-failures.ts` record naming a real,
currently-existing gap, or the gate fails the build. `expected-failures.ts` is
empty today: all four programs are green.

**`compat:conformance:check`** (exit 0) verifies the ignored runtime lookup
still matches what the conformance graph derives. The CLI prebuild normally
creates it; see `compat:conformance` below.

**`compat:coverage`** (exit 0) is the published compatibility number and the
regression gate that protects it. See [Read the reports](#read-the-reports).

**`compat:lint-terms`** (exit 0) scans registry prose and the generated
`COMPAT.md` files for colloquialisms, issue-number references, and
coding-tool names. Registry prose is published prose, held to the same bar as
the docs.

```
$ bun run compat:lint-terms
compat:lint-terms — clean (no colloquialisms, issue references, or tool names in registry prose).
```

**`bun run packages/conformance/src/audit-gate.ts`** (exit 0) is the audit
ratchet. It fails only when a change introduces a NEW high-risk row claiming
`conforms` with no oracle citation and no exception. It has no `compat:*`
alias (see [Known rough edges](#known-rough-edges)); CI runs it by path.

```
$ bun run packages/conformance/src/audit-gate.ts
# Oracle audit gate
Current high-risk unverified ✓ rows: 5 (baseline tolerates 5).

✓ No new uncited ✓ rows. Gate clean.
```

### Generators (they write files; never edit their output)

**`compat:generate`** (exit 0) regenerates the nine `COMPAT.md` docs and the
scoreboard from the registry. `--check` (what `compat:check` chains) verifies
instead of writing.

```
$ bun run compat:generate
Generated 9 compatibility document(s) + scoreboard.
```

**`compat:conformance`** (exit 0) derives a verdict for every addressable
construct and registry row. It writes a deterministic, ignored TypeScript
lookup consumed by the CLI. The graph remains the only source of truth; this
projection exists only for a filesystem-free runtime lookup and is regenerated
before every CLI build.

```
$ bun run compat:conformance
Wrote …/packages/cli/src/assurance/.generated/conformance-verdicts.ts
Conformance verdicts: 1067 nodes (851 supported, 135 qualified, 81 unsupported)
Generated lookup: 38511 bytes raw, 5090 bytes gzip
```

**The rules-language reports** have no `compat:*` alias; run them by path.

```sh
bun run packages/conformance/src/rules-language-analyzer.ts    # -> coverage-report.json
bun run packages/conformance/src/rules-language-capability.ts  # -> capability-report.json
bun run packages/conformance/src/rules-language-acceptance.ts  # -> acceptance-report.json (PRODUCTION probe, needs PARITY_SA_BASE64)
```

```
$ bun run packages/conformance/src/rules-language-analyzer.ts
firestore: exercised 128/140 (91.4%), verified 128/140 (91.4%) over 23 scenarios (23 with twins); 5 unresolved refs
storage: exercised 55/55 (100.0%), verified 55/55 (100.0%) over 8 scenarios (8 with twins); 0 unresolved refs
rtdb: exercised 52/55 (94.5%), verified 52/55 (94.5%) over 14 scenarios (14 with twins); 0 unresolved refs

$ bun run packages/conformance/src/rules-language-capability.ts
firestore: implemented 133, unsupported 3, error 1, unprobeable 3 / 140; language coverage 97.8% (of 136 probeable)
storage: implemented 56, unsupported 0, error 0, unprobeable 0 / 56; language coverage 100.0% (of 56 probeable)
rtdb: implemented 55, unsupported 0, error 0, unprobeable 1 / 56; language coverage 100.0% (of 55 probeable)
```

The analyzer and the capability probe are offline and deterministic: run them
after touching the corpus, the snapshots, or the simulator. The acceptance
probe talks to production and is the only one of the three that needs a
credential.

### Reports (informational; read them, do not gate on them)

**`compat:report`** (exit 0) is the inventory: row counts by surface, status
tallies, evidence tiers, the climb section for surfaces still under Conformance
Driven Development, the high-risk unverified worklist with file and line, and
orphan observations. `--strict` makes it fail on that debt; `--json` emits the
summary.

**`compat:audit`** (exit 0) is the ranked worklist of high-risk rows claiming
`conforms` with no oracle evidence. Scored: a row asserting a specific error
code or a specific value scores higher than a row asserting a shape. This is
the "what should we capture next" list.

**`compat:census`** (**exit 1**, by design) is the tier-1 runtime export diff
per mirror pair. It exits non-zero whenever ANY upstream export is unmapped,
which is true today (53 of them). It is a REPORT, not the gate:
`compat:census-gate` is the gate, and it passes. Do not wire `compat:census`
into a pipeline expecting 0. `-- --report` adds the full per-surface inventory,
including every deny-list entry with its written reason.

**`oracle:plan`** (exit 0) is the rig fleet: every capture rig, its automation
tier, its credential contract, and whether it is runnable right now. See
[Capture new evidence](#capture-new-evidence).

**`compat:climb`** (exit 0) is the Conformance Driven Development lane. It runs
the conformance suite of each surface still climbing, maps assertion sets back
to row ids, and compares live results against registry claims. Non-blocking by
design: it exits non-zero only if an already-green row regressed. Red among
unverified rows is the expected climb.

```
$ bun run compat:climb
## messaging
suite status: ran
live green rows: 17/17 (100%)
registry conforming: 17/17 (100%)
assertion sets: 17 green, 0 red, 0 unmapped
regressions: none

## messaging-admin
live green rows: 39/39 (100%)
registry conforming: 39/39 (100%)
regressions: none

✓ No green-row regressions. Red among unverified rows is the expected climb.
```

**`compat:climb-ai`** (exit 0) is shorthand for `bun test packages/pyric/test/ai`,
the AI surface's suite (158 tests).

**`compat:oracle-versions`** (exit 0) is the staleness guard. Every observation
records the SDK version it was captured at; this checks all of them against
what the lockfile currently resolves.

```
$ bun run compat:oracle-versions
# Oracle observation version guard
Resolved firebase (node_modules/firebase/package.json): 12.13.0
Resolved firebase-admin (node_modules/firebase-admin/package.json): 13.10.0
Resolved firebase-functions (node_modules/firebase-functions/package.json): 7.2.5
Observations checked: 256

✓ Every observation matches its installed Firebase SDK version.
```

A failure after a `firebase` bump means the pinned baseline no longer vouches
for the installed SDK. Re-capture before trusting any conformance result.

**`compat:oracle-check`** (exit 0) replays each registry `conformanceChecks`
entry and verifies the committed observation's values still match the row's
`expect` block. This is what stops someone editing a capture to make a probe
pass: the capture and the claim are checked against each other.

```
$ bun run compat:oracle-check
# Oracle conformance gate (observations x probes)
Observations loaded: 225
Registry conformance checks: 5
Structural problems: 0
Observation-integrity problems: 0
Conformance probes run: 5

## Conforming — probe passes; shim matches the recorded prod behavior
- AUTH-B2 (auth#21) — createUserWithEmailAndPassword returns providerId: null + operationType: 'signIn'.
- FS-B1 (firestore#20) — getDocs/query reads enforce security rules — a denied query throws permission-denied.
- DB-B7 (rtdb#27) — push() under denying rules mints a 20-char dash-prefixed key and returns a thenable.
- DB-B10 (rtdb-modular#106) — the modular DataSnapshot exposes size / priority / exportVal().
- DB-GAP (rtdb-modular#155) — increment() is implemented and starts from 0 against a missing field.

✓ Observations sound; all 5 registered conformance probes pass.
```

It never contacts production: it checks the frozen record against the claim,
which is the whole point.

## Read the reports

### The coverage table, axis by axis

```
$ bun run compat:coverage
service         runtime(public)  types(public)  behavior(total)  behavior(intended)  diverged  unverified
---------------------------------------------------------------------------------------------------------
ai                         69.1%          66.5%             92.3%                92.3%          6            0
app                          90%          66.7%             85.2%                88.5%          2            1
auth                       82.4%          39.1%             81.8%                85.3%         16            1
firestore                  63.5%          38.5%             87.6%                87.6%         20            0
rtdb                      native         native             53.8%                95.5%          1            0
rtdb-modular               79.5%          53.3%             82.1%                86.9%          8           12
storage                    72.2%          52.9%               86%                93.5%          6            0
messaging                   100%           100%              100%                 100%          0            0
functions-rtdb       integration    integration             92.3%                92.3%          0            1
firestore-rules           native         native               72%                  72%          7            0
storage-rules             native         native             94.4%                94.4%          1            0
rtdb-rules                native         native              100%                 100%          0            0
---------------------------------------------------------------------------------------------------------
OVERALL                    73.5%          54.8%             84.3%                88.9%         67           15

High-risk unverified conforms rows: 5
Orphan observations: 0

Entry-path (compat:entry-path — CLIFF, not a ratchet):
  auth         green
  database     green
  firestore    green
  storage      green

✓ No regressions vs. coverage-baseline.json.
```

**Public runtime surface** is mirrored public runtime exports over Firebase
public runtime exports. **Public type surface** applies the same name-presence
test to exported types. Both are computed by `src/surface-census.ts` from the
built packages. Together they measure breadth: whether the Firebase names an
application imports exist against the mirror. They say nothing about behavior,
and type-name presence does not prove structural assignability or signature
equivalence.

Public means the Firebase module's non-underscore exports. Leading-underscore
implementation plumbing is excluded by one structural rule, never by a
Pyric-maintained exception list. Deprecated, unsupported, and not-yet-built
public APIs stay in the denominator. Pyric-only exports receive no credit. For
example, `firebase/app` currently has 10 public runtime exports. Pyric mirrors
9, with only `initializeServerApp` missing, so App runtime surface is 90%.
Firebase's 13 leading-underscore runtime exports remain visible in the raw
census diagnostic, but they cannot lower or raise public coverage.

**Behavior conformance** is `conforms` rows over evaluated rows, from the
ledger in `src/ledger.ts`. It measures FIDELITY of the already-implemented
slice: "of the calls that exist, do they behave like prod." It is never a
standalone completeness grade. A service can post high behavior conformance
while most of its surface is not built yet, because this axis only evaluates
rows that exist in the registry. `diverged-documented` and `unverified` rows
get their own columns and are never folded into `conforms`; folding them in
would inflate the number without changing what is true.

**Surface has no intended axis.** A public Firebase export is part of the
contract whether Pyric plans to implement it, has deferred it, or has an honest
reason not to mirror it. Runtime dispositions explain missing symbols and keep
the census exhaustive, but never remove public names from coverage. The type
axis records every missing public type name directly.

Behavior retains total and intended views. Behavior intended excludes rows
whose five-state status is `unsupported`; all other tracked rows stay in its
denominator. This behavior-only distinction cannot alter either public-surface
number.

**`native` in the public-surface columns** is not a missing number. It means the
surface has no upstream module to be measured against: the RTDB agent-tools
host surface and the three rules engines are Pyric's own APIs. Their
completeness is measured against their own public API, not against a Firebase
export set, so a breadth percentage would be meaningless. They still carry a
behavior number, because they still have registry rows adjudicated against
production evidence: the Firestore and Storage rules engines against the
production Rules Test API, `rtdb-rules` against production itself. `OVERALL`
public-surface coverage sums the mirror surfaces only. `integration` marks an
unchanged upstream API run through a Pyric runtime seam, such as Functions with
Realtime Database. It also has no Firebase mirror denominator.

**Entry-path verdicts** are `green`, `red-known`, or `red`. Coverage publishes
them and applies cliff semantics: a green program turning red or red-known is a
regression, the one place this ordinarily regression-tolerant report refuses to
tolerate.

**The regression gate.** `compat:coverage` diffs against
`baselines/coverage-baseline.json` and fails ONLY on regression: a `conforms`
row flipping or disappearing, a public runtime or type percentage dropping, a new orphan
observation, or the high-risk-unverified count increasing. It never fails for
being below an absolute percentage. A threshold gate would invite relabeling
rows `conforms` to clear the bar, which is the exact dishonesty this system
exists to prevent. The gate protects a number that was true from silently
stopping being true; it does not police how high the number is.

When a change makes a legitimate, evidence-backed difference to coverage (a real
new divergence, a newly mirrored public export or type, a fixed row moving to `conforms`),
update the baseline alongside it:

```sh
bun run compat:coverage --update-baseline
git add packages/conformance/baselines/coverage-baseline.json
```

### The rules-language axes

The rules engines are measured on their own axes, because "how much of the
Rules language do we handle" is a different question from "how many exports do
we mirror". The reports live in `packages/conformance/rules-language/`.

Each engine has a **snapshot** (`firestore.json`, `storage.json`, `rtdb.json`):
a hand-enumerated census of every construct in that Rules language, sourced from
the official language reference and the repo's own grammar. Every construct
carries a `status`, one of four:

| status | meaning |
|---|---|
| `accepted` | The production Rules Test API accepted a ruleset using this construct. |
| `rejected` | Production REJECTED it. `probeNote` carries production's verbatim rejection message. A rejected construct is one the official reference documents but production does not actually accept in the probed position. |
| `unprobeable` | No single-expression micro-scenario can isolate this construct. `probeNote` says why: a resource limit, a meta-semantic, a multi-node relationship, or a module-resolution form. |
| `unprobed` | Not probed. All 56 RTDB constructs are `unprobed`, because RTDB has no server-side rules test API that can accept or reject a ruleset. RTDB is verified a different way, by deploying to a live database (the `rtdb-rules` rig). |

Two derived reports sit on top.

**`capability-report.json`** answers "does OUR simulator evaluate this
construct?" `languageCoverage` is implemented over probeable (implemented plus
unsupported): firestore 97.8%, storage 100%, RTDB 100%. This is a claim about
Pyric's simulator, not about production.

**`coverage-report.json`** answers "is this construct backed by PRODUCTION
evidence?" A construct is verified when at least one corpus scenario that has an
observation twin exercises it. `verifiedCoverage` is verified over total:
firestore 91.4%, storage 100%, RTDB 94.5%. This is the honest trust number for
the rules engines, and it is the low one, which is the point.

Attribution is deliberately conservative, in two distinct ways, and they are
easy to confuse.

**`unresolved`** is a per-reference diagnostic. A method call whose receiver
type cannot be determined from the AST (a bare `size()`, ambiguous across
string/list/map/set/bytes) is credited to NO construct, and is surfaced in the
report's `unresolved` array instead. It still counts in the denominator, so it
drags the number DOWN. Under-counting is honest; over-counting would inflate
the very number the system exists to protect.

**`unattributable`** is a per-construct property, and the only thing that ever
leaves the denominator. A construct is `unattributable` when it is a pure
meta-semantic that no ruleset's source text can contain, so no analyzer walking
an AST could ever credit it: counting it would guarantee a permanent, false
deficit. Two constructs carry it today, and each says why in the snapshot:

```sh
python3 -c "
import json
for f in ['firestore', 'storage', 'rtdb']:
    s = json.load(open(f'packages/conformance/rules-language/{f}.json'))
    for c in s['constructs']:
        if c.get('unattributable'):
            print(f\"{f:10} {c['id']:36} {c['unattributable'][:80]}\")
"
```

```
storage    storage.semantic.deny-by-default     Pure meta-semantic: the engine denies any request no `allow` matches. It is …
rtdb       rtdb.semantic.deny-by-default        Pure meta-semantic, identical reasoning to storage.semantic.deny-by-default: …
```

That is why the storage and RTDB snapshots each enumerate 56 constructs while
their coverage denominators read 55. `unattributable` is an EXCLUSION and needs
a written justification; `unresolved` is a MISS and needs a better scenario.

## Find the gaps, by name

Percentages tell you how much is missing. They never tell you WHAT. Every axis
has a way to name its gaps, and none of them requires reading source. The
one-liners below are copy-pasteable, and each was run to produce the output
shown under it.

### Which upstream exports are NOT mirrored?

```sh
bun run compat:census
```

```
surface     upstream  mapped  denied  unmapped  extra
ai               55     38     17        0     1
app              23      9     14        0     4
auth             85     32     34       19     3
firestore       119     66     25       28     8
database         54     35     15        4    33
storage          27     12     13        2    20
messaging         5      5      0        0     1
messaging-sw       4      4      0        0     1

## UNMAPPED gaps

- auth (19): AuthCredential, AuthErrorCodes, EmailAuthCredential, OAuthCredential,
  OperationType, ProviderId, SAMLAuthProvider, SignInMethod, TwitterAuthProvider,
  browserCookiePersistence, browserPopupRedirectResolver, debugErrorMap,
  fetchSignInMethodsForEmail, getAdditionalUserInfo, indexedDBLocalPersistence,
  prodErrorMap, revokeAccessToken, signInWithCustomToken, validatePassword
- firestore (28): AbstractUserDataWriter, AggregateField, AggregateQuerySnapshot,
  CollectionReference, DocumentReference, DocumentSnapshot, Firestore, FirestoreError,
  Query, QueryCompositeFilterConstraint, QueryConstraint, QueryDocumentSnapshot,
  QueryEndAtConstraint, QueryFieldFilterConstraint, QueryLimitConstraint,
  QueryOrderByConstraint, QuerySnapshot, QueryStartAtConstraint, SnapshotMetadata,
  Transaction, WriteBatch, aggregateFieldEqual, aggregateQuerySnapshotEqual,
  documentSnapshotFromJSON, ensureFirestoreConfigured, executeWrite, onSnapshotResume,
  querySnapshotFromJSON
- database (4): DataSnapshot, Database, QueryConstraint, TransactionResult
- storage (2): StorageErrorCode, StringFormat

✗ 53 unmapped upstream symbol(s). Mirror them, or add a deny-list entry with a reason
  in packages/conformance/src/surface-denylist.ts.
```

Exit code 1, by design. That list is the complete, by-name answer to "what is
not mirrored": these 53 symbols ARE the surface-coverage deficit, spelled out.

### Which exports are deliberately NOT mirrored, and why?

The unmapped list above is untriaged debt. The deny-list is triaged debt, and
every entry carries a written reason:

```sh
bun run compat:census -- --report
```

```
## firebase/ai → pyric/ai
upstream 55 · mirror 39 · mapped 38 · denied 17 · unmapped 0 · extra 1

  DENIED (17):
    - ImagenAspectRatio: Imagen is deprecated upstream; all Imagen models shut down as
      early as June 2026 (upstream 2.11.0 deprecation). Mirroring an API whose production
      counterpart is retiring would freeze dead behavior.
    - InferenceMode: Hybrid/on-device inference is deferred, not out of scope — the sandbox
      runs in the browser and can model the on-device path through the answer-engine seam;
      the mode has not been wired yet.
    - LiveGenerativeModel: Live API is deferred, not out of scope — it is a bidirectional
      websocket protocol the sandbox can model with a scripted session engine, the same
      seam pattern the REST plane already uses; the work has not happened yet.
    …
```

Read the `deferred` versus `out-of-scope` framing in each reason: that
distinction is what decides whether the symbol leaves the `intended`
denominator.

### Which unmapped symbols does the ratchet currently tolerate?

```sh
python3 -c "import json;d=json.load(open('packages/conformance/baselines/census-baseline.json'))['surfaces'];[print(f'{s}: {len(v)}') or [print('   ',x) for x in v] for s,v in d.items() if v]"
```

```
auth: 19
    AuthCredential
    AuthErrorCodes
    EmailAuthCredential
    …
firestore: 28
    AbstractUserDataWriter
    …
database: 4
storage: 2
```

Anything in this file is pre-existing debt the gate lets through. Anything NOT
in it fails `compat:census-gate` the moment it appears. To pay debt down:
mirror the symbol or deny it with a reason, then remove it from the baseline.

### Which registry rows are NOT conforming, by id?

```sh
bun run compat:coverage --json | python3 -c "
import json, sys
from collections import Counter
rs = json.load(sys.stdin)['rowStatuses']
bad = {k: v for k, v in rs.items() if v != 'conforms'}
print(Counter(bad.values()))
for k, v in sorted(bad.items()): print(f'{v:20} {k}')
"
```

```
Counter({'diverged-documented': 60, 'unsupported': 30, 'unverified': 13})
diverged-documented  ai#chat-history-excludes-blocked
diverged-documented  ai#chat-history-threads
diverged-documented  ai#chat-stream-single-user-turn
diverged-documented  ai#model-name-prefixed
diverged-documented  ai#schema-string-enum
diverged-documented  ai#stream-aggregate-final-meta
unsupported          app#15
diverged-documented  auth#12
diverged-documented  auth#15a
unverified           auth#3
unsupported          auth#49
diverged-documented  firestore#116
…
```

Every non-conforming row, named. `rowStatuses` in `compat:coverage --json` is
the canonical map. Take any id to its registry file to read the `behavior`,
`evidence`, and `notes` that explain it. Note the three statuses mean different
things: `diverged-documented` is a KNOWN, written-down difference from prod;
`unsupported` is a decision never to model it; `unverified` is the honest "we
have not checked".

### Which conforming rows have NO production evidence behind them?

These are the dangerous ones: rows claiming `conforms` on the strength of a
unit test alone, where the assertion is specific enough that being wrong
matters.

```sh
bun run compat:audit
```

```
**Unverified + status ✓ + high-risk (score >= 2):** 5

## Ranked worklist

### storage
- **storage#67** (score 6) — Sandbox: writes-then-delete leaves no metadata
  (post-delete `getMetadata` throws `object-not-found`)
  - asserts 1 specific value(s); asserts Firebase error code(s): `object-not-found`;
    asserts metadata shape
- **storage#61** (score 5) — Root-ref read throws `storage/invalid-root-operation`
  - asserts 1 specific value(s); asserts Firebase error code(s): `storage/invalid-root-operation`
### firestore
- **firestore#92** (score 2) — Identity is frozen at `runTransaction` start
- **firestore#97** (score 2) — Batch is tagged on construction
- **firestore#98** (score 2) — Batch identity is frozen at construction
```

The score IS the risk: asserting a specific error code or a specific value
scores higher than asserting a shape. This is the capture worklist, ranked.
`compat:report` prints the same five with their `COMPAT.md` file and line
number.

### Which observations are orphaned?

An orphan is a captured production fact that no registry row cites: evidence
paid for and then dropped on the floor.

```sh
bun run compat:report | grep -i orphan
```

```
Orphan observations: 0
```

Zero today, and they cannot accumulate silently: `compat:validate` treats an
uncited observation as fatal unless `exceptions/<observation-name>.ts` exists
and gives a written reason.

### Which rules-language constructs have NO production evidence?

The single most useful gap query for the rules engines. A construct with an
empty `verifiedBy` is one the simulator may well handle correctly, but nothing
captured from production says so.

```sh
python3 -c "
import json
d = json.load(open('packages/conformance/rules-language/coverage-report.json'))
for e in d['engines']:
    un = [c['id'] for c in e['constructs'] if not c.get('verifiedBy')]
    print(f\"{e['engine']}: {len(un)} uncredited of {e['totalConstructs']}\")
    for i in un: print('   ', i)
"
```

```
firestore: 12 uncredited of 140
    firestore.binding.request.resource.id
    firestore.function.debug
    firestore.function.math.isInfinite
    firestore.function.cast.bool
    firestore.method.map.hasAll
    firestore.method.map.hasAny
    firestore.method.map.hasOnly
    firestore.method.duration.seconds
    firestore.method.duration.nanos
    firestore.rule-kind.import
    firestore.semantic.get-budget
    firestore.semantic.type-dispatch
storage: 1 uncredited of 55
    storage.semantic.deny-by-default
rtdb: 4 uncredited of 55
    rtdb.semantic.read-cascade
    rtdb.semantic.write-cascade
    rtdb.semantic.validate-non-cascade
    rtdb.semantic.deny-by-default
```

That is the 91.4% / 100% / 94.5% verified coverage, itemized. Closing a gap
means writing a corpus scenario that exercises the construct and running the
rig that captures it against production, which is exactly how RTDB went from
18/55 to 52/55.

The complement (`verifiedBy` non-empty) names WHICH scenarios credit a
construct, which is how you check whether a scenario is pulling its weight.

### Which constructs did production REJECT, and why?

```sh
python3 -c "
import json
for f in ['firestore', 'storage', 'rtdb']:
    s = json.load(open(f'packages/conformance/rules-language/{f}.json'))
    for c in s['constructs']:
        if c['status'] in ('rejected', 'unprobeable'):
            print(f\"{c['status']:12} {c['id']}\")
            print(f\"             {(c.get('probeNote') or c.get('note') or '(no note)')[:105]}\")
"
```

```
rejected     firestore.binding.resource.id
             Error: firestore.rules line [5], column [22]. Property id is undefined on object.
rejected     firestore.binding.resource.__name__
             Error: firestore.rules line [5], column [22]. Property __name__ is undefined on object.
rejected     firestore.binding.request.resource.id
             Error: firestore.rules line [5], column [22]. Property id is undefined on object.
rejected     firestore.function.getAfter
             Error: firestore.rules line [5], column [23]. Function not found error: Name: [getAfter].
rejected     firestore.function.existsAfter
             Error: firestore.rules line [5], column [23]. Function not found error: Name: [existsAfter].
rejected     firestore.function.debug
             Error: firestore.rules line [5], column [22]. Function not found error: Name: [debug].
rejected     firestore.function.math.isInfinite
             Error: firestore.rules line [5], column [22]. Function not found error: Name: [math.isInfinite].
rejected     firestore.function.cast.bool
             Error: firestore.rules line [5], column [22]. Function not found error: Name: [bool].
rejected     firestore.method.map.hasAll
             Error: firestore.rules line [5], column [22]. Function not found error: Name: [hasAll].
rejected     firestore.method.map.hasAny
             Error: firestore.rules line [5], column [22]. Function not found error: Name: [hasAny].
rejected     firestore.method.map.hasOnly
             Error: firestore.rules line [5], column [22]. Function not found error: Name: [hasOnly].
unprobeable  firestore.rule-kind.import
             the `import`/2+modules form requires module resolution (resolveModules) before simulation
unprobeable  firestore.semantic.get-budget
             the get() budget (cap 10 per evaluation) is a resource-limit semantic, not expressible as
unprobeable  firestore.semantic.type-dispatch
             type-based method dispatch is a meta-semantic exercised by every method call; it has no
```

Firestore is the only engine with anything here: every storage construct is
`accepted`, and every RTDB construct is `unprobed` (there is no RTDB rules test
API to accept or reject anything).

`rejected` is the interesting status. The official language reference documents
`getAfter`, `existsAfter`, `debug`, `math.isInfinite`, and the map
`hasAll`/`hasAny`/`hasOnly` methods, and production's own Rules Test API refuses
a ruleset that uses them in the probed position. Production's verbatim message
is preserved, so the claim is checkable rather than asserted.

### Which constructs does our simulator not evaluate?

```sh
python3 -c "
import json
d = json.load(open('packages/conformance/rules-language/capability-report.json'))
for e in d['engines']:
    for c in e['constructs']:
        if c['classification'] != 'implemented':
            print(f\"{c['classification']:12} {c['id']:42} {c.get('detail','')[:58]}\")
"
```

```
error        firestore.binding.request.resource.id      eval error: No field 'id' on map
unsupported  firestore.method.set.difference            Set.difference() is not faithfully modeled by the sim
unsupported  firestore.method.set.union                 Set.union() is not faithfully modeled by the simulato
unsupported  firestore.method.set.intersection          Set.intersection() is not faithfully modeled by the s
unprobeable  firestore.rule-kind.import                 the `import`/2+modules form requires module resolutio
unprobeable  firestore.semantic.get-budget              the get() budget (cap 10 per evaluation) is a resourc
unprobeable  firestore.semantic.type-dispatch           type-based method dispatch is a meta-semantic exercis
unprobeable  rtdb.semantic.validate-non-cascade         validate non-cascade is a multi-node relationship (a
```

Eight constructs, each with its reason. `unsupported` is a real simulator gap
with a written justification. `error` marks a malformed micro-scenario, which is
a bug in the probe, not in the simulator. `unprobeable` means the probe shape
cannot isolate the construct, so no verdict is claimed either way.

### What will the assurance engine refuse to back?

Run `bun run compat:conformance` to see the population and generated lookup
size. Assurance probes name graph nodes directly; only a `supported` verdict
proceeds. `qualified`, `unsupported`, or an unknown node makes the engine
abstain rather than report a security conclusion it cannot support. The query
API reports the underlying snapshot, probe, production-verification, and
registry evidence without introducing another authored capability catalog.

### Which initialization programs are red?

```sh
bun run compat:entry-path
```

```
  GREEN       auth
  GREEN       database
  GREEN       firestore
  GREEN       storage

4 green, 0 red-known, 0 red, 0 stale-expected-failure — 4 program(s) total.
```

A `red-known` program names the gap it is blocked on in
`entry-path/expected-failures.ts`, and `compat:validate` re-derives that
citation against the live census, deny-list, and registry: a record cannot be
added speculatively, and cannot be left behind once the gap it names has closed.

## Capture new evidence

Every observation in `observations/` was produced by a capture rig. `oracle:plan`
is the fleet inventory: what each rig captures, what it needs, and whether you
can run it right now. It is inert: it opens no network connection and touches no
project, so it is safe to run at any time.

```sh
bun run oracle:plan
```

```
# Oracle rig fleet plan
Rigs: 9

## Summary
Runnable now (2): admin-app, app-registry
Blocked (7):
  - ai-logic: missing env: PYRIC_AI_FIREBASE_CONFIG
  - messaging-send: missing env: PYRIC_MESSAGING_SA_BASE64
  - messaging-web: missing env: PYRIC_MESSAGING_FIREBASE_CONFIG, PYRIC_MESSAGING_VAPID_KEY, PYRIC_MESSAGING_SA_BASE64
  - oracle-run: missing env: PYRIC_ORACLE_FIREBASE_CONFIG, PYRIC_ORACLE_SA_PATH
  - rtdb-rules: missing env: PYRIC_ORACLE_FIREBASE_CONFIG, PYRIC_ORACLE_SA_PATH
  - rules-firestore: missing env: PARITY_SA_BASE64
  - rules-storage: missing env: PARITY_SA_BASE64
```

`packages/conformance/docs/oracle-project-setup.md` is the project contract: what
to enable, and the exact rules snippets the oracle project needs.

### The fleet, by automation tier

Every rig declares an `automation` tier, and the tier is a promise about what
running it costs a human.

**Unattended.** No credentials, no network; runnable on any worker, including CI.

| Rig | Captures | Needs |
|---|---|---|
| `admin-app` | 11 `admin-app-` observations: the `firebase-admin` app registry (initializeApp / getApp / getApps / deleteApp, no-arg accessor resolution, `FirebaseAppError` shapes) | The installed `firebase-admin` package. No service account, project, or credential of any kind. |
| `app-registry` | 14 `app-registry-` observations: the `firebase/app` client registry, its error shapes, `SDK_VERSION`, and the logging seam | The installed `firebase` package. `initializeApp` is fed placeholder options; nothing reaches a real project because no service is ever opened. |

These two are pure in-process probes of installed library code. That is why
`oracle:plan` reports them `runnable now: yes` on a laptop with no setup.

**Credentialed.** Needs a real Firebase project and a secret; runs headless.

| Rig | Captures | Credential contract |
|---|---|---|
| `oracle-run` | 130 observations across five surfaces: `auth-` (28), `firestore-` (40), `rtdb-` (14), `rtdb-modular-` (39), `storage-` (9) | `PYRIC_ORACLE_FIREBASE_CONFIG` (web config JSON) plus `PYRIC_ORACLE_SA_PATH` (service-account file). The project needs Anonymous sign-in enabled and Firestore rules scoped to the `pyric_oracle` namespace. An RTDB instance and a Storage bucket are optional: those probes self-skip when absent. |
| `rtdb-rules` | 8 `rules-rtdb-` observations: per-case ALLOW/DENY verdicts for the RTDB rules corpus | The same two vars as `oracle-run`. The service account must additionally hold a role granting the `firebase.database` scope, so `/.settings/rules.json` PUT and GET both succeed. |
| `rules-firestore` | 23 `rules-firestore-` observations: per-case ALLOW/DENY/UNSUPPORTED verdicts from the production Firestore Rules Test API | `PARITY_SA_BASE64`: a base64 service account holding ONLY `firebaserules.rulesets.test`. It cannot read or write any data. |
| `rules-storage` | 8 `rules-storage-` observations, via the same `projects.test` endpoint | `PARITY_SA_BASE64`, same minimal scope. |
| `ai-logic` | 14 `ai-` observations: error, SSE-framing, envelope, function-call, and countTokens facts from the production Firebase AI Logic proxy | `PYRIC_AI_FIREBASE_CONFIG`. The project needs Firebase AI Logic enabled, with the Gemini Developer API backend reachable through the `firebasevertexai.googleapis.com` proxy. |
| `messaging-send` | 10 `messaging-send-` observations: what the production FCM v1 `messages:send` endpoint accepts, and its exact error envelopes | `PYRIC_MESSAGING_SA_BASE64`. The project needs Cloud Messaging (FCM v1) enabled. |

**Human-witnessed.** Cannot run on a CI worker, by nature.

| Rig | Captures | Why a human is required |
|---|---|---|
| `messaging-web` | 7 `messaging-web-` observations: token minting, `onMessage`, `onBackgroundMessage`, visibility routing, and `deleteToken` against live push | `PYRIC_MESSAGING_FIREBASE_CONFIG` plus `PYRIC_MESSAGING_VAPID_KEY` plus `PYRIC_MESSAGING_SA_BASE64`, AND a HEADED Chromium with a persistent profile. Incognito disables web push, so a persistent profile is mandatory; the harness re-execs under `caffeinate` on macOS. It cannot run headless. |

There is no emulator anywhere in this fleet, and there never will be. Every
observation is captured against real production, because an emulator's behavior
is only ever a claim about an emulator.

### The safety invariant: deploy, capture, restore, read back

`rtdb-rules` is the one rig that MUTATES a live Firebase project. RTDB has no
server-side rules test API, so the only way to learn what production does with a
ruleset is to deploy it and try. That makes the restore path a correctness
requirement, not a courtesy.

The rig's sequence, per run:

1. **Read** the project's current ruleset and its current data, and hold both.
2. **Deploy** the corpus ruleset to `/.settings/rules.json`.
3. **Capture**: execute each corpus case against the live database, as an
   anonymous user and signed out, recording production's ALLOW/DENY verdict.
4. **Restore** BOTH the prior ruleset AND the prior data.
5. **Read back** and byte-compare what was restored against what was held.

The read-back is the invariant. A restore that is not verified is a hope. If the
byte-compare fails the rig fails loudly, rather than leaving a project in an
unknown state. `src/check-rtdb-preflight.ts` runs before any of this and refuses
to start when the project is not shaped correctly, so the rig never gets halfway
through a deploy and only then discovers that the service account cannot write
rules back.

### The inert modes

Three things are safe to run with no credentials at all, and they are how you
reason about capture without performing it:

- `bun run oracle:plan` reads rig manifests and the environment. It opens
  nothing.
- `bun run compat:oracle-versions` checks committed observations against the
  installed SDK. It reads files only.
- `bun run compat:oracle-check` replays registry `conformanceChecks` against the
  COMMITTED observations. It never contacts production.

### Running a rig

Point the rig's env vars at the project and run its `script` (the path
`oracle:plan` prints for it). Each probe writes
`observations/<surface>/<name>.json`, overwriting in place.

**The git diff is the drift report.** An unchanged file means production still
behaves as pinned. A changed file means cloud behavior MOVED, and the affected
rows need review before you commit. Never commit a changed observation without
reading what changed.

## Add to the system

### The rule that outranks the rest

**Never edit a generated file.** They are:

- `packages/pyric/docs/*/COMPAT.md` and integration-owned COMPAT pages such as
  `packages/cli/docs/functions-rtdb/COMPAT.md` (from the registry, via
  `compat:generate`)
- `packages/cli/src/assurance/.generated/conformance-verdicts.ts` (ignored; via CLI prebuild or `compat:conformance`)
- `packages/conformance/rules-language/{coverage,capability,acceptance}-report.json` (via the three report scripts)
- `packages/conformance/baselines/*.json` (each via its own gate's `--update`)
- `packages/site-docs/src/content/docs/*` (via the docs-site port)

Each one has a gate that catches a hand edit. Editing one to make a gate pass is
the exact dishonesty this system exists to prevent: it changes the claim without
changing what is true.

### Admit a surface

A surface becomes real to every gate at once, because the gates iterate the
descriptors instead of hardcoding a list. Admission is two authored files plus
one registry-barrel import:

1. **One descriptor file**, `surfaces/<name>.ts`, exporting a
   `SurfaceDescriptorRecord`. The filename is the key. The record names the
   registry it hosts rows in, the observation filename prefixes it owns, and the
   capture rigs that produce them. Its `kind` is `mirror` for a Pyric package
   measured against an upstream export census, `native` for a Pyric-owned API,
   or `integration` for unchanged upstream source executed through a Pyric
   runtime seam.
2. **One registry file**, `registry/<name>.ts`, exporting a
   `CompatibilitySurfaceRegistry` with its `compatPath` and its rows.
3. **One import in `registry/index.ts`**, adding that registry to
   `registriesByKey` so descriptor loading can resolve its key.

After that wiring, `compat:validate`, `compat:report`, `compat:generate`,
`compat:audit`, `compat:coverage`, and `compat:oracle-check` all pick the surface
up from the descriptor with no further wiring. New surfaces are authored under
Conformance Driven Development (`docs/conformance/cdd.md`): rows are written
first and born `unverified`, a red conformance suite is derived from them, and
implementation flips a row only when its assertion set passes.

### Add a scenario

One record file: `rules-corpus/<engine>/<scenario-id>.ts`. Scenario ids are
unique across engines.

**The filename-twin rule** is what keeps the corpus honest. A scenario is
production-verified when it has an observation twin: a captured
`rules-firestore-` / `rules-storage-` / `rules-rtdb-` observation with the
matching name. The filename IS the join key. A captured observation with no
matching scenario is an orphan, and fatal in `compat:validate`. A scenario with
no observation twin is authored-but-unverified, and the analyzer will not credit
any construct to it.

The same twinning holds for probes: `probes/<surface>/<name>.ts` pairs with
`observations/<surface>/<name>.json`, and their surface directories must match.

### Add a rig

One record file: `rigs/<rig-id>.ts`, exporting a `RigManifestRecord` that names
its automation tier, its network posture, its `script` path, the observation
prefixes it owns, its required env vars, and its unverifiable-here requirements
(project features and local setup a manifest cannot check for itself).
`oracle:plan` picks it up automatically.

`rigs/` is deliberately FLAT, not nested under a surface. A rig is a capture
MECHANISM, not a service: `oracle-run` alone spans five surfaces, so nesting it
under one would force an arbitrary primary-surface choice for no benefit. Rig
support code that is not a manifest record lives under `src/capture/<rig-id>/`.

### Record a divergence

When the sandbox contradicts a committed observation:

1. **Pin both sides in the surface's conformance suite.** Assert the production
   value from the observation where it holds, and the sandbox's actual behavior
   alongside it, with a comment naming the divergence. Never weaken an assertion
   to make it pass.
2. **Flip the registry row** to `diverged-documented`, and rewrite its `behavior`
   and `evidence` to state both sides, citing the observation and the pinning
   test.
3. **Regenerate** (`compat:generate`) and re-run `compat:validate`.

When a divergence is later fixed, reverse the flow: the pinned test flips to
full-conformance assertions, the row flips to `conforms`, the docs regenerate.
The two-sided pin is what makes the fix's regression test already exist.

## Bump the firebase dependency

New upstream API arrives in exactly one way: a version bump in the lockfile.
The ritual, in order:

1. `bun run compat:oracle-versions` goes red: the pinned baseline no longer
   vouches for the installed SDK. Re-capture before trusting any conformance
   result.
2. `bun run compat:census -- --report` diffs the export surface. Every new
   unmapped symbol gets triaged into exactly one of: mirror it, deny it with an
   honest reason in `src/surface-denylist.ts`, or add it to the census baseline
   as tracked debt.
3. Read the upstream changelog between the two versions and annotate the census
   diff with intent. The census sees symbols, not meaning: a symbol that looks
   like plumbing may be a headline feature.

The census now sees both runtime export names and exported type names. Instance
methods, option-object fields, signature changes, and structural assignability
remain outside its proof. Those require a later assignability gate.

## Known rough edges

Documented so nobody has to rediscover them:

- **`compat:census` exits 1 on a healthy tree.** It is a report, and it exits
  non-zero whenever any symbol is unmapped, which is the normal state today.
  `compat:census-gate` is the gate. Do not wire `compat:census` into a pipeline
  that expects 0.
- **`audit-gate.ts` has no `compat:*` alias.** CI invokes it by path
  (`bun run packages/conformance/src/audit-gate.ts`), and so must you. Its
  ratchet overlaps `compat:coverage`'s high-risk-unverified regression check, so
  a new uncited high-risk row fails two gates rather than one.
- **The three rules-language reports have no aliases and NO FRESHNESS GATE.**
  Run the generators by path (see
  [Generators](#generators-they-write-files-never-edit-their-output)). Unlike
  `COMPAT.md`, nothing checks that a committed
  report still matches what its generator produces. A change that fixes the
  simulator without regenerating leaves the report UNDERSTATING the truth, and
  because `compat:conformance` reads these reports, the understatement propagates
  into runtime verdicts. This is not hypothetical: it has happened.
  Regenerate after ANY change to the corpus, the snapshots, or the simulator,
  and commit the result:

  ```sh
  bun run packages/conformance/src/rules-language-analyzer.ts
  bun run packages/conformance/src/rules-language-capability.ts
  git diff packages/conformance/rules-language/   # the diff is the report
  ```
- **`compat:coverage --json` prints its `bun run` banner to stderr**, so piping
  stdout straight into a JSON parser works with no redirection. The one-liners
  above rely on that.
