---
title: "Never debug a bare permission-denied again"
navLabel: "Read a denial and understand it"
group: "Secure & debug"
section: ""
order: 3004
description: "See which rule denied an operation, on what path, with what data, the moment it happens."
---

# Never debug a bare permission-denied again

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
- **`matchedRule`**: the `ruleIndex` and `operations` of the rule that decided.
- **`resourceBefore` and `request.resourceData`**: the existing document and the incoming payload, the exact data the rule evaluated against.
- **`origin`**: whether the op came from your code, a listener re-evaluation, a batch, or a transaction. A listener denial also carries `triggeredBy`, the write that provoked it.

That last field earns its place. A listener silently dropping documents because a read rule denies them is invisible in production. Here it is a row in the stream with a reason attached.

If you are running `pyric dev --ui`, you do not have to write the subscription. The Traffic tab in Studio shows the same stream live, and a denial row opens into the rule, the path, and the data. The stream itself, and what else it can tell you, is covered in [see what's happening](../see-whats-happening/).

## Read the rule that allowed it, too

A denial is not the only verdict worth reading. When you want to confirm exactly which `allow` rule granted access, ask the ruleset to explain a single case:
```ts
import { firestoreRules } from 'pyric/rules';

const explanation = firestoreRules(source).explain({
  description: 'owner reads own note',
  expectation: 'ALLOW',
  method: 'get',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  resource: { ownerId: 'alice', title: 'note' },
});

console.log(explanation.decision);           // 'ALLOW'
console.log(explanation.deciding?.verdict);   // 'allow'
console.log(explanation.deciding?.line);      // source line of the allow rule
console.log(explanation.deciding?.expression); // the condition text that granted it
```
`explain` returns the same structured account for an allow as for a deny. Its `deciding` field is an `EvaluatedRuleInfo`: the `verdict`, the source `line`, the `expression` that decided, and an `expressionTrace` stepping through each sub-expression. For an allow it points at the rule that granted access, so "why did this succeed" is as answerable as "why did this fail." On a default-deny, where no `allow` rule matched at all, `deciding` is absent.

## The other kind of denial bug

A denial that should not happen is one failure mode. The quieter one is its opposite: an operation that should be denied and no longer is, because a rules edit removed a predicate somewhere. This usually happens while making a failing test pass.

Pyric catches it by replay. A `pyric dev` session records the real operations your app ran into `.pyric/last-session.json`. Point `pyric verify` at a candidate ruleset and it re-issues every captured operation against it, then reports any verdict that flipped:
```bash
pyric verify --rules firestore=firestore.rules
```
If an operation that was denied under the recorded run now succeeds, that is a divergence, and `verify` exits `1`. The op that used to be blocked is now allowed, in the exact traffic your app produces, before the rules ship. Run it in CI and a weakened rule fails the build.

One boundary stated plainly: replay only sees the operations in the capture. A flip on a path your session never exercised will not surface here. The breadth of the capture bounds it, and your [test suite](../write-a-rules-test-suite/) is the net for the operations traffic did not reach.

## And from an agent

When an agent hits a denial, one `sandbox_inspect` call returns the current rules, a lint summary, and the recent denials from the event log together, so "why is my rule failing" is one tool call instead of an archaeology session. See [skills](../skills/).

## Where to go next

The denial stream is one view of a larger one. Watch every read, write, and listener fire live in [see what's happening](../see-whats-happening/). And before a rules change ships, [replay real traffic against it](../ship-to-production/) to learn which verdicts flip.
