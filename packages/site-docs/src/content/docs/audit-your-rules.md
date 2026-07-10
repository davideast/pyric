---
title: "Find the holes before someone else does"
navLabel: "Audit your rules and data"
group: "Secure & debug"
section: ""
order: 17
description: "Get an evidence-backed answer to who can access what, with every serious finding proven by a simulation."
---

# Find the holes before someone else does

Your rules are a security boundary on the public internet, and anyone who cares to probe them can. An audit answers three questions with evidence: who can do what, whether the expressions mean what they appear to mean, and where the rules, the data, and the auth configuration disagree.

Pyric packages each audit as a skill, a procedure you or your agent runs against the real project. A finding does not make the report on a reading alone. It has to cite a simulation, a test, or a lint result that demonstrates it.

## Audit your Firestore rules

The `firestore-rules-audit` skill starts by building an access matrix: for every match block, identity by operation (get, list, create, update, delete), with no blank cells. Public writes, public reads on sensitive paths, and writes with no auth check fall out of the matrix immediately.

Then it checks each expression against its operation context, because rules have semantic traps that parse fine:

- On a `create` there is no `resource.data` yet. A rule like `request.auth.uid == resource.data.ownerId` on create is broken, and the intended check needs `request.resource.data` plus a uid comparison.
- Authorization must derive from what already exists. The writer controls `request.resource.data`, so authorization read from it is attacker-controlled by definition.
- A `list` cannot lean on a single document's fields. Rules are not filters.

Then composition. Any matching allow grants access, so a recursive wildcard like `{doc=**}` can bypass every carefully scoped sibling rule, and the audit states each wildcard's reach explicitly. It also flags user-controlled writes with no validation, undefined function calls, and role fields writable by the user they empower, which is privilege escalation in one line.

Critical findings are proven with `firestore_simulate_rules` runs that vary the auth context, and the report arrives severity-ranked with a fix per finding.

## Audit your Realtime Database rules

RTDB fails differently: access cascades downward. (Authoring those rules from typed constraints is its own page: [RTDB rules in TypeScript](../rtdb-rules-in-typescript/).) A `.read: true` near the root silently exposes every descendant, and a restrictive child cannot revoke what a permissive parent granted. The `rtdb-security-rules` skill walks every cascade from the root, so the effective access at each path is stated rather than assumed.

It also keeps the two semantics that trip people straight:

- `.validate` runs only after `.write` allows, and it never rescues a `.write` that is too broad. Every open path needs both an access rule and a shape rule.
- `data` is pre-write state and `newData` is post-write. Identity checks ("who is acting") belong on `data`. Result checks ("what must this become") belong on `newData`. In a multi-field write, mixing them up authorizes against values the writer is changing.

Before anything ships, each path is simulated four ways: intended actor allowed, anonymous denied, cross-user denied, invalid shape denied.

## Audit the whole project

Rules can be individually correct and collectively wrong. The `firebase-audit` skill cross-references three sources: the deployed rules, the actual data shape discovered by crawling the live database, and the enabled auth providers. The disagreements are the findings:

- Data paths no meaningful rule protects.
- Rules matching paths where no data exists, dead weight that hides intent.
- User-writable paths with no validation.
- Rules that gate on an identity no enabled provider can produce, a boundary nothing can exercise.

The report is severity-ranked, critical findings first, each citing the simulation or lint result that proves it. The audit stays read-only. Remediation is proposed in the report and applied only when you ask.

## And from an agent

All three audits are agent skills. Install them once and "audit my rules" becomes a request your agent executes end to end, running the same simulations and returning the same evidence-backed report. Install and catalog: [skills](../skills/).

## Where to go next

An audit finds the holes at a point in time. [Prove your rules protect the app](../secure-it-with-rules/) is how they stay closed as the rules evolve.
