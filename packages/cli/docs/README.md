# `@pyric/cli` documentation

The `pyric` CLI and programmatic helpers for local sandbox development,
verification, artifact generation, and agent bridges — organised by the four
[Diátaxis](https://diataxis.fr) quadrants: learn, do, look up, understand.

Production project administration (deploy, Identity Toolkit configuration,
hosted discovery) is **not** part of this package. Use `firebase-tools` (or
your existing CI) to ship rules, indexes, hosting, and functions to a real
Firebase project.

## Tutorials: learning by doing

- [Getting started](tutorials/getting-started.md): scaffold → dev → plugin →
  agent, end to end.
- [Wire Claude Code (manual MCP)](tutorials/wire-claude-code.md): bridges,
  custom ports, other MCP clients.

## How-to guides: accomplishing a task

- [Persistence and multi-tab with `pyric dev`](how-to/serve-persistence-and-multi-tab.md)
- [Verify your rules against a captured session](how-to/verify-against-a-captured-session.md)
- [Promote sandbox state to a committable fixture](how-to/promote-sandbox-state-to-a-fixture.md)
- [Use the Vite plugin](how-to/use-the-vite-plugin.md)
- [Build a standalone `pyric` binary](how-to/build-a-standalone-binary.md): a
  single self-contained executable via `bun build --compile`.

## Reference: facts while working

- **[CLI reference](reference/cli.md)**: every `pyric` command, every flag,
  exit codes, environment variables. The authoritative source.
- [Verify API](reference/verify.md): programmatic captured-session replay for
  Firestore and RTDB rules.
- [Package exports and resolution](reference/package-and-resolution.md):
  public subpaths and the activated-development/inactive-production seam.
- [Bridge](bridge/README.md): `@pyric/cli/bridge` (server + client).

## Explanation: understanding why

- [A local backend, not Firestore offline persistence](../../pyric/docs/sandbox/explanation/local-backend-vs-firestore-offline.md):
  why pyric dev's multi-tab and persistence avoid the distributed-systems complexity.
