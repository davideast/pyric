---
title: Agent skills for Firebase tasks
navLabel: Skills
outcome: Six packaged procedures for the problems that need a method, each with the prompt that runs it.
status: draft
---

# Agent skills for Firebase tasks

A skill is a written procedure your agent follows step by step, with a completion check on every step and the specific Pyric tool calls named in place. An auth-model skill does not say "think about identity." It says map every identity, check what providers are enabled with `auth_get_config`, connect every `request.auth.uid` in the rules to a real data shape, and do not stop until every access boundary has a named identity.

Type a prompt like the ones below and the agent runs the whole procedure, not one tool call. Six skills ship today, one per hard problem.

## Install a skill into an agent

The skills live under `.agents/skills/` in the Pyric repository, one folder per skill. Agents that read the `.agents/skills` convention pick them up in place. For Claude Code, copy the folder you want:

```bash
cp -r .agents/skills/firestore-rules-audit .claude/skills/
```

The Claude Code plugin's `pyric-start` skill boots and wires the sandbox connection, so a copied skill below slots into a session that already has tools to call.

## firebase-auth-model

Design or audit an identity model, then connect it to your rules: providers, UIDs, custom claims versus document roles, and the test users that exercise each branch.

```
Design an auth model for a photo-sharing app: anonymous browsing,
signed-in uploads, and an admin role that can remove any photo.
```

The skill names every identity (anonymous, owner, admin claim-holder), checks enabled providers with `auth_get_config`, and decides where profile data lives so `request.auth.uid` in the rules maps to a real document. It ends by seeding test users with `firestore_add_document` and verifying each identity's access with `firestore_simulate_rules`. Serves [sign in and manage users](../build/sign-in-and-manage-users.md).

## firestore-query-indexes

Turn a query plan into an index proof: inventory the reads, prove rules allow them, then extract the composite indexes from your actual query code.

```
I need a query for the 20 most recent orders for the signed-in user,
sorted by date. Set up the index for it.
```

The skill writes the query in modular SDK shape, runs `firestore_extract_indexes` against it, and deploys the result with `firestore_deploy_indexes`. A zero-shape extraction means the query code doesn't expose a pattern the extractor can see, so the skill fixes the source rather than hand-writing `firestore.indexes.json`. Serves [store and query data](../build/store-and-query-data.md).

## firestore-rules-audit

Answer who can do what, with evidence, not a reading of the source.

```
Audit the rules in firestore.rules and show me who can read
and write each collection.
```

The skill runs `firestore_lint_rules`, builds an identity-by-operation access matrix with no blank cells, and checks each expression against its operation context (a `create` has no `resource.data` yet; a `list` can't lean on one document's fields). Every critical or high finding is proven with `firestore_simulate_rules` before it makes the report. Serves [audit rules](../secure/audit-a-ruleset.md).

## rtdb-security-rules

Realtime Database rules cascade downward, so a permissive parent grants every descendant and a child cannot take it back. Realtime Database support in Pyric is experimental; [how we know it matches Firebase](../trust/how-we-know-it-matches-firebase.md) says what that costs you.

```
Lock down database.rules.json so only a post's author can edit
or delete it, and any signed-in user can read.
```

The skill starts from a locked root, opens only the paths the prompt names, and pairs each with a `.validate` shape check. Before anything ships, it simulates four case families per path with `rtdb_simulate_access` (intended actor, anonymous, cross-user, invalid shape) and deploys with `rtdb_deploy_rules`. Serves [audit rules](../secure/audit-a-ruleset.md).

## rtdb-data-model

One JSON tree, where reading a path downloads everything below it, so structure is performance. Realtime Database support in Pyric is experimental; [how we know it matches Firebase](../trust/how-we-know-it-matches-firebase.md) says what that costs you.

```
I have a chat app where each room shows its last 50 messages plus
a live list of who's typing. Model the tree for that.
```

The skill inventories the reads first, then designs flat top-level collections and denormalized summary nodes sized for those reads, with a multi-path `rtdb_update` fan-out for every duplicated field. It declares `.indexOn` for each ordered read and confirms the shape by seeding with `rtdb_set` and reading it back with `rtdb_get`. Serves [sync realtime data](../build/sync-realtime-data.md).

## firebase-audit

The whole-project posture check, read-only by design: rules, real data, and auth configuration, cross-referenced for where they disagree.

```
Audit the whole project, Firestore, RTDB, and Auth, and tell me
where the rules and the real data disagree.
```

The skill collects rules with `firestore_get_rules` and `rtdb_get_rules`, maps real data shape with `firestore_discover_paths` and `rtdb_crawl_structure`, and checks `auth_get_config` against every `request.auth` assumption the rules make. The output is a severity-ranked report, and remediation is proposed in it, never applied without asking. Serves [audit rules](../secure/audit-a-ruleset.md).

## Where to go next

A skill is only as good as the tools it drives, so read [the agent tool reference](./agent-mcp-tools.md) if you have not.
