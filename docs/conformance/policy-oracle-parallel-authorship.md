# Parallel authorship for the policy oracle

**Recommendation.** Make a versioned claim the unit of ownership, a probe the unit of parallel authoring, and a capture the unit of evidence. Give each a stable path that the runner discovers. Two agents adding evidence to the same game, or even to the same claim, should normally add different files. Changes to the meaning of the same claim should require reconciliation.

This is a design proposal based on Pyric main at `b30fa6a7d` and the Arcade oracle at `222744786`. The rehearsal exercises repository layouts with synthetic records. The separate Arcade replay uses the frozen production observations.

## What the rehearsal found

Twelve branches started from the same base with ten claim definitions already present. Two branches added different probes to the Tally ordered-fold claim. Two added probes to the same tic-tac-toe increment claim, and a third worked on turn ownership. The other seven covered UNO, Reversi, Sokoban, Battleship and Checkers. Every branch added one probe and one synthetic receipt. The index-based alternatives also registered that probe in a shared JSON list.

| Contribution layout | Clean pairwise Git merges | Conflicts |
|---|---:|---:|
| One index for the oracle | 0/66 | 66 |
| One index per game or workload | 60/66 | 6 |
| One index per claim | 64/66 | 2 |
| Discover independent probe directories | 66/66 | 0 |

