---
title: "pyric CLI reference"
group: "pyric-tools"
section: "Reference"
order: 46
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
| `PYRIC_MODE` | `bridge` | `sandbox` (default) or `prod`. |
| `PYRIC_PORT` | `bridge` | Bridge port (default 5174). |
| `PYRIC_PROJECT` | `bridge`, `deploy`, `auth:*`, `firestore:discover` | Project id (falls back to the `.firebaserc` default). |
| `PYRIC_VERBOSE` | all | Verbose logging when set. |
| `FIREBASE_SA_BASE64` | `deploy`, `auth:*`, `firestore:discover` | base64-encoded service-account JSON. |
| `GOOGLE_APPLICATION_CREDENTIALS` | `deploy`, `auth:*`, `firestore:discover` | Filesystem path to service-account JSON. |
| `FIREBASE_DATABASE_URL` | `deploy database` | Realtime Database instance URL, used when `--database-url` and `firebase.json.database.url` are absent. |
| `PYRIC_SA_PATH` | `bridge --mode prod` | Service-account path for prod bridge mode. |

Commands that touch a **real Firebase project** (`deploy`, `auth:*`,
`firestore:discover`, `bridge --mode prod`) require credentials via
`FIREBASE_SA_BASE64` or `GOOGLE_APPLICATION_CREDENTIALS`, plus a project id via
`--project` / `PYRIC_PROJECT` / `.firebaserc`. The local sandbox commands
(`dev`, `init`, `snapshot`, `verify`, `rules:*`, `database:rules:*`) need none.

---

## Local development

<a id="pyric-dev"></a>
### `pyric dev [flags]`

Serve the app locally with the pyric sandbox standing in for Firebase. Unmodified
`firebase/*` imports resolve, via a served import map, to a sandbox running in a
**SharedWorker by default** (one backend shared across all tabs; durable in the
browser's IndexedDB; a per-tab in-page sandbox is the fallback when SharedWorker
is unavailable). `firestore.rules` is deployed and hot-reloaded over SSE.

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
| `--engine <sandbox\|rules-test-api\|both>` | `sandbox` | Choose the verification engine. `rules-test-api` and `both` require `--project` or another deploy-compatible credential source. Rules Test API verification is Firestore-only. |
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

Stand up the HTTP+WebSocket bridge external MCP clients connect to. In `sandbox`
mode it relays to a connected in-browser sandbox; in `prod` mode it operates on a
real Firebase project (guarded). See [bridge](../pyric-tools-bridge/).

| Flag | Default | Description |
|---|---|---|
| `--mode <sandbox\|prod>` | `sandbox` | `prod` requires credentials **and** interactive confirmation (or `--non-interactive`). |
| `--port <n>` | `5174` | Port to bind on `127.0.0.1`. Env: `PYRIC_PORT`. |
| `--project <id>` | none | Project id surfaced in `/health` + audit log. Required for `--mode prod`. Env: `PYRIC_PROJECT`. |
| `--auto-approve <list>` | none | Prod mode: comma-separated tool names that skip confirmation. |
| `--require-confirm <list>` | none | Prod mode: tool names forced to always prompt. |
| `--require-confirm-all` | off | Prod mode: force every tool (including reads) to prompt. |
| `--confirm-timeout <ms>` | `45000` | Prod mode: per-prompt timeout. |
| `--non-interactive` | off | Run prod mode without a TTY (CI). |

---

## Deploy

### `pyric deploy <rules|indexes|database|hosting|functions>`

Deploy to a real Firebase project. Each target has its own surface (selectors,
agent I/O via `--schema` / `--json`, preview channels for hosting). The full
deploy documentation lives in [`../deploy/`](../pyric-tools-deploy/), including the
[CLI agent I/O reference](../pyric-tools-deploy-reference-cli-agent-io/).

`pyric deploy database` reads `firebase.json.database.rules` as a Realtime
Database rules JSON file. The database URL is resolved in this order:
`--database-url`, `FIREBASE_DATABASE_URL`, `firebase.json.database.url`, then
single default instance discovery via the RTDB management API.

### `pyric hosting:channel:deploy <channelId> [--expires <ttl>]`

Mirror of `deploy hosting --channel <channelId>` (firebase-tools spelling):
identical behaviour. See [deploy to a preview channel](../pyric-tools-deploy-how-to-deploy-to-a-preview-channel/).

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

---

## Identity & discovery (real Firebase project)

These operate on a real project and need credentials (see
[Environment variables](#environment-variables)).

<a id="pyric-authconfigure-provider"></a>
### `pyric auth:configure-provider <provider> <true|false>`

Identity Toolkit: enable or disable an auth provider. `<provider>` is one of
`anonymous`, `email`, `phone`, `google`. `--project` selects the project.

See [configure auth providers and domains](../pyric-tools-how-to-configure-auth-providers-and-domains/).

<a id="pyric-authmanage-domains"></a>
### `pyric auth:manage-domains <add|remove|list> [domain]`

Identity Toolkit: manage the authorised-domain allowlist. `add`/`remove` take a
`<domain>`; `list` takes none. `--project` selects the project.

<a id="pyric-firestore-discover"></a>
### `pyric firestore:discover [collection]`

Crawl a real Firestore to infer its schema. An optional `[collection]` narrows
the crawl. `--project` selects the project.

See [infer a schema from an existing Firestore](../pyric-tools-how-to-discover-a-schema-from-firestore/).
