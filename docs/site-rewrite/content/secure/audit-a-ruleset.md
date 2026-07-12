---
title: Audit a ruleset
navLabel: Audit rules and data
outcome: Get an evidence-backed answer to who can access what, with every serious finding proven by a simulation.
status: draft
---

# Audit a ruleset

An audit answers three questions with evidence: who can do what, whether an expression means what it appears to mean, and where the rules, the data, and the auth configuration disagree.

Pyric packages each audit as a skill, a procedure you or your agent runs against the real project. A finding does not make the report on a reading alone. It has to cite a simulation, a test, or a lint result that demonstrates it.

## Audit your Firestore rules

The `firestore-rules-audit` skill starts by building an access matrix: for every match block, identity by operation (get, list, create, update, delete), with no blank cells. Public writes, public reads on sensitive paths, and writes with no auth check fall out of the matrix immediately.

Then it checks each expression against its operation context, because some rules parse fine and mean the wrong thing:

```rules
// looks right, isn't: resource.data doesn't exist yet on create
match /notes/{noteId} {
  allow create: if request.auth.uid == resource.data.ownerId;
}
```

Every create is denied, even the owner's own, because `resource.data` is null until the document exists. The fix reads the incoming write instead:

```rules
allow create: if request.auth.uid == request.resource.data.ownerId;
```

Two more traps the audit checks for by rule:

- Authorization has to derive from what already exists, `resource.data`. The writer controls `request.resource.data`, so a check that reads its authorization from there is checking a value the client wrote in this same request, not a value that was already true.
- A `list` cannot lean on a single document's fields. A list query has to be constrained so it can only return documents the rule already allows; rules are not filters.

Then composition. Any matching allow grants access, so a recursive wildcard like `{doc=**}` can bypass every carefully scoped sibling rule, and the audit states each wildcard's reach explicitly. It also flags user-controlled writes with no validation, undefined function calls, and role fields writable by the user they empower, which is privilege escalation in one line.

Critical findings carry proof, not only a reading of the source:

```ts
import { firestoreRules, explainCase } from 'pyric/rules';

const ruleset = firestoreRules(source);
const [result] = ruleset.simulate([
  {
    description: 'stranger reads the admin panel',
    expectation: 'DENY',
    method: 'get',
    path: 'admin/config',
    auth: { uid: 'mallory' },
  },
]).cases;

if (!result.passed) console.log(explainCase(result));
```

`FAIL: stranger reads the admin panel (expected DENY, got ALLOW)`. The same check from a terminal is `pyric rules:lint firestore.rules`, which catches the wildcard-plus-`if true` shape as `RECURSIVE_WILDCARD_OPEN` before a single case runs. From an agent it is `firestore_simulate_rules` and `firestore_lint_rules`, and the report arrives severity-ranked with a fix per finding.

## Audit your Realtime Database rules

RTDB fails differently: access cascades downward. (Authoring those rules from typed constraints is its own page: [RTDB rules in TypeScript](../secure/rtdb-rules-in-typescript.md).) A `.read: true` near the root silently exposes every descendant, and a restrictive child cannot revoke what a permissive parent granted.

```json
{
  "rules": {
    "orgs": {
      ".read": true,
      "$orgId": {
        "secrets": { ".read": "auth != null" }
      }
    }
  }
}
```

The root `.read: true` already exposes `orgs/$orgId/secrets`; the narrower rule underneath it never runs. The `rtdb-security-rules` skill walks every cascade from the root, so the effective access at each path is stated rather than assumed.

It also keeps the two semantics that trip people up:

- `.validate` runs only after `.write` allows, and it never rescues a `.write` that is too broad. Every open path needs both an access rule and a shape rule.
- `data` is pre-write state and `newData` is post-write. Identity checks ("who is acting") belong on `data`. Result checks ("what must this become") belong on `newData`. In a multi-field write, mixing them up authorizes against values the writer is changing.

Before anything ships, each path is simulated four ways with `rtdb_simulate_access` (or `pyric database:rules:simulate --stdin` from a terminal): intended actor allowed, anonymous denied, cross-user denied, invalid shape denied.

## Audit the whole project

Rules can be individually correct and collectively wrong. The `firebase-audit` skill cross-references three sources: the deployed rules, the actual data shape discovered by crawling the live database, and the enabled auth providers. The disagreements are the findings:

- Data paths no meaningful rule protects.
- Rules matching paths where no data exists, dead weight that hides intent.
- User-writable paths with no validation.
- Rules that gate on an identity no enabled provider can produce, a boundary nothing can exercise.

The report is severity-ranked, critical findings first, each citing the simulation or lint result that proves it. The audit stays read-only. Remediation is proposed in the report and applied only when you ask.

## And from an agent

All three audits are agent skills. Install them once and "audit my rules" becomes a request your agent executes end to end, running the same simulations and returning the same evidence-backed report. Install and catalog: [skills](../agent/skills.md).

## Where to go next

An audit finds the holes at a point in time. [Prove your rules protect the app](../secure/secure-it-with-rules.md) is how they stay closed as the rules evolve.
