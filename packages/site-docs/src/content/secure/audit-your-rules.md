---
title: "Audit Security Rules and data before production"
navLabel: "Audit rules and data"
group: "Secure & debug"
section: ""
order: 80
description: "Get an evidence-backed answer to who can access what, with every serious finding proven by a simulation."
---

# Audit Security Rules and data before production

Your rules are a security boundary on the public internet. Anyone who cares to probe them can.

An audit answers three questions with evidence:

- Who can do what?
- Do the expressions mean what they appear to mean?
- Where do the rules, the data, and the auth configuration disagree?

Pyric packages each audit as a skill you or your agent runs against the real project. A finding never makes the report on a reading alone. It has to cite a simulation, a test, or a lint result that proves it.

## Audit Firestore Security Rules

The `firestore-rules-audit` skill builds an access matrix first: every match block, identity by operation (get, list, create, update, delete), no blank cells. Public writes, public reads on sensitive paths, and writes with no auth check fall out immediately.

Then it checks each expression against its operation context, because rules have traps that parse fine:

- **No `resource.data` on `create`.** A rule like `request.auth.uid == resource.data.ownerId` is broken on create; it needs `request.resource.data` plus a uid comparison.
- **Authorization must derive from what already exists.** The writer controls `request.resource.data`, so any check read from it is attacker-controlled.
- **A `list` cannot lean on one document's fields.** Rules are not filters.

Then it checks composition. Any matching allow grants access, so a recursive wildcard like `{doc=**}` can bypass every scoped sibling rule; the audit states each wildcard's reach explicitly. It also flags user-controlled writes with no validation, undefined function calls, and role fields writable by the user they empower (privilege escalation in one line).

Critical findings are proven with `firestore_simulate_rules` runs that vary the auth context. The report arrives severity-ranked, with a fix per finding.

## Audit Realtime Database Security Rules

RTDB fails differently: access cascades downward. A `.read: true` near the root silently exposes every descendant, and a restrictive child cannot revoke what a permissive parent granted.

The `rtdb-security-rules` skill walks every cascade from the root, so effective access at each path is stated rather than assumed. (Authoring these rules from typed constraints is its own page: [RTDB rules in TypeScript](./rtdb-rules-in-typescript.md).)

It also keeps the two semantics that trip people up:

- **`.validate` runs only after `.write` allows.** It never rescues a `.write` that is too broad. Every open path needs both an access rule and a shape rule.
- **`data` is pre-write, `newData` is post-write.** Identity checks ("who is acting") belong on `data`; result checks ("what must this become") belong on `newData`. Mixing them in a multi-field write authorizes against values the writer is changing.

Before anything ships, each path is simulated four ways: intended actor allowed, anonymous denied, cross-user denied, invalid shape denied.

## Audit the whole project

Rules can be individually correct and collectively wrong. The `firebase-audit` skill cross-references three sources: the deployed rules, the actual data shape found by crawling the live database, and the enabled auth providers. The disagreements are the findings:

- Data paths no meaningful rule protects.
- Rules matching paths where no data exists (dead weight that hides intent).
- User-writable paths with no validation.
- Rules that gate on an identity no enabled provider can produce.

The report is severity-ranked, critical first, each finding citing the simulation or lint result that proves it. The audit stays read-only. Remediation is proposed in the report and applied only when you ask.

## Run the audits through an agent

An MCP-connected agent can run the audit end to end, executing the same simulations and returning the same evidence-backed report. Start with the concrete prompts in [Work with an agent](../agent/work-with-an-agent.md).

## Where to go next

An audit finds the holes at a point in time. [Prove your rules protect the app](./secure-it-with-rules.md) is how they stay closed as the rules evolve.
