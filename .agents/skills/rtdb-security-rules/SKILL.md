---
name: rtdb-security-rules
description: Author or audit Realtime Database security rules — cascading read/write access, .validate shape checks, auth expressions, data vs newData semantics. Use when the user works on database.rules.json, asks why an RTDB read/write is allowed or denied, or needs RTDB paths locked down.
---

# RTDB Security Rules

RTDB rules are JSON-embedded expressions where access cascades downward: a
permissive parent grants every descendant, and a restrictive child cannot
revoke it. Lock the root, then open the smallest useful paths.

## Rule types

- `.read` / `.write` — WHO may act at this path (and everything below it).
- `.validate` — WHAT the written data may look like, evaluated only after
  `.write` allows; validations do not cascade.
- `data` — pre-write state (the actor's existing context);
  `newData` — post-write state. In multi-field writes each `.validate` sees
  the full merged `newData`.

## Steps

1. **Read current rules.** The Realtime Database rules in effect are the
   `database.rules.json` file the sandbox loaded from the project (the path
   comes from `firebase.json` or `pyric.json`) — read that file directly.
   Complete when you can state the effective access at every path a client
   touches (walk each cascade from root).

2. **Identify paths and identities.** List each path clients read or write
   and the identity that should reach it (anonymous, any signed-in user,
   owner via `auth.uid`, role via claim). Complete when each path has an
   intended identity × operation table.

3. **Design access and validation together.** Start from
   `{ "rules": { ".read": false, ".write": false } }` and open exact paths.
   Guard identity with `auth !== null` before `auth.uid` comparisons. Add a
   `.validate` for every user-controlled write: type checks
   (`newData.isString()`, `.isNumber()`), bounds, required children
   (`newData.hasChildren([...])`), and transition checks comparing `data` to
   `newData`. For common patterns, author the rules as a constraints module
   (`defineRtdbRules` from `pyric/rules`) and compile it with
   `database_rules.generate`; check any rules document with
   `database_rules.lint` and `database_rules.validate`. Complete when every
   open path has both an access rule and a shape rule.

4. **Simulate before shipping.** Run `database_rules.simulate` for each path
   with four case families: the intended actor allowed, anonymous denied,
   cross-user denied, invalid shape denied. Complete when all four families
   pass per path.

5. **Deploy.** Write the full `database.rules.json` — a deploy replaces the
   entire ruleset — and deploy it with the Firebase CLI, a step outside the
   sandbox. For writes that must prove their shape at runtime,
   `database_data.validated_write` applies a write only if the current rules
   allow it. Complete when `database.rules.json` matches what you deployed
   and `database_rules.validate` and `database_rules.lint` pass against it.

## Reference — pitfalls

- A `.read: true` near the root silently exposes every descendant; recheck
  cascades after any parent edit.
- `.validate` never runs when `.write` denies — and never rescues a `.write`
  that is too broad.
- `data` at a path being created is empty; existence checks belong on
  `data.exists()`.
- Deleting a node is a write of `null`: `newData.exists()` in `.validate`
  blocks deletion — decide intentionally.
