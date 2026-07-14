---
title: "pyric CLI reference"
group: "pyric-tools"
section: "Reference"
order: 9009
---
# `pyric` CLI reference

The complete command + flag surface of the `pyric` binary. This is the
authoritative source for flags, defaults, and exit codes: guides and tutorials
link here rather than restating them.

Run `pyric --help` for the same surface inline, or `pyric --version`.

## Conventions

- `<required>` arguments; `[optional]` arguments and flags.
- Flags accept `--flag value` or `--flag=value`.
- Unless noted, commands exit **0** on success, **1** on a usage or runtime
  error. Specific non-standard exit codes are called out per command.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `PYRIC_PORT` | `bridge` | Bridge port (default 5174). |
| `PYRIC_PROJECT` | `bridge`, `verify --engine rules-test-api` | Project id label (falls back to the `.firebaserc` default). |
| `PYRIC_VERBOSE` | all | Verbose logging when set. |
| `FIREBASE_SA_BASE64` | `verify --engine rules-test-api\|both` | base64-encoded service-account JSON for the hosted Rules Test API. |
| `GOOGLE_APPLICATION_CREDENTIALS` | `verify --engine rules-test-api\|both` | Filesystem path to service-account JSON for the hosted Rules Test API. |

Local sandbox commands (`dev`, `init`, `snapshot`, `bridge`, `verify` with the
default `sandbox` engine, `rules:*`, `database:rules:*`, `storage:rules:*`) need
no credentials. Hosted Rules Test API verification (`--engine rules-test-api` or
`both`) needs a project id plus `FIREBASE_SA_BASE64` or
`GOOGLE_APPLICATION_CREDENTIALS` (or ADC). See
`@pyric/cli/credentials/node`.

---

## Local development

<a id="pyric-dev"></a>
### `pyric dev [flags]`

