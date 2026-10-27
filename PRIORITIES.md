# Priorities

As of 2026-10-27. Five priorities, in order. App Check comes first, because on November 2, 2026, AI Logic starts requiring an App Check token, and an app that can't produce one can't use AI Logic under pyric. Rules fidelity comes next, because pyric rests on rules: if its rules are reliable, easy to write and provably correct, the whole library is better. Everything else waits unless it passes one of the tests below.

## 1. App Check for AI Logic

**Test:** Does this let an app that uses AI Logic with App Check run under pyric, in sandbox and production AI mode, before November 2, 2026?

From November 2, AI Logic refuses requests without an App Check token. Today `pyric/app-check` throws on first use, so an AI Logic app that calls `initializeAppCheck` fails its first run. Built under CDD (`docs/conformance/cdd.md`) as a new `app-check` surface.

**Counts:**
- `initializeAppCheck` and `getToken` working in sandbox mode;
- the real `firebase/app-check` passed through in production AI mode, so AI Logic requests carry a token;
- the admin `appCheck()` surface;
- the conformance rows and captures behind each;
- a working AI Logic plus App Check example.

**Doesn't count:** App Check enforcement for other products before AI Logic works; App Check providers no reported app uses.

**Now:**
- Bring #1205 (App Check under CDD, reviewed, last updated Oct 22) up to date with main, recheck it, and merge it.
- Decide #1205's two open questions:
  - should sandbox AI mode refuse requests without a token?
  - support pass-through on the plain import-map plane, or document it as Vite and register only?
- Unblock #1199: the ai-logic capture rig needs an App Check token on the oracle project.
- Release on `exp` as soon as it merges, then confirm against a real AI Logic project with App Check enforced.

## 2. Rules: faithful, and easy to get right

**Test:** Does this make pyric's rules verdicts match production, or make it easier to write, validate or prove a ruleset correct?

Pyric's value rests on rules. Nothing pyric allows may be denied by production, and nothing may fail open. Beyond fidelity, the goal is going from an idea to a secure ruleset: an app vibe-coded with pyric should ship with rules that are actually secure. A feature that looks like scope creep is judged by this lens. Does it make rules easier to write, validate or prove correct, or easier to understand how to use pyric with rules? If so, it counts. Convenience alone doesn't.

**Counts:**
- defect hunts against production and the fix campaigns that follow;
- fail-open fixes first;
- deploy-time parity (pyric refuses what production refuses, and accepts what it accepts);
- lint that catches real security mistakes;
- `simulate`, `pyric verify` and replay that tell the truth;
- the rules DSL and generators;
- rules docs and recipes that lint clean;
- tools that take an app from idea to a secure, proven ruleset.

**Doesn't count:** convenience features that don't make rules more correct or easier to prove; rules features no production engine has.

**Now:**
- Firestore and Storage fix campaign: 71 findings confirmed on Oct 27, 10 of them fail-open. It starts with an evidence stream that pins the captures. Fail-open fixes come first:
  - Firestore root-path literals are never checked against the request (FS2-ENF-1);
  - wrong-service rulesets get loaded as Firestore rules (FS2-ENF-2, ENF-3a);
  - Storage's CLI loads the wrong rules file (ST-H2-1a);
  - with several buckets, the first bucket's rules govern all of them (ST-H2-2).
- Then the RE2 dialect, string methods, integers and time, compile-time checks, and `pyric verify`.
- Move Storage onto the shared rules implementations.
- Rules follow-ups:
  - #1251: the sandbox refuses `__proto__` keys that production stores;
  - #1262: `simulate` accepts written data the SDK refuses;
  - #1264: nested repeats in `matches()` exhaust memory;
  - #1259: the verify hint is used up by reloads the user didn't make.
- Rules recipes in the docs that lint clean, and a path from an app idea to a ruleset that `pyric verify` proves.

## 3. Reliability and trust

**Test:** Does this make pyric behave like production on every plane, or let a user see exactly where it doesn't?

Conformance states the contract and its gaps openly, and hunts against production find where it breaks. Trust is ongoing: each fix lands with the evidence that proves it.

**Counts:**
- SDK behavior hunts (listeners, transactions, queries, writes, errors) against the live oracle;
- cross-plane parity (in-page, SharedWorker, Node host);
- conformance rows and captures;
- flaky tests and harness bugs that hide real failures;
- making `pyric verify` discoverable (#133).

**Doesn't count:** new mirror features (they grow the contract, they don't help a user judge it); exotic fidelity no app has hit (document the gap instead).

**Now:**
- SDK behavior hunt, Firestore first, then RTDB. Plan: `scratchpad/sdk-hunt/plan.md`.
- A cross-plane differential runner for Firestore and Storage (only RTDB has one).
- Oracle tooling:
  - #1270: `run.ts` never restores the RTDB rules it merges;
  - #1271: runner gaps.
- Flakes: #1268, #1272, #1277, #1279 and #1286.

## 4. Cloud Functions

**Test:** Does this let an app's Cloud Functions run under pyric as they do in production?

Cloud Functions are among the most used Firebase products, and capped billing on function quotas now makes them accessible to far more developers. That fits pyric's focus on the accessible tools. HTTP `onRequest` first, then callable, then more triggers. Built under CDD as a `functions-http` surface, reusing the Functions child runtime (`packages/cli/src/functions/`).

**Counts:** `onRequest` served by `pyric sandbox` and the Vite plugin; hosting rewrites to functions; callable functions with auth and App Check context; more Firestore, Storage and RTDB triggers; the conformance rows behind each.

**Doesn't count:** deploying functions; runtimes other than Node.

**Now:**
- The `onRequest` stack (#1185, #1190, #1191, #1202, #1204), reviewed and parked behind the Node host promotion. Decide whether it waits for that promotion, or ships on `exp` now.
- The production capture (PR 3 of the stack). It was blocked on IAM roles in genkit-idx; check whether the digame-mas service account can run it instead.
- Callable functions next.

## 5. Demos

**Test:** Does this show a developer, in minutes, something real that pyric does and nothing else does?

The one outward-facing priority right now: showcasing pyric. A demo is a small, real app, built on the public packages and kept working by an app scenario.

**Counts:** demo apps and their scripts; the things pyric uniquely does (an app idea to a ruleset that's proven secure; AI Logic with App Check; the sandbox across page, server and agent); a demo that breaks is a bug.

**Doesn't count:** marketing copy without a working app behind it; demos of features that aren't released.

**Now:**
- Choose the first two demos. Suggested:
  - from an app idea to a secure, verified ruleset;
  - an AI Logic app running with App Check under pyric.
- Give each an app scenario under `test/apps/` so it can't silently break.

## Parked

These still matter, but they wait unless the work passes a test above.

- **Top of Funnel** (the on-ramp: #124 to #129). First-run breaks are still fixed when a demo or a real app hits them.
- **Ship the Node host to `latest`**: the bar in `docs/hosted-release-plan.md`. It also gates the `onRequest` stack unless priority 4 decides otherwise.
- **Multi-resource support** (Firestore named databases, per-bucket Storage rules). The per-bucket rules gap is also a rules-fidelity finding (ST-H2-2), so that part is under priority 2.
- **Build velocity**, Phase 2 (one build per commit, project references, the release record). It's taken only when CI time or flakes block the priorities above.
- **Native clients**, parked in #1048.