Eight full integration orders for the discovered layout produced the same Git tree, with all ten claims, twelve probes and twelve observations. A repeated observation earned no extra claim credit. An incompatible second verdict and a changed recipe both merged cleanly in Git; the miniature validator classified the former as disputed and the latter as stale. Two incompatible definitions at the same new claim/version path produced an intentional add/add conflict. These measurements cover the modeled contribution pattern. They do not estimate the conflict rate for edits to shared engine or adapter code. Run `python3 experiments/policy-oracle/merge-study.py` with Git 2.43+ and Python 3. The script prints the private scratch directory containing its four local repositories. [Rehearsal source](../../experiments/policy-oracle/merge-study.py) · [Git merge-tree](https://git-scm.com/docs/git-merge-tree)

## Repository layout

Introduce these directories as siblings of the existing `experiments/policy-oracle/arcade/`. Keep the archive at its current paths.

```text
policy-oracle/
  arcade/                                  existing v1 receipts, rules, scorer and commands
  core/                                    discovery, validation, replay and reporting
  schemas/v1/                              file formats
  profiles/<profile>/<version>/            shared pinned runtime, dependencies and lock
  adapters/<adapter>/<version>/            standalone evaluator or Firestore capture
  suites/<family>/<subject>/
    claims/<claim>/v1/
      claim.json                           meaning, eligible authority, result to compare
      obligations/<id>.json                required witness and referenced probe version
      probes/<probe>/v1/
        recipe.json                        inputs, dependency references, effect to observe
        fixtures/                          small typed data or references to shared fixtures
        observations/<run-id>.json         normalized result and provenance hashes
      resolutions/<id>.json                reviewed disposition of a specific disagreement
  baselines/<release-id>/                  optional frozen inventory created at release time
```

A new suite can start with its first claim directory. Everyday contributions need no suite manifest, root export, workflow entry, central case list, package version bump or findings-table edit. Reserve `core`, schemas, profiles and adapters for actual shared behavior changes. Use one stable experimental replay entry point and a path-based dispatcher. A new dependency belongs to an explicitly versioned profile; ordinary probes reuse a pinned profile. Render indexes, tables and totals from discovery. Release engineering can freeze a snapshot once per named baseline. When exposed through Pyric's conformance registry, admit the native policy surface and dispatcher once. Follow Pyric's per-PR assurance-count delta convention for changes to the actual registry node count. [Row discovery](../../packages/conformance/registry/section-rows.ts) · [Rig discovery](../../packages/conformance/rigs/load.ts) · [Count and observation layout](../../packages/conformance/README.md)

**A contributor's write set.** An agent defining a claim writes its specification and initial obligations. An agent adding a probe writes one new probe directory and, when it becomes a scoring requirement, one new obligation file. An agent repeating a probe adds only its observation file. Independent captures get unique run IDs, with hashes for both raw and normalized evidence. Two probes may refer to one read-only fixture by digest. For evidence shared between claims, one obligation can cite an existing probe by its fully qualified ID and digest. The compiler author works in a different worktree against a frozen inventory. Claim admission and changes to the expected answer receive independent review.

**Tally and Arcade can divide the work further.** `language/collections` owns the general fold semantics. `satisfy/tally` owns the domain rule that, starting at 90, strike then erase gives 89 and erase then strike gives 90. An independent decimal-digit example can witness fold order without a Firebase project. Tic-tac-toe can separately own counter and turn claims. UNO draw and play agents can contribute in parallel, as can Reversi move and pass agents. Use fully qualified IDs in all references, so names like `move` can recur across games. Report coverage by language, compiler target and workload. Additional game examples can exercise an existing language claim without increasing the language denominator.

## What must still conflict or fail validation

- **Pin the inputs for each probe.** Cover the claim and recipe versions, typed pre-state and inputs, actor, expected effect type, fixture and adapter revisions, runtime profile, and the exact control/candidate bundles where relevant. Keep observed outcomes separate from predictions. An unrelated probe cannot invalidate these pins. Changing the meaning or inputs of a frozen probe creates a new version; older observations remain replayable. Preserve original bytes privately where needed and verify the link to a portable normalized receipt.
- **Check the merged tree.** Discover in stable path order, enforce unique names including case folding, resolve references and digests, and reject cycles, missing obligations, unexpected case sets and unsupported evaluator responses. Every admitted obligation must appear in the inventory even while evidence is missing. Compare against the reviewed base inventory to expose deleted or weakened obligations. A protected release can pin mandatory IDs. The candidate branch cannot silently shrink its denominator.
- **Handle competing observations explicitly.** Group comparable runs by claim/probe version, typed input, target, deployment and authority. Identical verdicts and expected effects can corroborate a claim. Different verdicts or relevant post-states mark it disputed, block promotion, and retain both receipts. A resolution names the conflicting hashes and the reason. Conflicting resolutions require adjudication. Partial runs and infrastructure failures remain visible separately. A timestamp or merge order cannot decide a question of semantics.
- **Separate authoring from scheduling.** In CI, infer work from touched paths and their reverse dependencies. A profile or adapter change replays every consuming suite. An integration run validates the complete inventory and runs the offline release suite, including the frozen Arcade controls. Keep reports as CI artifacts or build output. A clean Git merge alone has no bearing on conformance.
- **Serialize scarce live resources.** Offline agent work and replay can run concurrently in separate worktrees with per-run output. A Firestore rules release applies to a database. A trusted capture runner therefore owns the lock for the target project, database UID and release through capture, restoration and verification. Two runs changing the same release queue, even when their document prefixes differ. Different expressly allocated databases can have separate queues. Before switching or restoring, verify lock ownership and the expected current release; quarantine an interrupted target until it has been reconciled. Publish production evidence only from authenticated SDK writes with server readbacks. Keep candidate/PR code off the credentialed executor until reviewed. Reuse the Arcade release propagation controls. [Existing capture lock](../../experiments/policy-oracle/arcade/live/control.mjs) · [Write propagation and readbacks](../../experiments/policy-oracle/arcade/live/capture.mjs) · [Firestore database rules scope](https://firebase.google.com/docs/firestore/security/rules-structure)

## Migration and acceptance

1. **Preserve Arcade v1.** Add a read-only adapter that consumes its existing evidence and exposes its two claims with stable qualified IDs. Reuse the original record pins and keep the original replay available. Verify the old replay and the new adapter independently produce 21/21 decisions, two evidenced and conforming claims, four mutant false allows and four mutant false denials. The archived run that failed the propagation check keeps its incomplete status. [Existing results and full match readbacks](../../experiments/policy-oracle/arcade/FINDINGS.md)
2. **Land the shared discovery and validation interfaces once.** Test duplicate IDs, stale pins, contradictory answers, incomplete evidence and deletion of a released obligation. Verify independent changes never require re-signing a whole corpus. Publish a release inventory digest from sorted, versioned inputs; preserve the authoring Git commit independently for provenance.
3. **Pilot with real agents.** Start from the same commit. Give one agent the Tally contract and independent fold witnesses, a second an Arcade game claim, and a third a different probe in an already-defined Arcade claim. Give each a distinct probe path. Merge in multiple orders. Require zero routine edits outside each assigned path and any new obligation file, equal discovered IDs and scores, and the original Arcade baseline. Require a disputed result for intentionally contradictory receipts and a visible failure for breaking a shared profile. Exercise the lock separately with two jobs targeting the same named database before allowing concurrent credentialed scheduling.
4. **Open additional game worktrees after the pilot passes.** Give the shared runtime or schema its own owner when multiple agents need a new capability. Genuine simultaneous changes to one contract, one adapter implementation or one database release remain coordination points. The design removes routine registration and evidence conflicts while keeping those decisions visible.
