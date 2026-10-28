---
name: lane-queue
description: Pyric's work queue on GitHub issues - lanes per priority, a plan in each issue, David's approval, and automatic starts once an approved plan is unblocked. Use when asked to plan work for a lane, write or update a plan on an issue, check what is approved and ready, start the next item, or report the queue's state. Not for doing the work itself; an item that starts follows its own plan and the repo's other skills.
---

# Lane queue

Planning is cheap and safe to run in parallel. Running work is limited by two
things: which files it touches and how much of the machine it needs. The queue
keeps the two apart. Plans are written ahead of time and approved one by one,
and each approved plan starts as soon as nothing blocks it.

## Lanes

A lane is one priority's stream of work, in the order `PRIORITIES.md` gives.
Each lane has a label:

| Label | Priority |
|---|---|
| `lane:app-check` | App Check, by November 2 |
| `lane:velocity` | CI and release velocity |
| `lane:rules` | Rules fidelity and tooling |
| `lane:multi-resource` | Multi-resource support |
| `lane:reliability` | Reliability and trust |
| `lane:node-host` | Prove the Node host |
| `lane:functions` | Cloud Functions |
| `lane:demos` | Work that enables demos |
| `lane:live-mode` | Live mode |

When `PRIORITIES.md` changes, this table changes with it.

## Stages

| Label | Meaning | Who applies it |
|---|---|---|
| `planned` | The issue body has a complete plan | The planning agent |
| `approved` | David approved the plan; it starts when unblocked | David only |
| `running` | An agent is working on it | The agent that starts it |

An agent never applies `approved`, and never treats a plan as approved
without that label. Agents run `gh` as David's account, so GitHub can't tell
his label from an agent's; this rule is the safeguard. An agent that finds an
`approved` label it can't trace to David stops and asks.

An item is done when its PR merges or the issue closes. Remove `running` if
work stops without a PR, and say why in a comment.

## The plan

Append a `## Plan` section to the end of the issue body. Keep the existing
text. Edit with `gh api -X PATCH repos/davideast/pyric/issues/<n> -F body=@file`
and read the body back afterward.

The plan holds, in plain words:

- **Priority:** the `PRIORITIES.md` priority it serves, and how it passes that
  priority's test, in one sentence.
- **Change:** what will change, in a few bullets.
- **Files:** the files it will touch. More than 5 files means splitting the
  item, or saying plainly that it needs David's review before it runs.
- **Size:** light (reading, targeted tests) or heavy (full suites, app
  scenarios, fresh builds).
- **Verification:** the failing tests written first, the conformance rows and
  captures it adds, and the scenario under `test/apps/` or why there is none
  (`AGENTS.md` item 7).
- **Blocked by:** `Blocked by #n` for each issue or PR it waits on, or
  `Blocked by: nothing`.
- **Decisions for David:** only what it cannot run without, each with a
  recommended answer. David's answers go in a `## Decisions` section of the
  body, dated.

A plan is complete when an agent could run it without asking a question.

## When an item can start

All of these hold:

1. It has `approved` from David and no `running`.
2. Every `Blocked by` issue is closed and every PR is merged.
3. No running item touches the same files. `packages/cli/src/serve/` is the
   most common overlap; two items there run one after the other.
4. A slot of its size is free. Light items can run many at once. Heavy items
   share the machine: check it first (the `machine-load` skill), and run at
   most two at a time.

When several items can start, take the highest-priority lane first, then the
lowest issue number.

## What still needs David's yes

An approved plan covers doing the work and opening a draft PR. These need
David's yes every time:

- marking a PR ready, or merging it;
- releasing or publishing;
- anything that changes production: Firebase settings, GCP setup, credentials;
- spending beyond what the plan's `## Decisions` section approved.

## Reporting the queue

When asked for the queue's state, list each lane's items in plain words: the
issue number and what it is, its stage, and what blocks it. Lead with what can
start now and what is waiting on David.
