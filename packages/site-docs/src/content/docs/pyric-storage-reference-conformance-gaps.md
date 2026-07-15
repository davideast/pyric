---
title: "Storage rules gaps: where pyric and Firebase disagree"
navLabel: "Storage rules gaps"
group: "pyric / storage"
section: "Reference"
order: 14006
---
# Storage rules gaps: where pyric and Firebase disagree

A gap is a rule that gets one answer from pyric and a different answer from
Firebase. You write the rule once. pyric allows the request and Firebase
denies it, or the other way round. The rule you tested is not the rule you
shipped.

Every gap on this page was captured from the production Rules Test API, not
inferred. There is one gap in the storage evaluator today. It affects the
create-if-absent idiom, which is common. Read that one section and you are
done.

## How to read severity

Every gap has two facts. A single label hides one of them, so this page
reports both.

**Fidelity** is the direction of the disagreement. Either pyric allows where
Firebase denies, or pyric denies where Firebase allows. Either way the verdict
you get locally is not the verdict you get in production, and the whole point
of a local mirror is that the two match.

**Production impact** is whether the gap lets a request through in production
that should not get through. It follows from the direction.

- **pyric allows, Firebase denies.** Production is stricter than pyric. Nothing
  pyric wrongly allowed reaches production, so there is no production hole. The
  cost is trust: a local ALLOW you relied on is wrong, and a legitimate
  operation you validated locally can be refused in production.
- **pyric denies, Firebase allows.** Production is more permissive than pyric.
  A request your local mirror refused can succeed in production. This is the
  direction that ships a hole: a rule you tested as blocking may not block.

Read both. A broken verdict with no production hole is still a broken verdict,
and a narrow trigger in the permissive direction is still the direction that
leaks.

## `resource == null` allows a create in pyric that Firebase denies

**Fidelity:** pyric allows, Firebase denies.
**Production impact:** no attacker reaches production, because Firebase denies
this create too. But the companion cases match on both sides (an update, and a
create over an object that already exists), so a real ruleset that guards writes
with `resource == null` / `resource != null` still denies unauthorized writes in
production. Only the case the guard exists for, the genuinely new object,
differs: locally it uploads, in production it is refused.

### What you would write

The create-if-absent guard. Anyone may upload a new object, nobody may
overwrite one:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileId} {
      allow create: if resource == null;
      allow update: if resource != null;
    }
  }
}
```

### What happens

Upload to `uploads/report.pdf` when no such object exists yet:

```ts
import { getStorage, ref, uploadBytes } from 'pyric/storage';

await uploadBytes(ref(getStorage(app), 'uploads/report.pdf'), bytes);
```

In pyric the create is ALLOWED. `resource` is null before the object exists,
so `resource == null` is true and the rule passes.

In Firebase the create is DENIED. Firebase never evaluates the comparison.
Reading `resource` on a create where no object exists raises a null value
error, the expression errors, and an errored expression denies.

Your rule does not do what you think it does. Locally every first upload
succeeds. In production every first upload is refused, and a `create` rule
guarded by `resource == null` never allows anything at all.

The rest of the idiom agrees on both sides. `allow update: if resource !=
null` behaves the same in pyric and Firebase, and a create against an object
that already exists is denied by both. Only the case the guard exists for,
the genuinely new object, differs.

### What you should do

Delete the existence check. Storage rules already give it to you: `create`
only fires when there is no existing object, and `update` only fires when
there is one. The verb is the existence check.

```
match /uploads/{fileId} {
  allow create: if request.auth != null;
  allow update: if request.auth != null
                && resource.metadata.owner == request.auth.uid;
}
```

Do not reference `resource` anywhere inside a `create` rule. Not
`resource == null`, not `resource != null`, not `resource.size`. There is no
object to read, and in production reading it errors, which denies. Put your
create conditions on `request` (`request.auth`, `request.resource.size`,
`request.resource.contentType`) and your overwrite conditions on `update`,
where `resource` is real.

The same bug exists in the Firestore engine and is tracked in
[#205](https://github.com/davideast/pyric/issues/205), where `resource` is
non-null for a missing document and existence guards written as
`resource != null` allow in pyric. Both are the same defect: pyric models the
absent-object value the way the documentation reads, and production does
something else. Until it closes, pyric keeps allowing this create.

## Everything else in the storage evaluator matches Firebase

Verified case for case against production captures, with no pinned
divergence:

- Verb grants. `read` expands to `get` and `list`, `write` expands to
  `create`, `update`, and `delete`, single verbs and comma-separated verb
  lists grant exactly what they name, and anything ungranted is denied.
- `resource` object identity and time fields: `name`, `bucket`,
  `timeCreated`, `updated`. Extension guards, freshness windows,
  immutability checks, and absent-property negation all agree.
- `resource.metadata` and `request.resource.metadata` reads, including
  metadata-driven verb grants and arithmetic on metadata values.
- `request.time`, timestamp comparison, and duration arithmetic.
- User-defined functions and `let` bindings, including their scoping.
- `matches()` regular expressions.
- Cross-service lookups: `firestore.get()` and `firestore.exists()`.

## How this is checked, and how to check it yourself

The gap above is replayed on every test run. The suite loads each captured
production observation, runs the same ruleset and the same request through
the local evaluator, and compares verdicts case for case.

- Suite: `packages/pyric/test/storage/rules-oracle-conformance.test.ts`.
  Run it with `bun test packages/pyric/test/storage/rules-oracle-conformance.test.ts`.
- Captures: `packages/conformance/observations/storage-rules/*.json`. Eight
  observations, one of which contains the divergent case.
- The gap's key: observation `rules-storage-verbs-umbrella-granular`, case
  `create allowed when object does not exist (resource == null)`. Production
  DENY, evaluator ALLOW.
- Ruleset and cases: `packages/conformance/rules-corpus/storage/verbs-umbrella-granular.ts`.

The gap is pinned in the suite's `KNOWN_DIVERGENCES` table, which asserts
both sides: production's captured verdict and the evaluator's live verdict.
The suite is green while the gap is exactly as described. It fails the moment
either side moves, including when someone fixes the evaluator, which forces
the fix to delete the pin instead of landing silently beside a stale one.

Before it was pinned it was live-probed against production twice, once with
the `resource` field omitted from the request and once with it sent
explicitly as null. Both are how the harness encodes "no existing object" on
the wire. Both denied identically with the same null value error, which rules
out a capture bug in the harness.

## Where to look next

- [Storage rules subset](../pyric-storage-reference-rules-subset/) for the grammar the evaluator
  supports.
- [Implementation scope and deferred features](../pyric-storage-explanation-implementation-scope/).
- [Compatibility matrix](../pyric-storage-compat/) for the row-by-row registry.
- [Firestore rules gaps](../pyric-rules-reference-conformance-gaps/) for the
  same page on the Firestore side.
