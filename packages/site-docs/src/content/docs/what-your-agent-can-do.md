---
title: "Work with the sandbox through an agent"
navLabel: "Work through an agent"
group: "Inspect and correct"
section: "Work with an agent"
order: 3012
description: "Every backend capability, callable as a tool: inspect, query, simulate, shape, ship, verify."
---

# Work with the sandbox through an agent

Once connected, your agent works on the backend the way you do, except every capability is a tool call it can make and check. This page walks the surface by what the agent can accomplish, not by tool name. The names appear where they matter.

| The agent can | Through |
|---|---|
| Read, write, and query as any user | the Firestore and RTDB data tools |
| See what exists before guessing | `sandbox_inspect` and the discovery crawls |
| Prove a rule before writing it | `firestore_simulate_rules` and simulator sessions |
| Shape the state it tests against | seed, reset, and snapshot |
| Operate the real project | the deploy and auth-config tools, with credentials you provide |
| Check its own work | session replay against candidate rules |

## Read, write, and query with application identity

The data plane is the app's own surface, and the agent uses it as a specific identity, so a read that should be denied is denied for the agent too.

- **Firestore**: create, read, update, and delete documents, and run queries with filters and ordering.
- **Realtime Database**: get, set, update, and push.
- **RTDB inspection**: crawls the active sandbox snapshot and reports its local structure without production access.

## Inspect state before changing it

The single most-used move is one call. `sandbox_inspect` returns:

- the current rules with a lint summary
- a document census by collection
- the recent denials and requests from the event log

The tool's own source records why it exists. In a recorded debug session, diagnosing "why aren't my rules working" took fifty-one tool calls and seventy-two thousand tokens of grepping through packages. The same diagnosis is now one round-trip, and it is the first thing a well-set-up agent does.

Discovery works on real projects too. Firestore has no schema, so Pyric infers one: the agent can crawl a live database by sampling, cost-bounded and cost-reported, and come back with the shape of what is actually there. The same goes for a Realtime Database tree.

## Simulate a rule before writing it

The agent can ask whether a specific request, by a specific identity, would be allowed under a ruleset, and get the verdict with the rule and data that decided it. No deploy, no waiting.

For longer work it can open a stateful simulator session:

- seed documents and execute writes
- run batches and transactions
- read the event log
- undo or redo any step

A scratchpad for rules and data with a real undo stack, which means the agent can try something wrong and back out cleanly.

## Shape the state under test

Backend state is a tool input. The agent can seed a scenario, reset to clean, and snapshot what it built so the state survives as a fixture. Between test runs, between hypotheses, between conversations.

The same seed, reset, and snapshot moves you make yourself, callable.

## Understand the credential boundary

Given credentials you choose to hand it, the agent can run the control plane over REST, with no extra CLI:

- deploy rules, indexes, hosting, and functions
- enable auth providers and manage authorized domains
- provision databases and storage

This is the same path you walk in [set up the project](../set-up-the-project/) and [ship to production](../ship-to-production/). Without those credentials, none of it is reachable.

## Check the result

Verification is a tool, not a ritual. The agent can replay a captured session of real operations against a candidate ruleset and learn which operations change verdict, before anything deploys.

It writes a rule, replays, reads the diff, and fixes what flipped. That loop is the difference between an agent that asserts its rules work and one that has evidence.

## Understand the supported boundary

The surface is wide because Firebase's is: data, rules, identity, deployment, and two database models.

The exact tool count drifts as consolidation continues, and consolidation is ongoing on purpose. Fewer, stronger calls beat a long menu. What holds steady is the capability list above.

## Where to go next

The tools carry the moves. The procedures for the hard problems live in [skills](../skills/). And everything the agent does lands in a stream you can read, in [watch and review](../watch-and-review/).
