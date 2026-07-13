---
title: "@pyric/cli"
navLabel: "Overview"
group: "pyric-tools"
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
- [Wire Claude Code (manual MCP)](../pyric-tools-tutorials-wire-claude-code/): bridges,
  custom ports, other MCP clients.

## How-to guides: accomplishing a task

- [Persistence and multi-tab with `pyric dev`](../pyric-tools-how-to-serve-persistence-and-multi-tab/)
- [Verify your rules against a captured session](../pyric-tools-how-to-verify-against-a-captured-session/)
- [Promote sandbox state to a committable fixture](../pyric-tools-how-to-promote-sandbox-state-to-a-fixture/)
- [Use the Vite plugin](../pyric-tools-how-to-use-the-vite-plugin/)
- [Build a standalone `pyric` binary](../pyric-tools-how-to-build-a-standalone-binary/): a
  single self-contained executable via `bun build --compile`.

## Reference: facts while working

- **[CLI reference](../pyric-tools-reference-cli/)**: every `pyric` command, every flag,
  exit codes, environment variables. The authoritative source.
- [Verify API](../pyric-tools-reference-verify/): programmatic captured-session replay for
  Firestore and RTDB rules.
- [Bridge](../pyric-tools-bridge/): `@pyric/cli/bridge` (server + client).

## Explanation: understanding why

- [A local backend, not Firestore offline persistence](../pyric-sandbox-explanation-local-backend-vs-firestore-offline/):
  why pyric dev's multi-tab and persistence avoid the distributed-systems complexity.
