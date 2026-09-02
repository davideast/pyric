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
pyric firestore rules lint firestore.rules
```
The examples below show the shape that fails and the change that fixes it.

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

Eleven bindings compile; twelve fail.

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
## Too much runtime evaluation

The runtime expression budget does not fail at deploy. An expensive rule returns `permission-denied`, which looks like a denial you intended. Measurements show the budget depends heavily on function-call count: two functions with 120 total expressions passed consistently, while three functions with 60 expressions already failed intermittently.

Invalid: every allow rule starts by calling the same expensive gate, so a request pays for it repeatedly while Firestore evaluates possible rules.
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
The linter reports this repeated-prefix hazard as `SHARED_GATE`. Its conservative expression warnings begin at 100 expressions for one or two function calls, 60 for three or four, and 40 for five or more.

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
pyric firestore rules lint firestore.rules
```
Then run explicit allow and deny cases with `firestoreRules(source).simulate(cases)` or the `firestore_rules.simulate` MCP tool. The Firebase emulator does not reproduce all of these production thresholds, so an emulator pass is not evidence that the rules fit the production compiler and evaluator.
