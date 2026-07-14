---
title: "@pyric/cli"
navLabel: "Overview"
group: "@pyric/cli"
section: ""
order: 9001
---
# `@pyric/cli` documentation

The `pyric` CLI and programmatic helpers for local sandbox development,
verification, artifact generation, and agent bridges — organised by the four
[Diátaxis](https://diataxis.fr) quadrants: learn, do, look up, understand.

Production project administration (deploy, Identity Toolkit configuration,
hosted discovery) is **not** part of this package. Use `firebase-tools` (or
your existing CI) to ship rules, indexes, hosting, and functions to a real
Firebase project.

## Tutorials: learning by doing

- [Getting started](../start-building/): scaffold → dev → plugin →
  agent, end to end.
- [Wire Claude Code (manual MCP)](../pyric-cli-tutorials-wire-claude-code/): bridges,
  custom ports, other MCP clients.

## How-to guides: accomplishing a task

- [Persistence and multi-tab with `pyric dev`](../pyric-cli-how-to-serve-persistence-and-multi-tab/)
- [Verify your rules against a captured session](../pyric-cli-how-to-verify-against-a-captured-session/)
- [Promote sandbox state to a committable fixture](../pyric-cli-how-to-promote-sandbox-state-to-a-fixture/)
- [Use the Vite plugin](../pyric-cli-how-to-use-the-vite-plugin/)
- [Run an RTDB `onValueCreated` function locally](../pyric-cli-how-to-run-rtdb-onvaluecreated/)
- [Build a standalone `pyric` binary](../pyric-cli-how-to-build-a-standalone-binary/): a
  single self-contained executable via `bun build --compile`.

## Reference: facts while working

- **[CLI reference](../pyric-cli-reference-cli/)**: every `pyric` command, every flag,
  exit codes, environment variables. The authoritative source.
- [Verify API](../pyric-cli-reference-verify/): programmatic captured-session replay for
  Firestore and RTDB rules.
- [Package exports and resolution](../pyric-cli-reference-package-and-resolution/):
  public subpaths and the activated-development/inactive-production seam.
- [Bridge](../pyric-cli-bridge/): `@pyric/cli/bridge` (server + client).

## Explanation: understanding why

- [A local backend, not Firestore offline persistence](../pyric-sandbox-explanation-local-backend-vs-firestore-offline/):
  why pyric dev's multi-tab and persistence avoid the distributed-systems complexity.
