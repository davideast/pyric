# Planning when to hunt and ranking surfaces

A round spends multiple hunters, clean-room verifiers, and coordinator-only
captures. Triage points that effort at the surfaces where a green suite is
least trustworthy and a missed defect hurts most.

## 1. Criticality tiers (the floor)

Rank inherent blast radius first. Criticality sets a floor, not a tie-breaker,
so unhunted movement in Tier 1 outranks cosmetic or wrapper churn anywhere else.

| Tier | Surfaces | Why |
|---|---|---|
| **Tier 1 (always highest): Security Rules** | Rules grammar/compilers (`rtdb`, Firestore/Storage Security Rules -- not Google CEL, `2+modules`), simulators, Firestore `list`-query provers, `getAfter` batch projection, deploy validators, sandbox rule enforcement, `pyric/rules` and `verify`, Live Mode local-rules verdicts, static/dynamic `assurance` passes | A false `allow`, missed query proof, or wiped ruleset ships an authorization hole or gives false assurance. |
| **Tier 2: Isolation and credential guards** | `@pyric/cli/register` Swap-or-Stop hooks, `next` and Vite module swaps, worker/child-process guards, Live Mode write refusals (`PYRIC_LIVE_REFUSED`), token/secret redaction, loopback auth/origin checks | A miss lets sandboxed code hit production endpoints or leaks credentials. Production has no oracle for pyric's own isolation boundary. |
| **Tier 3: Stateful SDK, Admin, and host planes** | Sandbox `firestore`, `database`, `storage`, `auth`, `app-check`, `ai`, `messaging`; `pyric-admin` local and remote arms; SharedWorker and Hosted Node transports; snapshots, branches, checkpoints, state files, Cloud Functions runtime | Silent state drift, dropped metadata, or cross-plane divergence breaks apps between local dev and production. |
| **Tier 4: Tooling, CLI/MCP, UI, clients** | MCP tool records and CLI wrappers, Vite plugin non-guard glue, Studio and `@pyric/ui`, `create-pyric` templates, native remote clients, conformance tooling | Failures are usually visible UX or developer-ergonomic bugs rather than silent security or data-plane corruption. |

## 2. Unhunted runtime churn (`<last-hunt-sha>..origin/main`)

Raw 30-day commit counts mislead once a surface has just been hunted. Measure
each surface from the target commit recorded in its most recent hunt ledger (or
the 30-day window if it has never been hunted), and count **runtime `src` files
separately from `test` files** so test-only additions do not masquerade as
runtime risk.

On partial (`--filter=blob:none`) clones, `git log --numstat` fetches thousands
of intermediate blobs one by one. Use tree-only log scans paired with a single
endpoint diff per window:

```sh
# 1. Commits, fix(...) share, and distinct files touched (tree-only, zero blob fetches)
git log --no-merges --name-only --format='COMMIT|%H|%ct|%s' <last-hunt-sha>..origin/main

# 2. Added/deleted lines and newly created files across the window (one tree-pair diff)
git diff --numstat <last-hunt-sha> origin/main -- packages/
git diff --name-only --diff-filter=A <last-hunt-sha> origin/main -- packages/
```

Collect five signals per surface over `7d`, `14d`, `30d`, and
`<last-hunt-sha>..origin/main`:

- **Unhunted `src` diff lines (`+LOC + -LOC`)** and **share of the surface's
  `src` files touched** since `<last-hunt-sha>`.
- **New `src` files (`--diff-filter=A`)** since `<last-hunt-sha>`: brand-new
  modules carry fresh boundary assumptions no earlier hunter read.
- **Bugfix density (`fix(...)` / total `src` commits in 7d-14d)**: a high fix
  share (`>= 3` fixes or `> 60%` of recent commits) means bugs were found one
  at a time; sibling paths usually share the root cause.
- **Post-hunt fix waves**: when a hunt's own remediation merges `500+` runtime
  `src` lines *after* `<last-hunt-sha>`, schedule a focused follow-up round on
  the touched seams and cross-feature interactions.
