# Priorities

As of 2026-07-10. pyric shipped its npm alpha and the feature set works — that is the problem. The first real user, a Firebase expert, loved the prototype tab, opened the docs, and backed off: overwhelmed by how much was there. They wanted a Vite plugin and didn't know one already existed; they later asked for a verify-before-production capability that also already existed. The system is objectively strong and subjectively too much. This season is not about building more. It is about making what exists easy to enter, simple to hold in your head, and safe to trust — and nothing else. When a proposal doesn't serve one of the three, it waits.

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
- Unblock real Firestore apps under the worker: or()/and() + persistence family (#144)

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
