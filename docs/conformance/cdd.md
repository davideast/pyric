# Conformance Driven Development (CDD)

Status: DRAFT - owner review pending

This document codifies the process decided in wayfinder ticket #47. The
decisions themselves are settled; this document derives the mechanics from
them, grounded in the machinery this repository already runs (see
`packages/conformance/docs/how-to-run-the-conformance-system.md` and
`teach/GLOSSARY.md` for the vocabulary used here without redefinition).

The messaging surface is the first surface to run this loop, and its
committed `messaging-*` observations are used as the worked example
throughout.

## The decisions this document implements

1. Rows are authored first and born `unverified`. The registry is the
   single source of truth from day zero.
2. A red conformance suite is derived from the rows, one assertion set per
   row.
3. Implementation flips a row only when its assertion set passes.
4. The divergence taxonomy (held, by-design, pending-fix) applies from day
   one.
5. A dedicated non-blocking climb lane runs the climbing surface's suites
   and reports pass rate. A regression within green rows fails the lane.
6. `COMPAT.md` publishes at zero with a climb header, and `compat:report`
   gains a per-surface climb section.
7. Messaging v1 graduates when the capture demo page runs unchanged against
   `pyric dev` with the sandbox broker, and there are zero unknown gaps.

Everything below is mechanics in service of those seven points. Nothing
below changes them.

## Why the order inverts

The existing surfaces (auth, firestore, rtdb, storage) were built first and
measured after: code landed, then rows were written to describe it, then
observations were captured to back the rows. CDD inverts this for every new
surface. The claims exist before the code, every claim starts as an honest
`?`, and implementation is the act of turning specific claims green under a
suite that already exists and is already failing.

The one rule of the conformance system is unchanged: evidence flows in,
claims flow out, and only the registry changes claims. CDD adds a second
rule for new surfaces: claims exist before implementation, and no claim is
ever stated stronger than its evidence tier.

## Step 1: Admit the surface

Admission is the moment a surface becomes real to every script at once. It
is a data edit, because the scripts already iterate `surfaceDescriptors`
instead of hardcoding surface lists.

For messaging, admission means:

1. **Extend the `Surface` union** in `packages/conformance/registry/types.ts` to
   include `'messaging'`.
2. **Create the registry file** `packages/conformance/registry/messaging.ts`
   exporting a `CompatibilitySurfaceRegistry` with
   `compatPath: 'packages/pyric/docs/messaging/COMPAT.md'` and the row
   blocks described in step 2.
3. **Add the descriptor** to `packages/conformance/registry/index.ts`:

   ```ts
   {
     surface: 'messaging',
     registry: messagingRegistry,
     observationPrefix: 'messaging-',
     conformanceSuite: 'packages/pyric/test/messaging/oracle-conformance.test.ts',
   }
   ```

   This replaces the current placeholder descriptor that parks the
   `messaging-` prefix on the auth registry. The `conformanceSuite` field
   already exists on `SurfaceDescriptor` as future wiring; CDD is the thing
   it was waiting for. The descriptor also gains a `climb: true` marker (a
   new optional field) so the climb lane knows which surfaces it owns.
4. **Retire the exceptions.** The `messaging-*` entries in
   `observationExceptions` exist only because the captures predate the
   rows. Once rows cite those observations, the exceptions are deleted.
   `compat:validate` then enforces normal linkage: every `messaging-`
   observation must be cited by a row or carry a written exception.

After admission, `compat:validate`, `compat:report`, `compat:generate`,
`compat:audit`, and `compat:oracle-check` all see the surface with no
further wiring. That is the point of the descriptor list.

## Step 2: Author the rows, born unverified

Rows are authored from two inputs and only two inputs:

- **The census** defines the shape universe. `bun run compat:census`
  diffs the upstream export set for the mirror pair; every upstream export
  that the surface intends to mirror becomes at least one row, and every
  export it does not becomes a denylist entry with an honest reason. The
  census sees shape, never behavior, so census-derived rows describe what
  exists, not what it does.
- **The committed observations** define the behavior facts. The seventeen
  `messaging-*` observations (send-plane envelopes such as
  `messaging-send-invalid-token-error-envelope`, receive-plane facts such
  as `messaging-web-token-shape` and `messaging-web-visibility-routing`)
  are frozen, version-stamped records of what production did. A row's
  `behavior` text may state a production fact only where an observation
  vouches for it, and the row cites that observation in
  `oracleObservations`.

