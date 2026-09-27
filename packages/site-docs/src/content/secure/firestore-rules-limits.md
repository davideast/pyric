---
title: "Fix Firestore Security Rules limit failures"
navLabel: "Rules limits"
group: "Secure & debug"
section: ""
order: 70
description: "Recognise a production Rules limit, see the invalid shape, and replace it with a valid one."
---

# Fix Firestore Security Rules limit failures

A ruleset can parse correctly and still fail to deploy, or return `permission-denied` because evaluation exhausted a production budget. Run the linter before deployment:
```bash
pyric rules lint --service firestore
```
The examples below show the shape that fails and the change that fixes it.

## Measured limits

The Firebase documentation gives different values for some limits on different pages. The table records what production does. Each value was measured on 2026-09-27 by submitting generated rulesets to the Rules Test API, which compiles and evaluates a ruleset without deploying it. Firestore and Storage rulesets gave the same result for every row.

| Limit | Documented | Measured | Production error at the first failing size |
|-------|-----------|----------|--------------------------------------------|
| Functions on one call stack, `f1()` calling `f2()` ... calling `fN()` | 10: Firestore and Storage "Writing conditions" pages. 20: Firestore "Structuring rules" limits table and the "Rules language" page. | 21 compile, 22 fail | `Maximum allowed call depth of 20 is reached for [f1->f2->...->f21] call stack.` |
| `let` bindings in one function | 10: Firestore "Structuring rules" limits table, Firestore "Writing conditions" page and the "Rules language" page. Any number: Storage "Writing conditions" page. | 11 compile, 12 fail | `Maximum allowed variable count of 10 for a given function has been reached.` |
| Terms in a right-nested `&&` chain, `t1 && (t2 && (...))` | Not documented | 49 compile, 50 fail | `Expression is too complex to evaluate safely.` |
| Parentheses around one comparison | Not documented | 97 pairs compile, 98 fail | `Expression is too complex to evaluate safely.` |

Both structural limits are compile-time checks. A ruleset over either limit is rejected before any request is evaluated, and a call chain over the limit is rejected even when no rule calls it. The error messages count differently from the measured boundaries: a 22-function chain reports a depth of 20, and 12 bindings report a count of 10.

The nesting boundaries, together with the 98-operand flat chain below, fit one limit in which each parenthesized group and each binary operator, including a comparison, puts its operands one level deeper, and an operand at level 100 is rejected. For chains of comparisons this is the same as counting each `&&` or `||` and each parenthesized group as one level: 97 levels compile and 98 fail. The Pyric Firestore simulator and Storage evaluator apply all three limits when a ruleset loads and refuse a ruleset over one with production's message, and the linter reports each of them, so keep nested groups shallow and split deep conditions into functions.

