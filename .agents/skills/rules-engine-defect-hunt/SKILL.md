---
name: rules-engine-defect-hunt
description: Hunt for defects in pyric's own rules engines (RTDB, Firestore, Storage) — the simulator, constraints DSL, deploy-time validator, security lint, sandbox enforcement, replay and coverage — by checking each against production, pyric's documented contract, or its sibling surfaces. Use when asked to find bugs in pyric's rules tooling, stress-test or audit a rules engine for parity with Firebase, verify or re-verify a batch of engine findings, capture production verdicts for disputed behavior, or plan and land a fix campaign for engine divergences. Not for auditing an app's rules (use firestore-rules-audit or rtdb-security-rules).
---

# Rules engine defect hunt

Pyric promises a developer that a local rules verdict is the verdict Firebase
will give. A rules engine that says ALLOW where production says DENY is the
worst failure pyric can have: the hole ships. A green suite does not rule this
out. The suite tests what the code does, and the defects live where the code
quietly departs from what it promises.

This skill runs a campaign that finds those departures, proves each one, and
lands the fixes without bending a test to fit. One campaign on the RTDB engine
turned a 2,225/2,225 green suite into 53 findings, 49 real, and took the RTDB
rules score from an honest 69/91 to 91/91.

## Where the defects are

Look at **boundaries**, not at the expression evaluator everyone already tests:

- **Accepted, then ignored.** A documented field, option or argument that is
  parsed and silently dropped, merged or coerced (`lit(undefined)` becoming
  `false`; a documented `updates` field `simulate()` never read).
- **Two surfaces that should agree, and don't.** The simulator vs the sandbox
  vs replay; `rtdbRules(doc)` vs `rtdbRules(doc.toJSON())`; the CLI deploy check
  vs the library and MCP surfaces.
- **Undeployable input evaluated anyway.** Rules production rejects at deploy
  must not be simulated as if they were valid.
- **Runtime semantics borrowed from JavaScript.** Coercion, `null` indexing,
  division by zero, `.length` on non-strings: production errors where JS
  shrugs.
- **Composition.** A builder that loses parentheses when an operand contains a
  character it does not expect.

## The verdict rule

Every finding gets exactly one verdict, from something that was actually run:

| Verdict | Means |
|---|---|
| `REAL` / `OPEN` | A repro shows the defect, and the expected behavior is cited |
| `FALSE` | The claim does not hold, or the cited evidence contradicts it |
| `ALREADY_FIXED` | The repro shows correct behavior; name the commit if you can |
| `NEEDS_RUNTIME_MRE` | Correctness depends on production behavior no observation captures |

**Every expected value cites its source.** One of: (a) an observation file, the
exact `behavior` field, and the probe line that produced it; (b) an official
Firebase docs URL with a quoted sentence; (c) pyric's own documented contract
(JSDoc, docs page) for pyric-only surfaces. Without a citation the verdict is
`NEEDS_RUNTIME_MRE`, never `REAL`. Check existing observations first: an
observation can refute a confident hunter (an onDisconnect "bug" turned out to be
exactly what production does).

**A uniform batch is a red flag.** 9/9 REAL or 17/18 OPEN means re-check a
sample yourself before accepting it. Both times this happened, the re-check
changed verdicts.

**A repro that cannot flip is not evidence.** It asserts the correct behavior and
prints OPEN or FIXED. A script that can only print "bug" proves nothing.

## The campaign

Run it as advisor and coordinator. Workers hunt, verify and fix; you route work,
keep verdicts calibrated, spot-check, and run every production capture yourself.
Phases 2, 3 and 5 parallelize well (one agent per workstream or stream, a shared
board, briefs from [templates/](templates/)).

### 0. Baseline

Record the target commit and run the gates (see
[references/pyric-gates.md](references/pyric-gates.md)): build, the engine's
suite, `bun run compat:check`, `bun run compat:rules-score`. Then measure where
evidence is thin before trusting anything:

- grammar features × production observations (how many constructs have zero
  observations?);
- mutation testing over the engine's source (surviving mutants are leads);
- which documented options have no test that mentions them.

### 1. Frame

Map each surface to its referee: production, documented contract, or a sibling
surface. Choose workstreams from
[references/workstreams.md](references/workstreams.md) by expected yield. Write
the plan down; the ledger starts here ([templates/ledger.md](templates/ledger.md)).

### 2. Hunt

One hunter per workstream ([templates/hunter-brief.md](templates/hunter-brief.md)).
Hunters write a repro per finding under a scratch directory, never in the repo,
and post findings with severity:

1. fail-open — rules looser than intended, or data exposed;
2. wrong verdict in a testing tool — false confidence;
3. deploy-time failure;
4. cosmetic.

Record clean results next to findings. "10,000 fuzzed expressions, 0 crashes" is
a result.

### 3. Verify

Separate agents re-run every repro on a clean checkout
([templates/verifier-brief.md](templates/verifier-brief.md)) and apply the
verdict rule, splitting multi-part findings into sub-claims. You spot-check a
sample, always including the highest-severity findings and any whose expected
value rests on production behavior.

### 4. Ask production

For every `NEEDS_RUNTIME_MRE` that matters, author a corpus scenario and capture
production's verdicts. Follow the runbook for the engine:

- RTDB: deploy, observe, restore on a dedicated instance —
  [references/oracle-rtdb.md](references/oracle-rtdb.md).
- Firestore and Storage: the Rules Test API, no deploy —
  [references/oracle-rules-test-api.md](references/oracle-rules-test-api.md).

Production may refute a finding. Record that as `FALSE`, prominently.

### 5. Pin, then fix

Land the evidence **before** any fix: new scenarios, observations, registry
rows, and a pin for every disagreement (`KNOWN_DIVERGENCES` and its siblings).
The published score drops honestly. Each fix then removes its pin, watches the
case go red, and makes it green. Plan the fix as parallel streams with disjoint
file ownership — [references/fix-campaign.md](references/fix-campaign.md). Any
PR that moves a published number gets the
[coverage-adversary](../coverage-adversary/SKILL.md) audit.

### 6. Ship

Split PRs by reviewer concern, verify each branch tip, and merge in dependency
order — [references/shipping.md](references/shipping.md). It lists the traps
(stacked bases, packing, stale generated files) that each cost time once.

### 7. Follow up

Re-verify what the campaign deferred against current `main` with the same
verdict rule, then file issues for what is still open, restart-safe and
de-duplicated ([references/shipping.md](references/shipping.md#filing-issues)).

## Hard rules

- Never edit a test, observation or expectation to make a result come out. An
  unexpected green usually means already fixed: report it. Frozen observations
  change only by re-capture.
- Never deploy to anything but the dedicated oracle instance, and never run two
  captures at once. Never print key material or tokens.
- Report what failed. The final ledger lists `FALSE`, `NEEDS_RUNTIME_MRE` and
  unverified items next to the confirmed ones.
- Issues and PR text describe the engine, generically. They do not name the app
  or project that prompted the hunt.