Every authored row lands with `status: 'unverified'` and
`automation: 'unverified'`. This is the evidence-tier rule in registry
form, and it applies the policed distinction directly: a row that cites an
observation is **observed** (production was consulted, at a date, at a
version). It is not **conforms**, because conforms means the sandbox
matches the pinned record offline, and no sandbox exists yet. Citation is
not replay. A born-unverified row with a citation says "here is what
production does and we have not yet built the thing that matches it,"
which is exactly true.

Rows whose behavior has no observation yet are still authored (the census
says the shape must exist), but their `behavior` text is written from
upstream documentation and marked as such in `evidence`. They carry
`riskReasons` accordingly, and they are candidates for new probes in
`packages/conformance/src/run.ts` before their implementation starts.

The registry is the single source of truth from day zero: the generated
`COMPAT.md`, the report, the audit, and the suite all derive from these
rows from the first commit. Nothing waits for implementation.

## Step 3: Derive the red conformance suite

The suite is derived from the rows, not the other way around. For
messaging it lives at
`packages/pyric/test/messaging/oracle-conformance.test.ts`, the path named
in the descriptor.

- **One assertion set per row.** Each row id gets exactly one named block
  in the suite. The block asserts, against the sandbox, the facts the
  row's `behavior` claims, replaying cited observation values where they
  exist. Where the row cites an error-envelope observation, the assertion
  set asserts the envelope fields from the JSON, never re-derived by hand.
- **Red at birth, by design.** At authoring time the sandbox does not
  implement the surface, so the assertion sets for unverified rows fail.
  This is correct and expected. The suite is the surface's definition of
  done, written before the work.
- **The completeness gate carries over unchanged.** The suite ends with
  the same completeness test the existing suites use: every observation
  with the `messaging-` filename prefix must be asserted in the suite or
  listed in its `NOT_APPLICABLE` map with a written reason. Because rows
  cite observations and assertion sets replay rows, an observation that no
  assertion set touches is a signal that either a row or an exception is
  missing.

Because the suite is red, it cannot join the blocking test run in
`.github/workflows/build.yml` (`npm run test`). It is excluded from the
blocking run and executed only by the climb lane (step 5) until
graduation. Local runs use the ordinary command:

```sh
bun test packages/pyric/test/messaging/oracle-conformance.test.ts
```

## Step 4: Implementation flips rows

A row changes status in exactly one way: the PR that makes its assertion
set pass also edits the row. The flip is part of the same change, reviewed
together.

The flip checklist for a single row:

1. The row's assertion set in the conformance suite passes against the
   sandbox, unweakened. Assertions are never loosened to make a flip
   possible.
2. The registry row flips `status` to `conforms` and upgrades `automation`
   to the honest tier (`oracle-backed` when the assertion set replays a
   cited observation, `unit-backed` when it does not).
3. Where the row is high-risk and observation-backed, the flip adds a
   `conformanceChecks` entry (finding, observation, expect block, probe,
   guards). This enrolls the row in `compat:oracle-check`, which runs
   blocking in `build.yml` and verifies the committed observation's values
   still match the row's expect block, so neither the capture nor the
   claim can drift silently.
4. `bun run compat:generate` regenerates the docs; the diff shows exactly
   the rows that flipped.
5. `bun run compat:validate` and `bun run compat:audit` stay green. The
   audit gate already fails any PR that introduces a new conforms row with
   no oracle citation on the high-risk worklist; CDD relies on that ratchet
   rather than duplicating it.

Behavior the sandbox will not match takes the divergence path instead
(step 6). Behavior the sandbox will never implement flips to
`unsupported` with a written reason. No row flips to `conforms` by
argument, only by a passing assertion set.

## Step 5: The climb lane

The climb lane is the CI home for red suites. It is a **report** about the
climb and a **gate** only against regression, and the design keeps those
two roles from blurring.

**Job shape.** A separate job in `.github/workflows/build.yml` (or a
sibling `climb.yml` workflow), `needs: build-and-test` so it runs against
built packages, driven by a script (working name
`packages/conformance/src/climb.ts`) that:

1. Iterates `surfaceDescriptors` and selects descriptors marked
   `climb: true`.
2. Runs each descriptor's `conformanceSuite` via `bun test`, collecting
   per-assertion-set results and mapping them back to row ids.
3. Computes the pass rate: assertion sets passing over assertion sets
   total, alongside the registry's own count of conforms rows over total
   rows. The two numbers should agree; disagreement means a row and its
   assertion set have drifted and the lane says so.
4. Writes the per-surface summary to the job summary so the climb is
   visible on every PR without opening logs.
5. **Exits nonzero if and only if a green row regressed**: any row whose
   registry status is `conforms` whose assertion set failed. Failures of
   unverified rows are the expected red and never affect the exit code.

**Non-blocking, precisely.** The lane is not listed among the repository's
required status checks, so its red state never prevents a merge. That is
what non-blocking means here, and nothing else. The lane still turns red
(nonzero exit) on a green-row regression, and that red is the signal to
act. Green rows are not left unguarded by this arrangement: every flipped
row's suite membership is one lane run away from detection, and every
flipped row with a `conformanceChecks` entry is additionally protected by
the blocking `compat:oracle-check` gate in the main build. On graduation
the whole suite moves into the blocking test run and the lane drops the
surface.

## Step 6: Divergence from day one

The divergence taxonomy is not deferred to maturity. From the first
implementation PR, when the sandbox contradicts a committed observation
the existing recording procedure applies verbatim:

1. Pin both sides in the surface's conformance suite: assert the
   production value from the observation where it holds and the sandbox's
   actual behavior alongside, with a comment naming the divergence.
   Assertions are never weakened to pass.
2. Flip the registry row to `diverged-documented` and rewrite its
   `behavior` and `evidence` to state both sides, citing the observation
   and the pinning test.
3. Classify the divergence in the row's notes as held (waiting on
   evidence), by-design (deliberate), or pending-fix (acknowledged
   defect).
4. Regenerate the docs and re-run `compat:validate`.

For the climb lane, a `diverged-documented` row counts like a green row:
its two-sided pin is expected to pass, and a failure of the pin is a
regression that fails the lane. When a pending-fix divergence is later
fixed, the flow reverses as it does today: the pin flips to
full-conformance assertions, the row flips to `conforms`, and the
regression test for the fix already exists.

The messaging captures make the day-one need concrete: the send-plane
error envelopes (`messaging-send-oversized-payload-error-envelope`,
`messaging-send-invalid-condition-error-envelope`, and their siblings)
pin exact production error shapes that a young sandbox broker is likely to
approximate before it matches. Those approximations are divergences to
classify, not failures to hide.

## Step 7: Publish at zero

`COMPAT.md` for a climbing surface publishes with the first authored rows,
when the conforming count is zero. Honesty at zero is the feature: the doc
tells a reader exactly what is promised (nothing yet) and exactly what the
targets are (every row).

**The climb header.** `packages/conformance/src/generate-docs.ts` renders a block at
the top of a climbing surface's doc, above the status legend, derived from
the registry alone (only the registry changes claims, and the generated
doc is a view of claims):

```
> **Climb status: this surface is climbing under CDD.**
> 3 of 34 rows conforming. 29 unverified, 1 diverged-documented, 1 unsupported.
> A `?` row below is a target with a derived failing test, not a guarantee.
```

The counts come from row statuses. Live suite results do not appear in the
doc, because the doc is a view of claims and suite results are evidence in
flight; the lane's job summary and `compat:report` carry those.

**The report's climb section.** `packages/conformance/src/report.ts` gains a
`## Climb` section listing each climbing surface with: total rows, counts
by status, the conforming ratio, high-risk unverified rows under that
surface, and orphan observations under its prefix. The section informs; it
never fails the run. The only climb-related exit-code behavior in the
system is the lane's green-row regression rule.

## Step 8: Graduation

Graduation criteria for messaging v1, as decided:

1. **The capture demo page runs unchanged against `pyric dev` with the
   sandbox broker.** Unchanged means zero source edits to the page; only
   the wiring that points it at the sandbox may differ. The page
   exercising real token mint, foreground and background message routing,
   and visibility routing against the broker is the end-to-end proof the
   rows cannot give individually.
