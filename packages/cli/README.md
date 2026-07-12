# @pyric/cli

Local development, rules verification, and agent tooling for Pyric. The package
installs the short `pyric` command.

Production deployment belongs to the Firebase CLI:

```bash
firebase deploy --only firestore:rules,firestore:indexes,database,hosting
```

## Commands

```text
pyric init [dir]
pyric dev [flags] [-- <command>]
pyric bridge [--port N] [--project ID]
pyric mcp
pyric snapshot [--out FILE]
pyric verify [fixture|dir] [--service firestore|database]
pyric verify cases [fixture] [--service firestore] [--out FILE]
pyric vendor [dir]

pyric firestore rules lint <path>
pyric firestore rules validate <path>
pyric firestore rules simulate [--stdin]
pyric firestore rules resolve <path> [--out <path>]
pyric firestore indexes generate <path...> [--out <path>]

pyric database rules lint <path>
pyric database rules validate <path>
pyric database rules simulate [--stdin]
pyric database rules generate [--config <path>] [--out <path>]
```

`pyric verify` replays every supported service in a captured session by
default. Repeat `--service` to narrow it. The hosted Rules Test API engine is
Firestore-only and resolves credentials from an existing `firebase login`,
`FIREBASE_SA_BASE64`, `GOOGLE_APPLICATION_CREDENTIALS`, or Application Default
Credentials. Pyric does not run or own an OAuth login flow.

## Programmatic subpaths

- `@pyric/cli/verify` — captured-session replay and Rules Test API case
  derivation.
- `@pyric/cli/assurance` and `@pyric/cli/assurance/browser` — local assurance
  campaigns and visualization data.
- `@pyric/cli/bridge` and `@pyric/cli/bridge/client` — the sandbox-only MCP
  bridge.
- `@pyric/cli/vite` — the Pyric sandbox Vite plugin.
- `@pyric/cli/serve/worker` — the shared sandbox worker runtime used by Pyric
  Studio and Playground.
- `@pyric/cli/remote` and `@pyric/cli/register` — Node sandbox adoption for
  unchanged Firebase imports.

The sandbox bridge and Vite integration never administer a production Firebase
project.