Serve the app locally with the pyric sandbox standing in for Firebase. Unmodified
`firebase/*` imports resolve, via a served import map, to a sandbox running in a
**SharedWorker by default** (one authoritative backend shared across all tabs;
durable in the browser's IndexedDB; service adapters use the per-tab in-page
sandbox only when SharedWorker is unavailable). The current bundle still
constructs that inactive fallback primitive eagerly; it is not a second routed
backend. `firestore.rules` is installed and hot-reloaded over SSE.

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `3473` | Port to serve on ("FIRE" on a phone keypad); scans forward when taken. |
| `--host <h>` | `localhost` | Host to bind. |
| `--persist` | off | Persist sandbox state (docs + auth users) to a committable `.pyric/state/state.json`. Once a state file exists it wins; `--seed` then applies only into an empty sandbox. (On the SharedWorker path data is already durable in IndexedDB; this adds the on-disk, shareable copy.) |
| `--fresh` | off | Requires `--persist`: errors otherwise (there's no state file to discard). Discards the existing state file and re-seeds from scratch. Does **not** clear the browser's IndexedDB, so a browser tab with existing sandbox data keeps it and writes it right back into the new file; also clear site data (or use a private window) for a full reset. |
| `--seed <file>` | none | Load a `"collection/doc" → fields` JSON map admin-style before app code runs. Also accepts a `pyric snapshot` state file (detected by its `version` key), seeds docs + auth users. Applies only into an empty sandbox: if it already holds restored/lived data (a state file, or IndexedDB from an earlier session even without `--persist`), the seed is skipped and a console line explains why. |
| `--no-capture` | capture on | Disable the session capture. By default pyric dev writes `.pyric/last-session.json` for `pyric verify` to replay. Captures use `pyric.verify.fixture.v1`, with one event timeline and per-service Firestore/RTDB rules + state blocks. |
| `--no-watch` | watch on | Disable `firestore.rules` hot-reload. |
| `--no-open` | auto-open on | Don't auto-open the browser. (Auto-open is already suppressed under `--json`, no TTY, and CI.) |
| `--no-cache` | cache on | Rebuild the served SDK + worker bundles instead of using `~/.pyric/serve-cache`. |
| `--bridge` | off | Also mount the MCP bridge on the dev-server origin (`/__pyric/mcp`). `--project` labels health/audit. |
| `--allowed-host <h,…>` | none | Extra `Host` headers to accept past the DNS-rebinding guard (`localhost`/`127.0.0.1` always allowed). |
| `--only hosting` | none | Accepted for firebase-serve parity (hosting is all v1 serves). |
| `--json` | off | One machine line on stdout (`{url, port, mcpUrl, rulesHash, persist, restoredDocs, restoredUsers}`); banner → stderr. Readiness probe: `GET <url>/__pyric/init.json` → 200. |

Persistence, multi-tab, and SharedWorker behaviour are covered in
[persistence and multi-tab](../pyric-tools-how-to-serve-persistence-and-multi-tab/).

### `pyric init [dir] [flags]`

Scaffold a pyric project. Never prompts; rerunning is safe (idempotent).

| Flag | Default | Description |
|---|---|---|
| `--template <web\|node>` | `web` | `web`: a servable app with canonical `firebase/*` imports, owner-based rules, `seed.json`, `dev`/`dev:agent` scripts. `node`: script-style scaffold (`PYRIC_TARGET=sandbox\|firebase`). |
| `--name <name>` | dir name | Project name. |
| `--force` | off | Overwrite scaffold-owned files. |
| `--json` | off | Machine result on stdout: `{template, dir, created, merged, skipped, conflicts, nextSteps}`. |

<a id="pyric-snapshot"></a>
### `pyric snapshot [flags]`

Promote lived sandbox state (a live `dev --persist`, else
`.pyric/state/state.json`) to a committable fixture that `pyric dev --seed <file>`
re-serves (docs + auth users).

| Flag | Default | Description |
|---|---|---|
| `--out <file>` | none | Output path for the fixture. |
| `--port <n>` | none | Port of the live `pyric dev` to read from. |
| `--force` | off | Overwrite an existing output file. |
| `--include-passwords` | redacted | Keep auth-user passwords in the fixture (default: redacted). Trusted/local fixtures only. |
| `--json` | off | Machine output on stdout. |

See [promote sandbox state to a fixture](../pyric-tools-how-to-promote-sandbox-state-to-a-fixture/).

<a id="pyric-verify"></a>
### `pyric verify [fixture|dir] [flags]`

Replay a captured sandbox session against candidate rules. Captures can contain
Firestore and Realtime Database services; `verify` checks the verifiable
services present in the fixture unless `--service` filters them. With no
positional argument it replays the latest `pyric dev` capture at
`.pyric/last-session.json`.

| Flag | Default | Description |
|---|---|---|
| `--service <firestore\|rtdb>` | all services in fixture | Verify one service. Repeat to verify several selected services. `database` is accepted as an alias for `rtdb`. |
| `--engine <sandbox\|rules-test-api\|both>` | `sandbox` | Choose the verification engine. `rules-test-api` and `both` require `--project` (or `.firebaserc`) plus service-account / ADC credentials. Rules Test API verification is Firestore-only. |
| `--rules <service=path>` | from `firebase.json` | Candidate rules to verify against. Repeat for mixed-service captures. Firestore rules are source files; RTDB rules are JSON files. |
| `--json` | off | Machine output on stdout. |

Default candidate rules come from `firebase.json.firestore.rules` and
`firebase.json.database.rules`. Captured rules are informational and are not
used as the candidate ruleset.

**Exit code:** `1` on any failing divergence, `0` otherwise. Missing fixture or
missing candidate rules exits `2`. Firestore auto-id aliases, time drift, and
sentinel drift are informational and do not fail.

Examples:
```sh
pyric verify
pyric verify journeys/ --rules firestore=firestore.rules
pyric verify journeys/checkout.json --engine rules-test-api --project demo-app
pyric verify journeys/checkout.json --engine both --project demo-app
pyric verify --service rtdb --rules rtdb=database.rules.json
pyric verify --rules firestore=firestore.rules --rules rtdb=database.rules.json
```
See [verify against a captured session](../pyric-tools-how-to-verify-against-a-captured-session/).

### `pyric verify cases [fixture] [flags]`

Derive Firestore Rules Test API cases from a captured fixture without running
verification.

| Flag | Default | Description |
|---|---|---|
| `--service firestore` | `firestore` | The service to derive cases for. Only Firestore is supported. |
| `--out <path>` | stdout | Write the derived case JSON to a file. |
```sh
pyric verify cases journeys/checkout.json --service firestore --out journeys/checkout.cases.json
```
### `pyric mcp-proxy`

Stdio MCP server that relays to a running `pyric dev --bridge`, discovering the
port via `.pyric/serve.json` (then a port scan). Used by the Claude Code plugin;
not run by hand. See [wire Claude Code](../pyric-tools-tutorials-wire-claude-code/).

### `pyric bridge [flags]`

Stand up the HTTP+WebSocket bridge external MCP clients connect to. It relays
tool calls to a connected in-browser sandbox. See [bridge](../pyric-tools-bridge/).

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `5174` | Port to bind on `127.0.0.1`. Env: `PYRIC_PORT`. |
| `--project <id>` | none | Project id surfaced in `/health` + audit log. Env: `PYRIC_PROJECT`. |

---

## Rules

These wrap the rules toolchain documented in
[`pyric/docs/rules/`](../pyric-rules/).

### `pyric rules:lint <path>`

Run the Firestore rules linter against a file.

### `pyric rules:validate <path>`

Validate Firestore rules structure against a file.

### `pyric rules:simulate [--stdin]`

Local rules simulator.

| Flag | Description |
|---|---|
| `--stdin` | Read a scripted simulation from stdin instead of running the interactive smoke-test. |

### `pyric database:rules:lint <path>`

Run the Realtime Database rules JSON expression linter against a file.

### `pyric database:rules:validate <path>`

Validate Realtime Database rules JSON expressions against the local parser and
expression validator.

### `pyric database:rules:simulate [--stdin]`

Local Realtime Database rules simulator. With no flags, reads
`firebase.json.database.rules` and runs a sample anonymous read. With `--stdin`,
reads a JSON payload with `rulesJson` or `rulesPath`, `operation`, `path`,
optional `auth`, `mockData`, and `newData`.

### `pyric database:rules:generate [--config <path>] [--out <path>]`

Load a constraints module (default `database.rules.ts`), compile it to Firebase
RTDB rules JSON, and write the file. Does not contact a Firebase project.

### `pyric firestore:indexes:generate`

Derive composite-index definitions from query shapes (see
`firestore_extract_indexes`).

### `pyric storage:rules:lint <path>` / `pyric storage:rules:simulate`

Local Storage rules lint and simulation.