2. **Zero unknown gaps.** Every gap is classified, none is unknown:
   - No `unverified` rows remain. Every row is `conforms`,
     `diverged-documented` (classified held, by-design, or pending-fix),
     `bug` with a pinned failing probe, or `unsupported` with a written
     reason.
   - `compat:census` reports no UNMAPPED messaging symbols; everything is
     mirrored or denylisted with a reason.
   - `compat:report` shows no orphan `messaging-` observations.

The graduation checklist, run from a clean tree:

```sh
bun test packages/pyric/test/messaging/oracle-conformance.test.ts  # fully green
bun run compat:validate
bun run compat:generate && git diff --exit-code packages/pyric/docs
bun run compat:census
bun run compat:oracle-versions
bun run compat:oracle-check
bun run compat:audit
# plus the demo page criterion, verified per the owner's chosen mechanism
```

Graduation actions: the descriptor drops `climb: true`, the suite joins
the blocking test run alongside the auth and firestore suites, the climb
header comes off the generated doc, and the surface leaves the report's
climb section. From that day the surface is governed by the ordinary
rules in the how-to-run guide and nothing in this document applies to it.

## Step 9: The next surface reuses the loop

The loop is the deliverable, not the messaging surface. For the next
surface the sequence is the same nine steps with new names:

1. Capture or collect the first observations under a new filename prefix,
   parked via `observationExceptions` only until admission.
2. Admit: extend `Surface`, add the registry file with its `compatPath`,
   add the descriptor with prefix, suite path, and `climb: true`.
3. Author rows from census plus captures, all born `unverified`, claims
   never exceeding evidence tier.
4. Derive the red suite, one assertion set per row, with the completeness
   gate on the prefix.
5. The climb lane picks the surface up automatically from the descriptor.
6. `COMPAT.md` publishes at zero with the climb header; the report grows
   the surface's climb entry.
7. Implementation flips rows; divergences are classified as they appear.
8. Graduate against that surface's own criteria (decided per surface, see
   open questions), then drop the climb marker.

Two descriptors may share one registry and one doc, as `rtdb` and
`rtdb-modular` do today, when a surface has two capture planes that
readers should see as one contract.

## Open questions, resolved (owner, 2026-07-09)

The eight questions this draft originally posed were answered by the owner; each answer is now a decision of this process.

1. Climb lane cadence: not per PR. The climb is an experiment and must cost main-branch velocity nothing. The lane runs on demand on the surface's WIP branch; a nightly run is optional. All messaging mirror code is flag-gated and stays on a WIP branch until the owner judges it safe to merge.
2. Regression escalation: a lane failure on an already-green row halts further row flips until fixed, fix-forward on the WIP branch. No automation (auto-filed issues, required checks) during the experiment phase.
3. Receive-plane harness: row assertions run headless (bun) against the in-process broker, like every other surface's suite. The real-browser demo page is reserved as the graduation check, not a per-run harness.
4. Surface partitioning: two surfaces, messaging (client and sw rows, pyric) and messaging-admin (send rows, pyric-admin), sharing one registry file and one COMPAT doc, on the rtdb / rtdb-modular precedent. Per-surface conformanceSuite paths resolve the cross-package suite question.
5. Row-universe sign-off: packages/conformance/docs/messaging/surface-inventory.md is the signed v1 universe; the registry file header cites it. Instance-method and option-field completeness closes with the tier-2 assignability census.
6. Audit ratchet: climbing surfaces are exempt from the audit gate until graduation. Isolation is the WIP branch plus flag-gated exports; the mirror does not merge until the owner calls it safe.
7. conformanceChecks at flip: match the current ratchet; only rows above the audit's high-risk line enroll in blocking compat:oracle-check.
8. Demo-page criterion: manual owner sign-off during the experiment, recorded in the graduation PR; automated at graduation by driving the demo page against pyric dev with the existing capture rig.

## Relationship to existing documents

- `packages/conformance/docs/how-to-run-the-conformance-system.md` remains the
  operational guide; every command named here is documented there. CDD
  changes when things happen, not how they run.
- `teach/GLOSSARY.md` is the vocabulary authority. This document uses
  observation, registry, conformance suite, divergence, census, report,
  and gate in exactly the glossary senses, and leans on the policed
  distinctions (observed vs conforms, cited vs replayed, shape vs
  behavior, report vs gate) rather than restating them.
