---
title: Firestore rules limits, measured
navLabel: Rules limits
outcome: Know the measured limits of the production rules compiler and evaluator, with exact numbers, so your rules compile the first time.
status: draft
---

# Firestore rules limits, measured

A ruleset can be syntactically perfect and still fail two ways: a 400 at deploy with no useful message, or a silent 403 at runtime that looks exactly like a denial you wrote. Both come from real limits in the production compiler and evaluator. The numbers below are researched and observed behavior: Pyric's tooling probed production Firestore directly, isolating one variable at a time, and recorded what it measured. They ship inside Pyric's linter as thresholds, so you do not have to remember them. It helps to know they exist.

## 256 KB of source

For a long time the working assumption was a "30 to 37 KB practical limit" on rules source. It was wrong. That number was chain depth in disguise: complex rulesets happened to hit the depth limit at around that size, and size took the blame. Isolate the variable with a large file of trivial single-comparison rules and 250 KB compiles while 256 KB fails. The real source ceiling is 256 KB, and 58 KB of simple functions compiles without complaint.

## 98 terms in a chain

A flat chain of `a && b && c && ...` compiles at 98 terms and fails at 99. Same for `||`. The limit is the depth of the top-level binary chain, not the number of comparisons: 90 OR branches of `(a && b)` pairs is 180 leaf expressions and compiles fine, because nesting halves the chain. When the linter reports CHAIN_DEPTH, the fix is grouping. `a && b && c && d` becomes `(a && b) && (c && d)`.

## 11 let bindings per function

Eleven `let` bindings in a function compile. Twelve fail, with the same unexplained 400 as every other compilation failure. The fix is inlining expressions into the return statement, or splitting the function.

## 10 get() calls per evaluation

This limit is in Firebase's own documentation. What matters in practice is the caching: results are cached per unique path, so a shared `config()` helper called from six functions costs one read, while six different paths cost six. The linter warns past 5 distinct calls and errors at the documented 10.

## The runtime budget, and its flaky zone

The compile-time limits fail loudly at deploy. This one does not. A rule whose evaluation is too expensive returns 403 PERMISSION_DENIED at runtime, indistinguishable from a denial you intended.

Pinning it down took a deploy-once, test-five-times methodology, and the result is not a single number:

| Shape | Total expressions | Result |
|---|---|---|
| 1 function of 98 expressions | 98 | 5/5 pass |
| 2 functions of 60 | 120 | 5/5 pass |
| 2 functions of 65 | 130 | 2/5 pass |
| 3 functions of 20 | 60 | 2/5 pass |
| 3 functions of 50 | 150 | 0/5 pass |

Read the second row against the fourth. Two function calls with 120 total expressions always pass. Three calls with half that total are already failing intermittently. Function calls carry heavy overhead, so the budget is call-count-dependent. And between "always passes" and "never passes" sits a genuine flaky zone, where the same rule passes most of the time and intermittently denies under load. The linter models this with conservative tiers: at one or two function calls it warns at 100 total expressions, at three or four it warns at 60, at five or more it warns at 40.

## About 40,000 index entries in a config document

The config-document pattern has a ceiling on the data side. A 129 KB config document with 19 thousand index entries writes fine. A 207 KB one with 39 thousand fails with "too many index entries for entity". If your lookup document is large, budget its keys, not only its bytes.

## The budget that spans rules

The runtime expression budget is shared across all the allow rules of a match block, evaluated in order. Non-matching rules spend from the same account as the rule that will eventually match, and the evidence was unambiguous: with sixteen checkers rules, reordering them changed which category of move failed. The structural fix, a unique first expression per rule, is covered in [rules patterns](../secure/rules-patterns.md). The linter flags the hazard as SHARED_GATE.

## The linter remembers so you don't

`pyric rules:lint` carries every number above as a threshold and reports the specific function, chain, or rule that crosses it, with a fix. It runs in-process, no deploy, so the first time production sees your rules they already fit. From an agent, the same check is `firestore_lint_rules`, and it runs before every deploy the agent attempts.

One honest note. The Firebase emulator does not reproduce the cross-rule budget and does not enforce these thresholds at production values. Rules that pass there can still fail to deploy, or deny at runtime. The numbers on this page were measured against production because that is where they apply.

## Where to go next

Lint and simulate together in [simulate and lint before you deploy](../secure/simulate-and-lint.md). To see rules engineered against these exact limits, read the [case studies](../secure/whats-possible.md).
