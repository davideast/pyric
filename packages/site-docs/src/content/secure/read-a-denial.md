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

**Deciding checks** shows the matching conditions and the observed scalar operands beneath failed checks. **Full evaluation** adds retained path matches, helper and binding context, nested expression results, short-circuited branches, and errors. A false condition is not enough to deny access when another applicable rule grants it. The summary uses the evaluator's final decision across those alternatives.

Query constraint proofs are separate from the evaluation of remaining conditions. Locations labeled **Residual line** refer to generated evaluation source, not deployed rules. Unsupported evaluations, admin bypass, and missing evidence are identified explicitly. These are local evaluator results, not a claim that Pyric can explain a production Firebase response.

The sandbox keeps evidence for its latest **64 evaluated requests**, alongside the normal request history. Each snapshot retains at most **32 rules**, **128 expression checks** across those rules, **32 path matches**, and **32 query-proof failures**; text fields are capped at **256 characters**. Truncation and expired evidence are explicit. The chip retains its latest 64 Traffic rows and a separate snapshot of the request currently being inspected. Full document objects and token maps are omitted from the evidence; accessed scalar values can still contain application data. Opening details never replays the request.

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

When an agent hits a denial, one `sandbox_inspect` call returns the current rules, a lint summary, and the recent denials from the event log together. [Work with an agent](../agent/work-with-an-agent.md) gives a task prompt for this exact diagnosis.

## Where to go next

The denial stream is one view of a larger one. Watch every read, write, and listener fire live in [see what's happening](../observe/see-whats-happening.md). And before a rules change ships, [replay real traffic against it](../ship/ship-to-production.md) to learn which verdicts flip.