The runtime limit on evaluated expressions is a separate budget with its own cost model. See [More than 1000 evaluated expressions](#more-than-1000-evaluated-expressions).

## Source larger than 256 KB

Production accepts a rules source below 256 KB and rejects one at the ceiling. Generated lookup tables and repeated helpers are common causes.

Invalid: duplicate the same helper into many match blocks until the source crosses the limit.
```rules
match /teams/{teamId}/posts/{postId} {
  function signedIn() { return request.auth != null; }
  allow read: if signedIn();
}
match /teams/{teamId}/comments/{commentId} {
  function signedIn() { return request.auth != null; }
  allow read: if signedIn();
}
// ...thousands more duplicated blocks...
```
Valid: define shared helpers once at the database scope and split data-driven lookup tables into Firestore documents.
```rules
match /databases/{database}/documents {
  function signedIn() { return request.auth != null; }

  match /teams/{teamId}/posts/{postId} {
    allow read: if signedIn();
  }
  match /teams/{teamId}/comments/{commentId} {
    allow read: if signedIn();
  }
}
```
## Boolean chain longer than 98 terms

A flat `&&` or `||` chain compiles with 98 terms and fails at 99. The depth of the binary chain is the problem, not the number of leaf comparisons.

Invalid:
```rules
allow update: if check01() && check02() && check03()
  // ...the same flat chain continues...
  && check98() && check99();
```
Valid: group related checks into a balanced expression.
```rules
function identityChecks() {
  return (check01() && check02()) && (check03() && check04());
}
function dataChecks() {
  return (check05() && check06()) && (check07() && check08());
}
allow update: if identityChecks() && dataChecks();
```
Grouping reduces chain depth. Splitting into functions also consumes evaluation budget, so lint the final shape rather than mechanically creating dozens of helpers.

## More than 11 `let` bindings in one function

Eleven bindings compile; twelve fail, in Firestore and Storage rulesets.

Invalid:
```rules
function canUpdate() {
  let a = request.resource.data.a;
  let b = request.resource.data.b;
  let c = request.resource.data.c;
  let d = request.resource.data.d;
  let e = request.resource.data.e;
  let f = request.resource.data.f;
  let g = request.resource.data.g;
  let h = request.resource.data.h;
  let i = request.resource.data.i;
  let j = request.resource.data.j;
  let k = request.resource.data.k;
  let l = request.resource.data.l;
  return a && b && c && d && e && f && g && h && i && j && k && l;
}
```
Valid: keep only values that are reused and read one-off fields directly.
```rules
function canUpdate() {
  let next = request.resource.data;
  return next.a && next.b && next.c && next.d
    && next.e && next.f && next.g && next.h
    && next.i && next.j && next.k && next.l;
}
```
## More than 10 document access calls

An evaluation may use at most 10 `get()` and `exists()` calls for a single-document request or query. Repeated reads of the same path are cached; reads of different paths are not.

Invalid:
```rules
function hasEveryGrant() {
  return exists(/databases/$(database)/documents/grants/01)
    && exists(/databases/$(database)/documents/grants/02)
    // ...different paths 03 through 10...
    && exists(/databases/$(database)/documents/grants/11);
}
```
Valid: put related grants in one document and read one path.
```rules
function grants() {
  return get(/databases/$(database)/documents/config/grants).data;
}
allow write: if request.auth.uid in grants().editors;
```
## More than 1000 evaluated expressions

Production stops a request when its evaluation reaches 1000 expressions and returns `permission-denied`, which looks like a denial you intended. The Rules Test API names the cause in its debug message: `Unable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached.`

The limit is per request. Allow rules for the request's method run in source order until one grants, and every rule evaluated on the way counts. Within a rule, measurements against the Rules Test API show what one expression is:

- Each evaluated identifier, literal, field or index access, method or function call, comparison, `!` or `in` costs 1.
- `&&` and `||` cost 1, plus 1 when they evaluate their right side. A short-circuited side costs nothing.
- A ternary costs 2 plus its condition and the branch it takes.
- A path such as `/databases/$(database)/documents/config/game` costs 1 plus 1 per segment.
- A function's `let` values are evaluated on every call, even when the body does not read them.
- Every call pays again; a helper called five times costs five times.

Twenty comparisons like `resource.data.a == 1` joined by `&&` cost about 135. A chess move validator with board, path and check detection measured 810 to 990 per move, and its checkmating queen move reached the limit.

Invalid: every allow rule starts by calling the same expensive gate, so a request pays for it once for each rule evaluated before the one that grants.
```rules
allow update: if expensiveSharedGate() && isTitleEdit();
allow update: if expensiveSharedGate() && isStatusEdit();
allow update: if expensiveSharedGate() && isOwnerEdit();
```
Valid: put a cheap, mutually exclusive discriminator first, then call the expensive check only for the matching operation.
```rules
allow update: if isTitleEdit() && expensiveSharedGate();
allow update: if isStatusEdit() && expensiveSharedGate();
allow update: if isOwnerEdit() && expensiveSharedGate();
```
The linter reports the repeated prefix as `SHARED_GATE`. It reports `EXPRESSION_BUDGET` when the most expensive request a rule can grant, counting the earlier rules that deny it first, reaches 1000. That estimate never fell below production on the measured requests. Where the path depends on document values, it assumes the expensive branch, so a warning means some document can take the request over the limit, not that every request will.

## Oversized indexed configuration documents

Firestore rejected an observed configuration document near 40,000 index entries even though its bytes were below the document-size limit.

Invalid: store tens of thousands of deeply indexed lookup keys in one document.
```text
/config/moves
  moves: { ...approximately 40,000 indexed leaf values... }
```
Valid: split the lookup into bounded documents and exempt fields from indexing when queries never use them.
```text
/moveConfigs/checkers-white
/moveConfigs/checkers-black
```
Index exemptions are configured in Firestore, not in Security Rules. Count indexed keys as well as document bytes when you design a lookup document.

## Check the corrected rules

Linting reports the function, chain, or repeated gate that crosses a threshold:
```bash
pyric rules lint --service firestore
```
Then run explicit allow and deny cases with `firestoreRules(source).simulate(cases)` or the `firestore_simulate_rules` MCP tool. The Firebase emulator does not reproduce all of these production thresholds, so an emulator pass is not evidence that the rules fit the production compiler and evaluator.
