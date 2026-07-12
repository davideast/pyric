---
title: "Lint vs validate vs simulate vs test"
navLabel: "Lint vs validate vs test"
group: "pyric / rules"
section: "Explanation"
order: 13021
---
# Lint vs validate vs simulate vs test

The package offers four distinct ways to look at a rules source. Their names suggest they overlap. They don't, and the distinction matters when you're building a CI pipeline or an agent loop.

## Lint: structural risks

`lint(source)` (or `firestoreRules(source).lint()`), both public, answer: *"will this ruleset compile? and if it does, will it survive at runtime?"* Both are built on the engine-internal linter, `lintFirestoreRules` (`pyric/rules/internal`); the public functions fold its output into `RuleIssue`s with `origin: 'lint'`.

The linter walks the AST counting things (chain depths, let bindings, function-call depths, `get()` counts, expression tree sizes) and compares those numbers to thresholds it learned from production. Some thresholds are exact: 256 KB source size, 98 chain depth, 11 lets per function. Others are bands derived from observing the runtime budget's behaviour in the flaky zone (40 / 60 / 100 nodes depending on call count).

The linter also catches a small but high-value set of *known agent failure modes*: `PERMISSIVE_RULE`, `RECURSIVE_WILDCARD_OPEN`, `RULES_WEAKENED`, `HALLUCINATED_METHOD`, `INVALID_OPERATOR`. These were not in the original linter spec. They were added after watching agents repeatedly ship the same broken patterns. See [Agent failure modes](../pyric-rules-explanation-agent-failure-modes/) for the stories behind them.

What linting does **not** tell you: whether your rules behave the way you intend. A rule that compiles, fits the budget, and avoids every agent footgun can still permit something it shouldn't. That question is for the simulator and the test API.

## Validate: security and quality findings

The engine-internal `validateFirestoreRules(ast)` (`pyric/rules/internal`) answers: *"would a careful human reviewer flag anything here?"* On the public surface its findings arrive folded into the same `RuleIssue` list as the linter's, tagged `origin: 'validate'`. Both `lint(source)` and `firestoreRules(source).lint()` run the validator internally, so most callers never call it directly.

The validator runs structural checks: public writes, unauthenticated writes, missing default-deny, write-without-data-validation, duplicate function names, overlapping match paths. Its findings carry a four-level severity (`critical` / `high` / `medium` / `low`) and a code (`SEC-1`, `SEM-2`, `QUA-3`, `STR-1`).

The validator's coverage overlaps the linter's at the edges. `QUA-1` (hardcoded `true`) is reported by both, for instance. The two surfaces exist because:

- The linter focuses on *operational* concerns: will this deploy? will it run within budget? does it look like JavaScript when it shouldn't?
- The validator focuses on *review* concerns: is this safe? is this clean? is this consistent?

In practice, run both. Their findings union without redundancy in most cases.

## Simulate: does the rule decide correctly, locally?

`firestoreRules(source).simulate(cases)` answers: *"given these requests, what does the rule decide?"*

The simulator parses the rules, builds a `SimulationContext` from each case, walks every expression with a hand-written evaluator, and produces an `ALLOW` / `DENY` decision (or reports the case as unsupported if it doesn't yet model some feature). You compare the decision to your expectation and learn whether your rule does the right thing for the inputs you care about.

The simulator is sub-millisecond per case once parsed. It is the right surface for:

- Agent loops that iterate on a rule and need fast feedback.
- CI checks that exercise hundreds of test cases on every PR.
- Local development without a Firebase project.

It is **not** the right surface when:

- A case comes back unsupported and you need a verdict the simulator can't give you.
- You're shipping rules that must behave exactly like production. The simulator is close to bit-for-bit parity, but not bit-for-bit.

## Test: does the live Firestore engine agree?

The engine-internal `TestFirestoreRulesHandler.execute(scope, source, testCases)` (`pyric/rules/internal`) answers: *"would production decide the same way?"* There's no public front-door equivalent yet.

This calls Google's Firebase Rules Test API. The request goes to Google's servers, the rules are evaluated in the production engine, and you get pass/fail per case. The test API never deploys anything (it's a pure evaluation surface), but it costs HTTP latency and requires a service-account credential.

Use it when:

- You're about to deploy and want certainty.
- The simulator returned `UNSUPPORTED` and you need a verdict.
- You're investigating a discrepancy between local and production behaviour.

## Which surface for which question

| Question | Surface |
|---|---|
| Will this compile? | Lint (`SOURCE_SIZE`, `CHAIN_DEPTH`, `LET_LIMIT`) |
| Will this survive the runtime budget? | Lint (`EXPRESSION_BUDGET`, `CALL_DEPTH`, `GET_COUNT`, `SHARED_GATE`) |
| Did the agent open the database again? | Lint (`PERMISSIVE_RULE`, `RECURSIVE_WILDCARD_OPEN`) |
| Did anyone silently weaken security? | Lint with `previousSource` (`RULES_WEAKENED`) |
| Would a reviewer flag this? | Validate (`SEC` / `SEM` / `QUA` / `STR`) |
| Does the rule decide what I think it does? | Simulate |
| Does the production engine agree? | Test |

A complete pipeline tends to look like: validate + lint (block on errors), simulate (verify intended behaviour locally), test (parity check before deploy, or when simulator abstains).
