# pyric-tools documentation

The `pyric` CLI + programmatic helpers (deploy, bridge, discover, auth-config),
organised by the four [Diátaxis](https://diataxis.fr) quadrants: learn, do,
look up, understand.

## Tutorials — learning by doing

- [Getting started](tutorials/getting-started.md) — scaffold → dev → plugin →
  agent, end to end.
- [Wire Claude Code (manual MCP)](tutorials/wire-claude-code.md) — bridges,
  custom ports, other MCP clients.
- [Deploy a Cloud Function](deploy/tutorials/01-deploy-a-cloud-function.md).

## How-to guides — accomplishing a task

Local development:

- [Persistence and multi-tab with `pyric dev`](how-to/serve-persistence-and-multi-tab.md)
- [Verify your rules against a captured session](how-to/verify-against-a-captured-session.md)
- [Promote sandbox state to a committable fixture](how-to/promote-sandbox-state-to-a-fixture.md)
- [Build a standalone `pyric` binary](how-to/build-a-standalone-binary.md) — a
  single self-contained executable via `bun build --compile`.

Real Firebase projects:

- [Infer a schema from an existing Firestore](how-to/discover-a-schema-from-firestore.md)
- [Configure auth providers and authorised domains](how-to/configure-auth-providers-and-domains.md)
- [Deploy rules / indexes / hosting / functions](deploy/README.md) (+ preview
  channels, error handling — see the deploy how-to index).

## Reference — facts while working

- **[CLI reference](reference/cli.md)** — every `pyric` command, every flag,
  exit codes, environment variables. The authoritative source.
- [Verify API](reference/verify.md) — programmatic captured-session replay for
  Firestore and RTDB rules.
- [Deploy library + agent I/O](deploy/README.md) — `pyric-tools/deploy` API,
  namespaces, error codes, [CLI agent I/O](deploy/reference/cli-agent-io.md).
- [Bridge](bridge/README.md) — `pyric-tools/bridge` (server + client).

## Explanation — understanding why

- [A local backend, not Firestore offline persistence](../../pyric/docs/sandbox/explanation/local-backend-vs-firestore-offline.md)
  — why pyric dev's multi-tab + persistence avoid the distributed-systems complexity.
- [Why no Firebase CLI](deploy/explanation/why-no-firebase-cli.md) and the other
  [deploy explanations](deploy/README.md).
