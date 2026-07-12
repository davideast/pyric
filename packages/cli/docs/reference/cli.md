# CLI reference

Run `pyric --help` for the command inventory and `pyric --version` for package
and Firebase conformance versions.

## Local runtime

- `pyric init [dir]`
- `pyric dev [flags] [-- <command>]`
- `pyric bridge [--port N] [--project ID]`
- `pyric mcp`
- `pyric snapshot [--out FILE]`
- `pyric vendor [dir]`

The bridge is sandbox-only.

## Verification

```text
pyric verify [fixture|dir] [--service firestore|database]
pyric verify cases [fixture] [--service firestore] [--out FILE]
```

`verify` selects every supported service in the capture unless one or more
`--service` flags narrow it. `--engine rules-test-api` and `--engine both` are
Firestore-only. Hosted verification accepts `--project` and resolves tokens
from an existing `firebase login`, `FIREBASE_SA_BASE64`,
`GOOGLE_APPLICATION_CREDENTIALS`, or Application Default Credentials. Pyric
does not run an OAuth login flow.

## Firestore

```text
pyric firestore rules lint <path>
pyric firestore rules validate <path>
pyric firestore rules simulate [--stdin]
pyric firestore rules resolve <path> [--out <path>]
pyric firestore indexes generate <path...> [--out <path>]
```

`rules resolve` converts `rules_version = '2+modules'` source into deployable
version 2 rules. `indexes generate` statically extracts composite indexes from
the supplied JavaScript or TypeScript source files and writes
`firestore.indexes.json` by default.

## Realtime Database

```text
pyric database rules lint <path>
pyric database rules validate <path>
pyric database rules simulate [--stdin]
pyric database rules generate [--config <path>] [--out <path>]
```

`rules generate` compiles a Pyric RTDB constraints module into
`database.rules.json` by default.

## Production deployment

Use the Firebase CLI for production artifacts, for example:

```bash
firebase deploy --only firestore:rules,firestore:indexes,database,hosting
```
