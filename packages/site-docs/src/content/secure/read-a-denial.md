---
title: "Read a Security Rules denial"
navLabel: "Read a denial and understand it"
group: "Secure & debug"
section: ""
order: 40
description: "See which rule denied an operation, on what path, with what data, the moment it happens."
---

# Read a Security Rules denial

In production, a blocked operation answers with one string: `permission-denied`. Not which rule. Not what the rule saw.

In Pyric, every operation the backend evaluates produces a verdict you can read, and a denial arrives carrying its own explanation.

## Every operation carries a verdict

While your app runs against the sandbox, every read, write, and query passes through the rules engine, and each evaluation emits a typed event. Denials are not a separate channel. They are the same stream, filtered:
```ts
sandbox.onEvent((e) => {
  if (e.kind === 'request' && e.result === 'deny') {
    console.log(e.method, e.path, e.auth, e.reasons, e.matchedRule);
  }
});
```
A denial event tells you the story in one object:

- **`method` and `path`**: what was attempted, and where. `update` on `notes/n1`.
- **`auth`**: who attempted it, including token claims if the identity had them. `null` means unauthenticated, which is its own common answer.
- **`reasons`**: the trace of the decision, rule by rule.
- **`matchedRule`**: the index and operations of the rule that decided.
- **`resourceBefore` and `request.resourceData`**: the existing document and the incoming payload, the exact data the rule evaluated against.
- **`origin`**: whether the op came from your code, a listener re-evaluation, a batch, or a transaction. A listener denial also carries `triggeredBy`, the write that provoked it.

That last field earns its place. A listener silently dropping documents because a read rule denies them is invisible in production. Here it is a row in the stream with a reason attached.

