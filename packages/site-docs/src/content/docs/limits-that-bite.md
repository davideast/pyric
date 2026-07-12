---
title: "Firestore rules compiler and evaluator limits"
navLabel: "Rules limits"
group: "Secure & debug"
section: ""
order: 3008
description: "Know the measured limits of the production rules compiler and evaluator, with the exact numbers and the failing shape, so your rules compile the first time and hold up under load."
---

# Firestore rules compiler and evaluator limits

A ruleset can be syntactically perfect and still fail two ways. A 400 at deploy with no useful message. Or a silent 403 at runtime that looks exactly like a denial you wrote.

Both come from real limits in the production compiler and evaluator, researched and observed behavior: Pyric's tooling probed production Firestore directly, isolating one variable at a time, and recorded what it measured. The numbers below ship inside Pyric's linter as thresholds, so you do not have to remember them.

## 256 KB of source

For a long time the working assumption was a "30 to 37 KB practical limit" on rules source. It was wrong: that number was chain depth in disguise, because complex rulesets happened to hit the depth limit around that size, and size took the blame.

```rules
// 4,200 trivial match blocks, one comparison each: 262,145 bytes
match /doc0001/{id} { allow read: if resource.data.ok == true; }
match /doc0002/{id} { allow read: if resource.data.ok == true; }
// ...4,198 more, same shape...
```

`SOURCE_SIZE: Rules source is 262,145 bytes, exceeding the 256 KB limit.`

The real ceiling is bytes alone, no relation to structure: 58 KB of simple functions compiles without complaint, and a file of trivial comparisons compiles at 250 KB and fails at 256.

## 98 terms in a flat chain

A flat chain of `a && b && c && ...` compiles at 98 terms and fails at 99. Same for `||`. The limit counts the depth of the top-level binary chain, not the number of comparisons, so nesting resets it.

```rules
// flat: chain depth equals term count
allow write: if a && b && c && d && e && f && g && h;

// grouped: chain depth is roughly halved
allow write: if (a && b) && (c && d) && (e && f) && (g && h);
```

At 99 flat terms: `CHAIN_DEPTH: Function has a && chain of depth 99. Limit is 98.` Grouped the same way, the same 99 terms compile. `a && b && c && d` becomes `(a && b) && (c && d)`.

## 11 let bindings per function

Eleven `let` bindings in a function compile. Twelve fail, with the same unexplained 400 as every other compilation failure.

```rules
function tooDeep() {
  let a1 = 1; let a2 = 2; let a3 = 3; let a4 = 4;
  let a5 = 5; let a6 = 6; let a7 = 7; let a8 = 8;
  let a9 = 9; let a10 = 10; let a11 = 11; let a12 = 12;
  return a12 == 12;
}
```

`LET_LIMIT: Function 'tooDeep' has 12 let bindings. Limit is 11.` The fix is inlining the last binding into the return statement, or splitting the function in two.

## 10 get() calls per evaluation, cached by path

This limit is Google's own documented number. What is not written down is the caching: results are cached per unique path, so a shared helper called from several functions costs one read, while several different paths cost several.

```rules
function config() { return get(/databases/$(db)/documents/config/app).data; }

// two calls to config(): ONE get(), cached by path
allow read: if config().publicRead == true || config().betaFlag == true;
```

That rule spends 1 of the 10 allowed calls, not 2. Six distinct paths spend six:

`GET_COUNT: Rule may invoke 6 distinct get() calls. Limit is 10.` The linter warns past 5 distinct calls and errors at the documented 10.

## The runtime budget, and its flaky zone

The compile-time limits fail loudly at deploy. This one does not: a rule whose evaluation is too expensive returns 403 PERMISSION_DENIED at runtime, indistinguishable from a denial you intended.

```rules
function big1() { return e1 && e2 && e3 && e4 && e5; /* ...55 more... */ }
function big2() { return f1 && f2 && f3 && f4 && f5; /* ...60 more... */ }

// 2 function calls, 130 total expressions
allow write: if big1() && big2();
```

Deployed and tested five times, that shape passes 2 of 5. The same 130 expressions split across three functions instead of two fails nearly every time:

| Shape | Total expressions | Result |
|---|---|---|
| 2 functions of 60 | 120 | 5/5 pass |
| 2 functions of 65 | 130 | 2/5 pass |
| 3 functions of 20 | 60 | 2/5 pass |
| 3 functions of 50 | 150 | 0/5 pass |

Read the first row against the third. Two function calls with 120 total expressions always pass. Three calls with half that total are already flaky. Function calls carry heavy overhead, so the budget is call-count-dependent, and between "always passes" and "never passes" sits a genuine flaky zone: the same rule passes most of the time and intermittently denies under load. The linter models this with conservative tiers:

- 1-2 function calls: warns past 100 total expressions.
- 3 function calls: warns past 60.
- 4 or more: warns past 40.

## About 40,000 index entries in a config document

The config-document pattern has a ceiling on the data side, separate from the rules side.

```rules
// config/lookup document, 207 KB, ~39,000 top-level keys
{
  "AAA111": { "valid": true },
  "AAB112": { "valid": true }
  /* ...38,998 more keys... */
}
```

`too many index entries for entity` past roughly 39,000 keys at 207 KB. A 129 KB document with 19,000 keys writes fine. If your lookup document is large, budget its keys, not only its bytes.

## The budget that spans rules

The runtime expression budget is shared across all the allow rules of a match block, evaluated in order, so a rule that never matches still spends from the same account as the rule that will.

```rules
allow write: if isMove() && movePawn();
allow write: if isMove() && movePiece();
```

`SHARED_GATE: Rules 0, 1 share the same gate expression 'isMove()'. This may cause cross-rule budget exhaustion.` With sixteen checkers rules sharing one gate, reordering them changed which category of move failed. The fix is a unique first expression per rule:

```rules
allow write: if isMove() && moveType == 'pawn' && movePawn();
allow write: if isMove() && moveType == 'piece' && movePiece();
```

The structural pattern this points to is covered in [rules patterns](../rules-patterns/).

## The linter carries every threshold

```bash
pyric rules:lint firestore.rules
```

```
[error] CHAIN_DEPTH: Function 'canMove' has a && chain of depth 99. Limit is 98.
   fix: Group into nested pairs: (a && b) && (c && d).
```

Every number above is a threshold the linter carries, and it names the specific function, chain, or rule that crosses it. Called as a library it is `lint(source)` or `firestoreRules(source).lint()`, both from `pyric/rules`, both returning a `RuleIssue[]` with no deploy and no network. From an agent, the same check is `firestore_lint_rules`, and it runs before every deploy the agent attempts.

One honest note. The Firebase emulator does not reproduce the cross-rule budget and does not enforce these thresholds at production values. Rules that pass there can still fail to deploy, or deny at runtime. The numbers on this page were measured against production because that is where they apply.

## Where to go next

Lint and simulate together in [simulate and lint before you deploy](../simulate-and-lint/). To see rules engineered against these exact limits, read the [case studies](../rules-case-studies/).
