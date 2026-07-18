---
title: "Audit Security Rules and data before production"
navLabel: "Audit rules and data"
group: "Secure & debug"
section: ""
order: 80
description: "Find the rule that looks right and isn't — every finding proven by a simulation you can rerun."
---

# Audit Security Rules and data before production

This rule looks right. It isn't:

```rules
match /notes/{noteId} {
  allow create: if request.auth.uid == resource.data.ownerId;
}
```

On `create` there is no `resource.data` — the document doesn't exist yet — so the comparison never holds and the rule denies every create. Or worse, flip the intent and a sibling rule quietly grants it. The audit doesn't argue about it; it runs the request:

```ts
firestoreRules(source).simulate([{
  description: 'owner creates their own note',
  expectation: 'ALLOW',
  method: 'create',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  data: { ownerId: 'alice', title: 'first' },
}]);
// 1 failed — DENY, decided by match /notes/{noteId} allow create
```

The fix is `request.resource.data.ownerId` — the incoming document, which exists. Rerun, `1 passed`. That is the audit's contract: **no finding without a simulation that proves it, no fix without a rerun that confirms it.**

## The traps the audit runs, not reads

**Authorization from attacker-controlled fields.**

```rules
allow update: if request.resource.data.role == 'admin';
```

The writer controls `request.resource.data`. Simulated as `mallory` sending `{ role: 'admin' }`: allowed. Authorization must derive from what already exists (`resource.data`) or from auth claims — never from the incoming write.

**The wildcard that swallows its siblings.**

```rules
match /{doc=**} { allow read: if request.auth != null; }
match /medical/{id} { allow read: if request.auth.uid == resource.data.patientId; }
```

Any matching allow grants access, so the scoped medical rule is decoration — the wildcard already granted the read. Simulated as a signed-in stranger reading `medical/x1`: allowed. The audit states every wildcard's reach explicitly.

**RTDB: the cascade you forgot.**

```json
{ "rules": { ".read": true, "billing": { ".read": "auth != null" } } }
```

RTDB access cascades downward and a child cannot revoke a parent's grant — `billing` is public. Simulated anonymous read of `billing/acct1`: allowed. Every path is simulated four ways before shipping: intended actor allowed, anonymous denied, cross-user denied, invalid shape denied.

**`.validate` that rescues nothing.**

`.validate` runs only after `.write` allows — it never narrows a `.write` that is too broad. An open path needs both an access rule and a shape rule, and the simulation shows the malformed write landing when the shape rule is missing.

## Rules are not filters

A query is not a single read. When your app runs a `list` query, Firestore must prove from the query's filters alone that every possible result is readable, and it never quietly filters out the documents a rule would deny. So a rule can be exactly right for one `get` and still reject the `list` query that returns the same documents.

Passing for one document is not the same as being provable for every possible result of a query. The fix is to carry the rule's condition into the query as a filter.

Take an owner-scoped collection where the rule allows a list only to the owner:

```rules
match /notes/{noteId} {
  allow list: if isOwner(resource.data.ownerUid);
}
```

A query that carries the matching equality filter is provable, and the same shape works for a one-shot read or a live listener:

```ts
const mine = query(collection(db, 'notes'), where('ownerUid', '==', uid));
const page = await getDocs(mine);        // allowed
const stop = onSnapshot(mine, render);   // same proof, same result
```

Drop the filter and Firestore can no longer show every note belongs to the caller, so it denies the whole query:

```ts
const all = query(collection(db, 'notes'));
await getDocs(all);
// deny: unprovable query — rules are not filters
```

The sandbox enforces the same proof production does, so a query that lists in development lists in production.

## Audit the whole project, not just the rules

Rules can be individually correct and collectively wrong. The project audit crosses three sources — deployed rules, the actual data shape (found by crawling the sandbox), and enabled auth providers — and the disagreements are the findings: data no rule protects, rules matching paths with no data, user-writable paths with no validation, rules gating on an identity no enabled provider can produce.

The report is severity-ranked, critical first, each finding citing the simulation that proves it. It stays read-only; fixes are proposed, applied only when you ask.

## Run it through an agent

An MCP-connected agent runs the same audits with the same evidence contract. Start from the prompts in [Work with an agent](../agent/work-with-an-agent.md).