- **Open confirmed backlog**: count confirmed `REAL` findings from the prior
  round whose fixes have not merged yet.

## 3. Coverage and referee thinness

Scorecards and passing tests overstate coverage when assertions are shallow or
two pyric planes share one helper. Measure per surface:

- **Referee strength** (strongest to thinnest):
  1. Standing production oracle + multi-plane differential fuzzer (e.g. RTDB
     rules + `rtdb-differential`).
  2. Standing production oracle on single-plane captures (e.g. Rules Test API,
     SDK scenario captures), without a cross-plane fuzzer.
  3. Partial observations mixed with contract tests (e.g. Auth claim matrix,
     `pyric-admin` arms).
  4. **Contract-only or sibling-only referee** (Swap-or-Stop, Live Mode
     local-rules over partial session state, static/dynamic assurance passes,
     snapshot/branch persistence, Studio). These deserve higher hunt frequency
     per line changed because CI has no external production check.
- **Test-to-source line ratio (`test LOC / src LOC`)** and **share of non-barrel
  `src` files (`>= 20` LOC) with no matching `<stem>.test.*` file** in the
  package. A ratio below `1.0` or `> 40%` unmirrored `src` files marks thin
  direct coverage.
- **Conformance and test pins**: registry rows marked `unverified`, `bug`, or
  `diverged-documented`, `KNOWN_DIVERGENCES` entries, and `.todo` / `.skip`
  calls.

## 4. Cadence: when to trigger vs when to hold

| Decision | Condition |
|---|---|
| **Hunt immediately** | **Tier 1 (Security Rules)** or **Tier 2 (isolation/refusal)** lands a new evaluator/prover/pass, drops or replaces a guard, or accumulates `>= 250` unhunted `src` diff lines (`>= 15%` of surface files). |
| **Hunt immediately** | A **new package or public entrypoint** lands with contract-only or sibling-only refereeing (`0` production observations). |
| **Hunt immediately** | A **bugfix cluster** (`>= 3` `fix(...)` commits in 7 days on one surface, or any Sev-1 escape from app usage) signals adjacent unfound defects. |
| **Post-wave delta hunt** | A prior hunt's fix campaign lands `>= 500` runtime `src` diff lines after `<last-hunt-sha>`: run a targeted round on the rewritten files and their plane boundaries. |
| **Scheduled churn hunt** | Unhunted `src` diff since `<last-hunt-sha>` crosses **`>= 1,000` lines** (or `>= 25%` of files) on **Tier 3**, or **`>= 2,500` lines** on **Tier 4**, or before promoting a release dist-tag (`latest`). |
| **Hold (land fixes first)** | The surface already has an unmerged batch of confirmed `REAL` findings from its previous hunt. Land those fix streams first so hunters do not spend a round rediscovering open repros; if urgent new `src` landed alongside them, scope hunters strictly to the new files and pass the open repro list as exclusions. |
| **Build standing check first** | The prior round's `Yield by class` ledger shows a repeat class (`>= 3` confirmed findings or consecutive-round repeats in one `Class` / `SD:*` sub-class; see [defect-classes.md](defect-classes.md)). Land the class-level mechanical check before re-hunting the same mechanism. |
| **Rest** | `<last-hunt-sha>..origin/main` has `< 50` runtime `src` diff lines on the surface and the last round exited with `0` new findings across consecutive angles. |

## 5. Output of a triage pass

Produce one ranked table before launching hunters:

`Rank | Surface | Tier | Referee | Src LOC | Test/Src | Unmirrored % | 7d Churn | Unhunted (<sha>..HEAD) | Open Backlog | Action (Hunt Now / Land Fixes First / Rest)`

Name the top 1-3 ready-to-run hunts, the exact `src` paths and angles from
[workstreams.md](workstreams.md) each will run, and which surfaces wait on
in-flight fix waves.
