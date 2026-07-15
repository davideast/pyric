---
title: "Teach your agent the hard Firebase things"
navLabel: "Skills"
group: "Inspect and correct"
section: "Work with an agent"
order: 3013
description: "Packaged expert procedures for the problems that need a method, not more tools."
---

# Teach your agent the hard Firebase things

Tools give an agent hands. Skills give it a method. A skill is a written procedure the agent follows step by step, with a completion check on every step and the specific Pyric moves each step uses named in place.

An auth-model skill does not say "think about identity." It says map every identity, check what providers are enabled with `auth_get_config`, connect every `request.auth.uid` in the rules to a real data shape, and do not stop until every access boundary has a named identity.

Six skills ship today, one per hard problem.

## Install them

The skills live in the Pyric repository under `.agents/skills/`, one folder per skill.

- Agents that read the `.agents/skills` convention pick them up in place.
- For Claude Code, copy the folders you want into your project's `.claude/skills/` directory.
- The Claude Code plugin ships its own operational pieces (`pyric-start` boots and wires the sandbox), so the domain skills below slot into a session that is already connected.

## What each skill does

**firebase-auth-model.** Design or audit an identity model that actually connects to your rules. It maps every identity your app has, chooses provider flows, decides where profile data lives and which document IDs use `uid`, and draws the line between custom claims and document roles so they never contradict, ending with test users you can seed. Serves [sign in and manage users](../sign-in-and-manage-users/).

**firestore-query-indexes.** Treat a query plan as an index proof. The skill inventories every read the product performs, proves each list query is constrained so rules can allow it, then extracts the composite indexes from your actual query code instead of hand-writing JSON. If the extractor returns nothing, the fix is the source, not the JSON. Serves [store and query data](../store-and-query-data/).

**firestore-rules-audit.** Answer who can do what, with evidence. It lints, builds an identity-by-operation access matrix with no blank cells, checks each expression against its operation context (a `list` cannot lean on one document's `resource.data`, a `create` has no `resource.data` at all), and flags the composition traps where a permissive wildcard quietly overrides a careful restriction. Serves [audit your rules](../audit-your-rules/).

**rtdb-security-rules.** Realtime Database rules cascade downward: a permissive parent grants every descendant and a child cannot take it back. The skill starts from a locked root, opens the smallest useful paths, pairs every open path with a validation, and walks each cascade so you can state the effective access at every path a client touches. Realtime Database support in Pyric is experimental. Serves [audit your rules](../audit-your-rules/).

**rtdb-data-model.** One JSON tree, where reading a path downloads everything below it, so structure is performance. The skill designs paths around the reads: flat entity collections, index tables for reverse lookups, denormalized summaries sized for list screens, and a fan-out write plan so every duplicated field updates atomically. Realtime Database support in Pyric is experimental. Serves [sync realtime data](../sync-realtime-data/).

**firebase-audit.** The whole-project posture check, read-only by design. It collects rules, real data shape, and auth configuration, then cross-references them: data paths with no meaningful rule, rules guarding paths where no data exists, writable paths without validation, and rule assumptions no enabled provider can satisfy. The output is a severity-ranked report with evidence for every finding. Serves [audit your rules](../audit-your-rules/).

## Where to go next

A skill is only as good as the tools it drives, so read [what your agent can do](../what-your-agent-can-do/) if you have not. Then run one and watch it work in [watch and review](../watch-and-review/).
