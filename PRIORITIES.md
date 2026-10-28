# Priorities

As of 2026-10-28. The Node host has shipped: main and npm `latest` (alpha.26) include it. Firebase AI Logic requires App Check on November 2, so App Check comes first. CI and release velocity comes second, because the last two releases each took hours and every other priority pays for that time. Rules fidelity, multi-resource support, and reliability follow. When a proposal serves none of the tests below, it waits.

## Direction

Pyric is the dev tools for vibe coding. Someone with an idea for an app builds it with an agent, deploys it to production, and has the tools to see where it has critical problems and fix them with the agent. Today that means web apps. Later it means Android, iOS, and Flutter.

This is not a priority and has no test yet. It is the lens for reading the priorities below.

## App Check

**Test:** Before November 2, 2026, does this get App Check working in pyric, end to end, and shipped in a release? After it, does this watch and verify that pyric still behaves like production once AI Logic enforces App Check?

On November 2, 2026, Firebase AI Logic requires App Check. An app that uses AI Logic through pyric must work the way it will in production after that date. App Check stays first after November 2, because we need to watch and verify that pyric still behaves like production once enforcement starts. The alpha.30 release shipped App Check to the npm `exp` tag. npm `latest` is still alpha.26, so an app installed from `latest` still gets a `pyric/app-check` that throws on first use.