If you are running with Studio on (the Vite plugin default), you do not have to write the subscription. The Traffic tab in Studio shows the same stream live, and a denial row opens into the rule, the path, and the data. The stream itself, and what else it can tell you, is covered in [see what's happening](../observe/see-whats-happening.md).

## Inspect the original Firestore evaluation in the runtime chip

Open a denied request in the chip's **Traffic** tab. **Identity** describes who made the request; it is not a diagnosis. The explanation below it comes from the evaluation that handled that request, even if you subsequently change the rules, documents, or signed-in user.

**Checks that failed** shows each comparison with its actual value and what the rule checked it against. **Rule details** explains which path patterns apply, then shows the recorded expressions, results, functions, variables, skipped branches, and errors. A false condition is not enough to deny access when another applicable rule grants it. The summary uses the evaluator's final decision across those alternatives.

Query constraint proofs are separate from the evaluation of remaining conditions. Locations labeled **Residual line** refer to generated evaluation source, not deployed rules. Unsupported evaluations, admin bypass, and missing evidence are identified explicitly. These are local evaluator results, not a claim that Pyric can explain a production Firebase response.

The sandbox keeps evidence for its latest **64 evaluated requests**, alongside the normal request history. Each snapshot retains at most **32 rules**, **128 expression checks** across those rules, **32 path matches**, and **32 query-proof failures**; text fields are capped at **256 characters**. Truncation and expired evidence are explicit. The chip retains its latest 64 Traffic rows and a separate snapshot of the request currently being inspected. Full documents and complete sign-in records are not included in the displayed checks. Individual values can still be private; review them before copying or sharing. Opening details never replays the request.

## Read a Realtime Database denial

Production answers a blocked Realtime Database request with `PERMISSION_DENIED: Permission denied` and nothing else. The sandbox rejects with the same error, and records the reason next to it.

### Find the deciding rule in the event stream

A Realtime Database operation emits an `operation` event with `service: 'rtdb'`. A denial carries the rule that decided it:
```ts
sandbox.onEvent((e) => {
  if (e.kind === 'operation' && e.service === 'rtdb' && e.result === 'deny') {
    console.log(e.method, e.path, e.auth, e.rules?.matchedPath, e.rules?.matchedRule, e.rules?.reason);
  }
});
```
For a write by `mallory` to `/records/r1` that a `.write` rule refuses, the event reads:
```
set /records/r1 { uid: 'mallory' } /records/$id auth != null && newData.child('ownerId').val() === auth.uid
No 'write' rule grants access; the deepest, at '/records/$id', evaluated to false
```
The event also carries `request.data`, the value the request wrote, and `resourceBefore`, the data at the path before the write. These are the values the rule evaluated against. In Studio, the Traffic tab shows the same rows.

### Read the reason

The same `matchedPath`, `matchedRule`, and `reason` come back from `rtdbRules(...).simulate`, so a failing case and a denial in a running app read alike. `matchedPath` is the rule's location in the ruleset, so a wildcard appears as `$id`, not as the concrete key.

| Reason | What decided |
|---|---|
| `No 'read' rule grants access; the deepest, at '<path>', evaluated to false` | No rule on the path from the root granted the request. The named rule is the deepest one of that kind. |
| `No 'write' rule on '<path>' or its ancestors grants access; denied by default` | No rule of that kind exists on the path. `matchedPath` and `matchedRule` are empty. |
| `Validation rule evaluated to false` | A `.write` rule granted, and a `.validate` rule at or below the written path refused. `matchedPath` names the `.validate` location. |
| `Validation rule at '<path>' failed at evaluation: <error>` | A `.validate` rule raised a runtime error, such as calling `toUpperCase()` on a number. A rule that errors does not grant. |
| `'<operation>' rule at '<path>' contains an expression the simulator cannot evaluate` | The case is `UNSUPPORTED`. The simulator abstained, and production may allow or reject it. |

Two causes account for most unexpected denials. A `.validate` rule never runs when `.write` denies, so a validation failure means the write rule already granted. And access cascades downward, so the deepest rule named is the last one tried, not the only one that applies. Walk each rule from the root to find which grant is missing.

### Tell an index error from a denial

A missing `.indexOn` is not a permission problem, and the two fail differently. Take a query ordered by a child with no matching index:
```ts
import { query, ref, orderByChild, limitToFirst, get, onValue } from 'pyric/database';

const budgets = query(ref(db, 'projects'), orderByChild('budget'));
await get(budgets);
// Error: Index not defined, add ".indexOn": "budget", for path "/projects", to the rules

const smallest = query(ref(db, 'projects'), orderByChild('budget'), limitToFirst(1));
onValue(smallest, (snapshot) => console.log(snapshot.val()));
// { a: { budget: 5 } }
// @firebase/database: FIREBASE WARNING: Using an unspecified index. Your data will be
// downloaded and filtered on the client. Consider adding ".indexOn": "budget" at
// /projects to your security rules for better performance.
```
This matches production:

- **`get()` rejects.** A `get()` on an `orderByChild` or `orderByValue` query rejects with a plain `Error`, not a `PERMISSION_DENIED`, whether or not the query has a limit or range.
- **Listeners deliver and warn.** `onValue` and the `onChild*` listeners are not rejected. The client downloads the location, filters it locally, and delivers the filtered result. When the query has a limit or a range, it also logs the warning above. A listener on a query with neither logs nothing. Under `pyric sandbox` and the Vite plugin, the warning is logged in the page that made the call.
- **`orderByKey` needs no index.**

Add the index at the queried location in the rules, and the warning and the `get()` rejection both stop:
```json
{
  "rules": {
    "projects": {
      ".read": true,
      ".indexOn": ["budget"]
    }
  }
}
```
A listener that works while the equivalent `get()` rejects points to a missing index.

## The other kind of denial bug

A denial that should not happen is one failure mode. The quieter one is its opposite: an operation that should be denied and no longer is, because a rules edit removed a predicate somewhere. This usually happens while making a failing test pass.

Pyric catches it by diffing rulesets. Lint the candidate with the previously deployed source:
```ts
import { lintFirestoreRules } from 'pyric/rules';

const result = lintFirestoreRules(newSource, { previousSource: oldSource });
const weakened = result.warnings.filter((w) => w.rule === 'RULES_WEAKENED');
```
The linter normalizes every match path and diffs the predicates conjunct by conjunct. It reports three shapes of weakening:

- a match block that had `allow` rules and is gone
- an `allow` rule that was deleted
- a dropped conjunct, for example `auth.uid == ownerId && status == 'open'` becoming only `auth.uid == ownerId`

`RULES_WEAKENED` is a warning, not an error, because removing a predicate is sometimes a legitimate refactor. The signal is "a human should look at this," and in CI you decide whether that means a required ack or a hard block.

One boundary stated plainly: the diff compares the predicates in `allow` statements, so weakening a helper function's body does not fire it. Your [test suite](./write-a-rules-test-suite.md) is the net for that shape.

## Diagnose a denial through an agent

When an agent hits a denial, one `sandbox_inspect` call returns the current rules, a lint summary, and the recent denials from the event log together. [Work with an agent](../agent/work-with-an-agent.md) gives a task prompt for this exact diagnosis. For a Realtime Database denial, the agent reproduces the request with `rtdb_simulate_access` and reads `matchedPath`, `matchedRule`, and `reason` from the result.

## Where to go next

The denial stream is one view of a larger one. Watch every read, write, and listener fire live in [see what's happening](../observe/see-whats-happening.md). And before a rules change ships, [replay real traffic against it](../ship/ship-to-production.md) to learn which verdicts flip.
