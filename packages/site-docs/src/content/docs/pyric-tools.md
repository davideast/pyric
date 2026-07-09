---
title: "pyric-tools"
navLabel: "Overview"
group: "pyric-tools"
section: ""
order: 1
---
# pyric-tools documentation

The `pyric` CLI + programmatic helpers (deploy, bridge, discover, auth-config),
organised by the four [Diátaxis](https://diataxis.fr) quadrants: learn, do,
look up, understand.

## Tutorials — learning by doing

- [Getting started](../pyric-tools-tutorials-getting-started/) — scaffold → dev → plugin →
  agent, end to end.
- [Wire Claude Code (manual MCP)](../pyric-tools-tutorials-wire-claude-code/) — bridges,
  custom ports, other MCP clients.
- [Deploy a Cloud Function](../pyric-tools-deploy-tutorials-01-deploy-a-cloud-function/).

## How-to guides — accomplishing a task

Local development:

- [Persistence and multi-tab with `pyric dev`](../pyric-tools-how-to-serve-persistence-and-multi-tab/)
- [Verify your rules against a captured session](../pyric-tools-how-to-verify-against-a-captured-session/)
- [Promote sandbox state to a committable fixture](../pyric-tools-how-to-promote-sandbox-state-to-a-fixture/)
- [Build a standalone `pyric` binary](../pyric-tools-how-to-build-a-standalone-binary/) — a
  single self-contained executable via `bun build --compile`.

Real Firebase projects:

- [Infer a schema from an existing Firestore](../pyric-tools-how-to-discover-a-schema-from-firestore/)
- [Configure auth providers and authorised domains](../pyric-tools-how-to-configure-auth-providers-and-domains/)
- [Deploy rules / indexes / hosting / functions](../pyric-tools-deploy/) (+ preview
  channels, error handling — see the deploy how-to index).

## Reference — facts while working

- **[CLI reference](../pyric-tools-reference-cli/)** — every `pyric` command, every flag,
  exit codes, environment variables. The authoritative source.
- [Verify API](../pyric-tools-reference-verify/) — programmatic captured-session replay for
  Firestore and RTDB rules.
- [Deploy library + agent I/O](../pyric-tools-deploy/) — `pyric-tools/deploy` API,
  namespaces, error codes, [CLI agent I/O](../pyric-tools-deploy-reference-cli-agent-io/).
- [Bridge](../pyric-tools-bridge/) — `pyric-tools/bridge` (server + client).

## Explanation — understanding why

- [A local backend, not Firestore offline persistence](../pyric-sandbox-explanation-local-backend-vs-firestore-offline/)
  — why pyric dev's multi-tab + persistence avoid the distributed-systems complexity.
- [Why no Firebase CLI](../pyric-tools-deploy-explanation-why-no-firebase-cli/) and the other
  [deploy explanations](../pyric-tools-deploy/).