**Counts:** `initializeAppCheck` and `getToken` working in sandbox mode; production AI mode passing the real `firebase/app-check` through so AI Logic requests carry a token; App Check tokens in the in-page sandbox, the worker bridge, and the Node host; a new `app-check` surface built under CDD (`docs/conformance/cdd.md`); the release that ships it; alpha.30 reaching `latest`; re-capturing the AI Logic App Check gate after November 2 (#1300).
**Doesn't count:** App Check for other services beyond what AI Logic needs.

**Now:**
- Sandbox AI mode answers requests without an App Check token, and production refuses them (#1291)
- Production AI mode fails on the import-map plane (#1290)
- Unclear App Check errors in production AI mode (#1293)
- `pyric-admin` `cert()` drops the service account `project_id` (#1294)
- `pyric-admin` `verifyToken` rejects real App Check tokens in production AI mode (#1301)
- Compare the raw auto-refresh option and share an in-flight `getToken` (#1388)
- Send an App Check token from the AI Logic rig and re-capture its observations (#1412), and handle AI Logic rejecting role `function` (#1410)
- The alpha.30 stability test, before it moves to `latest`
- David's report from a real app using alpha.30
- After November 2: re-capture the AI Logic App Check gate (#1300)

## CI and release velocity

**Test:** Does this shorten the time from PR to green CI, or from merged commit to published release, without skipping or weakening a gate?

There is no target time. Every change is measured against the current baseline, and any increase is a defect, fixed or filed like red on main. Speed comes from the build system and from keeping a release's critical path clear, never from skip flags. The bytes uploaded stay the bytes that passed the gates.

**Counts:** one build reused by every gate; content-hashed, incremental builds; fixing flakes off the release's critical path; keeping slow and timer-bound checks off the PR path; a release script that is fast by default, with no rehearsal; nothing on a release's critical path except the release itself; timing evidence for each change.
**Doesn't count:** skip flags or any change that weakens a gate; flake fixes on a release's critical path; widening an in-flight PR's scope while a release waits on it; speculative optimization without a measured bottleneck.

**Now:**
- Baseline (2026-10-27): PR CI 6 to 9 minutes; CI on main 6 to 10 minutes; publish gates about 15 minutes; the alpha.29 release took about two hours from asking to published
- Phase 2 of the build work: one build reused by every gate
- Open flakes: #1268, #1272, #1277
- Runner gaps: #1271, #1286

## Rules fidelity and tooling

**Test:** Does this make pyric's rules verdicts match production, or make rules easier to write, validate, prove correct, or understand?

Nothing pyric allows may be denied by production, and nothing may fail open. Beyond fidelity, pyric should be the best place to write rules, validate them, and prove them correct. A feature that looks like scope creep is judged by this test.

A change that moves pyric closer to production is a pyric bug fix, not a breaking change. It ships in a minor or patch release with a "Behavior changes" section in the notes. A change to the API (names, arguments, return shapes, the DSL) is a breaking change, and the notes label it as one.

**Counts:** fixing rules divergences on Firestore, Storage, and RTDB; denials and load errors that give production's reason (for example, "production reads `/cat|dog/` as `.*cat|dog.*`, so `'dogs'` doesn't match"); lint that flags constructs production reads differently than users expect; tooling that helps a user understand how to use pyric with rules.
**Doesn't count:** a flag that restores old behavior (it would let pyric allow what production denies); rules features that fail the test.

**Now:**
- The Firestore and Storage fix campaign: 71 findings from the latest hunts
- Regex DoS in Firestore and Storage rules (#1264)
- Simulate accepts invalid data (#1262)

## Multi-resource support

**Test:** Does this let a project with more than one database, instance, or bucket run on pyric with each resource isolated as production isolates it, in data, rules, and SDK selection, on every plane?

RTDB instances are closest to the full shape: `firebase.json` declares them, each gets its own data and rules, client and admin handles select by URL, every plane agrees, and `pyric database`, the MCP `database` tool, and `pyric verify` each take an instance. Firestore named databases are not supported yet, and Storage applies one bucket's rules to every bucket.

**Counts:** Firestore named databases end to end (`getFirestore(app, databaseId)` on the client and in `pyric-admin`, the rules `database` variable, the worker protocol, the host store); Storage rules per bucket from `firebase.json` targets; naming the resource in denials, Studio, and the runtime chip; differential tests across planes for each resource; flipping the `Named databases` rows in `packages/conformance/registry/firestore.ts`.
**Doesn't count:** more than one Firebase project or configuration in one runtime (rejected by design); provisioning resources.

**Now:**
- Storage: per-bucket rules from `storage` targets. Today the first bucket's rules govern all of them (ST-H2-2, shared with the rules campaign)
- Firestore named databases: carry a database id in the worker protocol as one versioned change (ADR-0011)
- Firestore named databases: per-database data and rules from the `firestore` array in `firebase.json`, on all three planes and in `pyric-admin`

## Reliability and trust

**Test:** Does this find or fix a place where pyric differs from production, or keep a conformance claim checked against production?

Pyric's claim that it behaves like production has to stay true and keep being checked. Defect hunts are time well spent: each one has found real bugs. A `conforms` claim captured once on one machine can silently outlive the behavior behind it.

**Counts:** defect hunts and their fix campaigns on every service; production oracles that run unattended in CI and don't depend on one machine or one login; pyric's own attack surface (the dev server, the worker bridge, the MCP tool, and the Node host, as code that handles untrusted input); testing against new `firebase` and `firebase-admin` releases before users install them.
**Doesn't count:** fidelity work on features no app or hunt has reached.

**Now:**
- Credentialed oracle legs in CI. The weekly re-capture skips them and reports green. Set up Workload Identity Federation for the oracle project, then the `GCP_WIF_PROVIDER` and `PARITY_SA_EMAIL` repo variables
- Bring the RTDB rules capture into the weekly run, against its dedicated instance
- Find out why the weekly runs from September 28 to October 19 failed
- The SDK behavior hunt for Firestore and RTDB
- `__proto__` keys in the sandbox (#1251); the server clock can step back (#1255); `run.ts` doesn't restore the RTDB rules it merges (#1270)

## Prove the Node host

**Test:** Does this show, through a real entry point, that the Node host behaves correctly in a situation a real server meets?

The Node host has shipped. What it needs now is evidence that it holds up the way a server does in real use, run through the entry points users run.

**Counts:** app scenarios under `test/apps/` that drive `node --import @pyric/cli/register` against packed packages; restart, reconnect, socket close, and long-running processes; parity between the Node host and the browser and worker planes; fixing what those scenarios find; closing open items in `docs/hosted-review-ledger.md`.
**Doesn't count:** new Node host features no scenario exercises.

**Now:**
- Reconcile the ledger: record which items later work closed, and list what is actually left
- Choose the first scenarios

## Cloud Functions

**Test:** Does this let an app's Cloud Functions run in pyric and behave as they do in production?

Cloud Functions are widely used, and capped billing on function quotas now makes them accessible to small projects. With the Node host shipped, pyric has a place to run them.

**Counts:** `onRequest` and callable functions on the Node host; triggers from Firestore, RTDB, Storage, and Auth; functions reading and writing through pyric with admin privileges, as in production.
**Doesn't count:** deploying functions; emulating Google Cloud services outside Firebase.

**Now:**
- HTTP `onRequest` served by `pyric sandbox`. Today an app that exports `onRequest` has it skipped on its first run. Built under CDD as a new `functions-http` surface, reusing the Functions child runtime (`packages/cli/src/functions/`, #1185)
- Callable, Firestore, Storage, and more RTDB triggers follow

## Work that enables demos

**Test:** Does this unblock or improve a demo we're about to publish?

Demos are the only outward-facing focus. A demo is something distributable, a video or a post, and it lives outside this repo. Repo work is prioritized when a demo needs it. Demos are also how people find pyric and how real-app signal arrives.

**Counts:** fixes and polish a planned demo depends on; turning a published demo's app into a scenario under `test/apps/` so it keeps working.
**Doesn't count:** repo work no planned demo needs.

## Live mode

**Test:** Does this move live mode toward a safe, evidence-backed design, or deliver a stage of that design?

In live mode, pyric's tools connect to a real Firebase project and its data flows through pyric, so Studio, denials, rules explain, and the other observability tools work on production data. A real app using pyric has asked for it. It also makes every live session a source of conformance signal: pyric can predict each answer and compare it with production's, flagging divergences for a deliberate capture on the oracle project to confirm. An earlier attempt is parked on `live/parked` under ruling D3 in `docs/hosted-release-plan.md`. It forwarded one Firestore function and threw on the rest.

**Counts:** research and probes that settle the design; safety guarantees against accidental production writes; comparisons that keep user data on the user's machine and record request shapes, not values; stages that forward the full surface or document each refusal with a scenario.
**Doesn't count:** forwarding part of a surface without documenting the rest; anything that sends user data off the machine without the user's explicit action; production calls added only to make a comparison possible.

**Now:**
- Deep research across seven tracks: the parked attempt, where data passes through pyric, what each tool can do live, what production lets a client observe, safety, prior art, and live mode as a conformance source
