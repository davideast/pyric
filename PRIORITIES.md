# Priorities

As of 2026-07-14. pyric shipped its npm alpha and the feature set works — that is the problem. The first real user, a Firebase expert, loved the prototype tab, opened the docs, and backed off: overwhelmed by how much was there. They wanted a Vite plugin and didn't know one already existed; they later asked for a verify-before-production capability that also already existed. The system is objectively strong and subjectively too much. This season is not about building more. It is about making what exists easy to enter, simple to hold in your head, and safe to trust — and nothing else. When a proposal doesn't serve one of the three, it waits.

## Multi-tenancy and Impersonation
- Supporting utilities and features that make it easier for pyric to support multi-tenancy and for users to have features to enable impersonation.

## Top of Funnel

**Test:** Does this reduce what a new user must learn or do before their first success with pyric?

The on-ramp: the CLI working reliably across platforms, the agent plugins, the Vite-plugin path, and the README/docs messaging that carries someone from "curious" to "it works" without a stumble. Measured in time-to-first-win, not feature count.

**Counts:** CLI reliability and cross-platform fixes; the getting-started path; agent/plugin onboarding; README and getting-started messaging; removing install friction (npx weight, doc bugs).
**Doesn't count:** conceptual restructuring of the whole system (that is Simplification); anything that adds a step or a decision to the first run.

**Now:**
- Vite-plugin hero path, documented as a first-class entry (#124)
- `pyric dev` opens Studio by default; context-aware landing (#125)
- CLI cross-platform reliability, Windows cold-start first (#126)
- npx cold-start diet (lazy-load the agent ML stack; ~924MB today) (#127)
- Agent-first path (plugin → bridge) covered end to end (#128)
- No-SharedWorker / older-Safari fallback and signpost (#129)

## Simplification

**Test:** Does this reduce the number of concepts pyric exposes at once, or defer a concept until the user needs it?

The foundational one. Take the feature inventory and find the smallest taxonomy that explains it: teach the top level first, reveal sub-concepts only when the user's own question demands them. Progressive disclosure over a feature list. The goal is that a newcomer feels pyric is small, and discovers its depth only as they reach for it.

**Counts:** taxonomy and concept-hierarchy work; progressive-disclosure docs restructuring; collapsing, hiding, or unifying concepts; naming that reduces surface.
**Doesn't count:** adding a new "simple" wrapper or convenience layer over the complex parts — that ADDS a concept and fails the test however friendly it looks; polishing the first-run path (that is Top of Funnel).

**Now:**
- The taxonomy pass: minimal concept hierarchy, taught-first vs disclosed-on-demand (#130)
- Docs restructured around that hierarchy (#131, depends on #130)

## Trust

**Test:** Does this help a user judge whether they can rely on pyric — its contract, its gaps, or its path to production?

Two halves. Conformance states the contract and the gaps openly, proven and open-sourced for scrutiny. Assurance is how a user goes from pyric to production with confidence (`pyric verify`, and eventually the assurance system). A user who cannot find or understand these cannot trust the system.

**Counts:** conformance chain, gap documentation, open evidence; assurance / verify features and their discoverability; anything that lets a user see what pyric guarantees and where it stops.
**Doesn't count:** new mirror features (they expand the contract, they do not help a user judge it); chasing exotic-feature fidelity nobody has hit (honest documentation of the gap beats silently closing it).

**Now:**
- Close conformance Phase 2: commit observations, pin the 7 divergences as public documented gaps (#132)
- Make `pyric verify` discoverable (#133)
- Document the conformance contract and gaps where a user will actually find them (#134)
- Make conformance support queryable from one canonical evidence graph while collapsing committed generated projections (#218)

## Build Velocity

**Test:** Does this materially shorten the time from a developer making a change to receiving trustworthy feedback that it is ready?

The feedback loop: local builds, tests, and CI should surface useful results quickly enough that waiting does not interrupt development. Optimize measured bottlenecks in the paths developers run most often, while preserving the checks that make releases safe.

**Counts:** reducing build and test latency; eliminating redundant CI work; improving cache effectiveness; running independent checks concurrently; making fast, targeted checks available locally; measuring and preventing regressions in feedback time.
**Doesn't count:** weakening or skipping required validation; speculative optimization without timing evidence; speeding up rarely used paths while common workflows remain slow; adding infrastructure whose maintenance cost outweighs the measured gain.

**Now:**
- Measure recent GitHub Actions runs and identify the critical path
- Shorten pull-request feedback time by removing redundant work and improving parallelism and caching
- Keep release confidence intact while making the common local and CI loops faster

## Refactoring and Tech Debt

**Test:** Does this remove demonstrated maintenance friction or reduce the risk and scope of future changes without expanding the user-facing concept surface?

The internal sustainability work: simplify brittle implementations, consolidate duplicated sources of truth, replace risky seams with clear interfaces, and retire obsolete code that makes current priorities harder to deliver safely. Prefer evidence from recurring bugs, repeated edits, confusing ownership, or disproportionate verification cost; cleanup should leave the system easier to change and at least as trustworthy as before.

**Counts:** refactors tied to observed maintenance friction; consolidating duplicated logic or configuration; removing dead or superseded code; reducing coupling and change blast radius; paying down debt that repeatedly slows or destabilizes priority work; adding characterization tests needed to make a risky cleanup safe.
**Doesn't count:** aesthetic rewrites; speculative abstractions for hypothetical growth; broad redesigns without a bounded migration and verification plan; dependency churn without a concrete maintenance or reliability benefit; cleanup that weakens behavior coverage or changes the public contract unintentionally.

**Now:**
- Refactor the service-command dispatcher into a typed route registry while preserving command behavior and command-local handler arguments. Symptom: every route repeats a conditional and positional slice, making copy/paste routing mistakes easy. Verification: characterize all 11 routes, unknown and non-service dispatch, retired spellings, and duplicate rejection; then pass the CLI suite, typecheck, build, and packed-CLI runtime smoke.
- Record the concrete maintenance symptom and verification plan for each tech-debt item before implementation
