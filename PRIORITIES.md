# Priorities

As of 2026-10-14. Multi-tenancy and Impersonation is done: tenant claims reach every rules engine, and the runtime chip switches between the app session, Admin bypass, and impersonated users with tenants and claims. Simplification is done. What remains is shipping what is built. The Node host is the backend every client shares, and it is still behind the `next` tag. Real Firebase projects have more than one database, instance, or bucket, and only RTDB instances are modeled end to end. Those two come first, in that order. Trust runs alongside both. When a proposal serves none of the tests below, it waits.

## Ship the Node host

**Test:** Does this move `pyric sandbox --hosted` closer to shipping under the npm `latest` tag, or keep it shippable once it is there?

The Node host is the one authoritative sandbox that browsers, Studio, `firebase-admin` child processes, the service CLI, `pyric mcp`, and native clients share. It ships when the bar in `docs/hosted-release-plan.md` is met: acceptance evidence that runs in CI, no open blocker in `docs/hosted-review-ledger.md`, a quiet period on `next`, then `latest`.

**Counts:** issues in the Node host milestone; open ledger items; the phase 4 acceptance run and its committed artifact; hosted suites as required CI jobs; first-run polish on the hosted path; bugs that app scenarios (`test/apps/`) find on the host.
**Doesn't count:** new hosted features before promotion (undo history and live mode stay parked, as ruled in D1 and D3); SharedWorker-only work; performance work without a failing acceptance ceiling behind it.

**Now:**
- Reconcile the ledger: record which 3b and 3c items later work already closed, and list what is actually left
- Run the phase 4 acceptance (multi-client, zero refusals under stable load) and commit the artifact (ledger I6, F1 to F4)
- Host robustness found by real apps: close peers that go quiet so their `onDisconnect` runs (#965); hold operations issued during a reconnect (#968, amends ADR-0019)
- Decide ledger H2: suppress or explain the `node:sqlite` experimental warning on first run
- Revisit D2: the Node host page is back in Get started, so acceptance passes or the page comes out until it does
- The Firestore named-database protocol change below lands before promotion, so the versioned worker protocol (ADR-0011) changes once
- Quiet period on `next`, then promote to `latest`

## Ship multi-resource support across services

**Test:** Does this let a project with more than one database, instance, or bucket run on pyric with each resource isolated as production isolates it, in data, rules, and SDK selection, on every plane?

RTDB instances are closest to the full shape: `firebase.json` declares them, each gets its own data and rules, client and admin handles select by URL, denials name the instance, and the in-page sandbox, the SharedWorker host, and the Node host agree. The service tools and `pyric verify` still assume the default instance. Each remaining resource reaches that shape, or names its gap in the conformance registry.

**Counts:** Firestore named databases end to end (`getFirestore(app, databaseId)` on the client and in `pyric-admin`, the rules `database` variable, the worker protocol, the host store); Storage rules per bucket from `firebase.json` targets; naming the resource in denials, Studio, and the runtime chip; differential tests across planes for each resource; flipping the `Named databases` rows in `packages/conformance/registry/firestore.ts`.
**Doesn't count:** more than one Firebase project or configuration in one runtime (rejected by design); provisioning resources; resource kinds no reported app uses.

**Now:**
- RTDB instances in `pyric database <method>`, the MCP `database` tool, and `pyric verify` (#967)
- Firestore named databases: carry a database id in the worker protocol, as a versioned change, before the Node host reaches `latest`
- Firestore named databases: per-database data and rules from the `firestore` array in `firebase.json`, on all three planes and in `pyric-admin`
- Storage: per-bucket rules from `storage` targets, replacing the one implicit bucket in `packages/cli/src/serve/rules.ts`
- Extend the RTDB differential runner to named databases and buckets

## Trust

**Test:** Does this help a user judge whether they can rely on pyric: its contract, its gaps, or its path to production?

Two halves. Conformance states the contract and the gaps openly, proven and open-sourced for scrutiny. Assurance is how a user goes from pyric to production with confidence (`pyric verify` and the assurance system). Trust is ongoing: each host behavior and each new resource lands with the evidence that states it.

**Counts:** conformance chain, gap documentation, open evidence; assurance and verify features and their discoverability; anything that lets a user see what pyric guarantees and where it stops.
**Doesn't count:** new mirror features (they expand the contract, they do not help a user judge it); chasing exotic-feature fidelity no reported app has hit (documenting the gap beats closing it silently).

**Now:**
- Make `pyric verify` discoverable (#133)
- Registry rows for every Node host and multi-resource behavior that ships under the two priorities above

## Top of Funnel

**Test:** Does this reduce what a new user must learn or do before their first success with pyric?

The on-ramp: the CLI working reliably across platforms, the agent plugins, the Vite-plugin path, and the README and docs that carry someone from "curious" to "it works" without a stumble. Measured in time to first win, not feature count.

**Counts:** CLI reliability and cross-platform fixes; the getting-started path; agent and plugin onboarding; README and getting-started messaging; removing install friction.
**Doesn't count:** anything that adds a step or a decision to the first run.

**Now:**
- Vite-plugin hero path, documented as a first-class entry (#124)
- `pyric sandbox` opens Studio by default; context-aware landing (#125)
- CLI cross-platform reliability, Windows cold start first (#126)
- npx cold-start diet (#127)
- Agent-first path (plugin to bridge) covered end to end (#128)
- No-SharedWorker and older-Safari fallback and signpost (#129)
- App Check before AI Logic requires it in November: `initializeAppCheck` and `getToken` work in sandbox mode, and production AI mode passes the real `firebase/app-check` through so AI Logic requests carry a token. Built under CDD (`docs/conformance/cdd.md`) as a new `app-check` surface. Today `pyric/app-check` throws on first use, so an AI Logic app that calls it fails its first run.
- Cloud Functions beyond the one RTDB trigger, HTTP `onRequest` first: an app whose functions use HTTP, callable, Firestore, Storage, or more RTDB events can't run them under pyric today. Built under CDD per event family, reusing the `functions-rtdb` runtime.

## Build Velocity and Tech Debt

**Test:** Does this measurably shorten the time from a change to trustworthy feedback, or remove demonstrated maintenance friction, without weakening validation or growing the user-facing surface?

Sustaining work. Optimize measured bottlenecks in the loops developers run most, and pay down debt that repeatedly slows or destabilizes the priorities above. Record the symptom and the verification plan before starting.

**Counts:** reducing build, test, and CI latency with timing evidence; cache effectiveness; refactors tied to observed friction; consolidating duplicated sources of truth; removing dead code; characterization tests that make a risky cleanup safe.
**Doesn't count:** weakening or skipping required validation; speculative optimization or abstraction; aesthetic rewrites; dependency churn without a concrete benefit; broad redesigns without a bounded migration plan.

**Now:**
- Assess `packages/pyric` test latency. Its suite (11,709 tests, 650 files) took 243 s of the library job's 289 s on CI (main c630edd0, 2026-10-18) and 492 s locally on WSL2. Sharding it across two runners (#1096) is the stopgap. Next, profile per-file time, name the files and fixtures that dominate, and propose cuts with timing evidence, without dropping coverage.
