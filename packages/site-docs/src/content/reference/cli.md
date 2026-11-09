---
title: "CLI reference"
navLabel: "CLI"
group: "API reference"
section: "@pyric/cli"
order: 100000
description: "Syntax, flags, configuration, and command selection for pyric sandbox."
---

# CLI reference

## Syntax

```text
pyric sandbox [flags] [--] [command...]
```

Put every Pyric flag before the first child command token. After the first child command token, every remaining argument belongs to the child. A bare `--` makes the boundary explicit.

```bash
pyric sandbox --bridge -- npm run dev -- --port 3000
```

## Command selection

Pyric selects what to run in this order:

1. `--no-run` skips an explicit or configured child application command.
2. An explicit `[command...]` runs as the child process.
3. `--json` with no explicit command skips the configured child application command.
4. `command` in `pyric.json` runs as the child process.
5. With no command, Pyric starts the sandbox host without a child application command.

A Functions source declared in `firebase.json` can still run when the child application command is skipped.

The child receives `PYRIC_SANDBOX` and a `NODE_OPTIONS` import for `@pyric/cli/register`. This routes supported `firebase-admin/*` imports to the sandbox host. With `--hosted`, `firebase/database`, `firebase/firestore`, `firebase/auth` and `firebase/storage` in the child reach the Node host as the child's own signed-in user; other client SDKs, and client SDKs against the browser-hosted sandbox, fail with `failed-precondition`. A `firebase-admin/*` subpath the sandbox does not mirror, such as `firebase-admin/remote-config` or `firebase-admin/security-rules`, still resolves and returns an `App`-bound handle from `get<Service>(app)`, so module-level initialization loads cleanly while calling a method on that handle fails with `PyricDeferredApiError`. The import never reaches the real `firebase-admin`.

## Run a command on a running host

```text
pyric run [--sandbox <url>] [--wait[=<seconds>]] -- <command...>
```

`pyric run` starts one command against a host that is already running, such as a Vite dev server with `pyric({ hosted: true })` in `vite.config.ts` or a `pyric sandbox --hosted` in another terminal. A Vite dev server with the in-page plugin, `pyric()` with no `hosted`, has no host: `pyric run` exits with `2` at once and names `pyric({ hosted: true })`. The command gets the environment `pyric sandbox` gives its child: `PYRIC_SANDBOX=remote:<url>`, `PYRIC_SANDBOX_INSTANCE` naming that host, and a `NODE_OPTIONS` import of `@pyric/cli/register`. `--sandbox` names the host. Without it, `pyric run` uses an inherited `PYRIC_SANDBOX=remote:<url>`, then the `.pyric/serve.json` that the host wrote in the project directory. With `--wait`, it polls the host's `/__pyric/health` until the host answers, for 30 seconds or the number of seconds given (`--wait=60`), so a command started alongside the dev server does not race it. It exits with the command's exit code, or `2` when no host answers in time.

The register module is passed by absolute `file:` URL, resolved from the `pyric` install that runs the command, as `pyric sandbox` passes it. So the command can run from a directory where `@pyric/cli` does not resolve by name, such as a backend beside a `tools/` folder that pins Pyric:

```bash
cd backend && ../tools/node_modules/.bin/pyric run --sandbox http://localhost:5173 -- node dist/index.js
```

A Vite config in another folder loads the plugin from that install the same way:

```js
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const { pyric } = await import(pathToFileURL(createRequire(new URL("../tools/package.json", import.meta.url)).resolve("@pyric/cli/vite")).href);
```

`@pyric/cli/vite`, `@pyric/cli/register` and `@pyric/cli/next` resolve through `require.resolve` as well as `import`.

## Flags

| Flag | Meaning |
|---|---|
| `--port <number>` | Set the first port to try. The default is `3473`. Pyric scans forward if it is taken. |
| `--host <host>` | Set the bind host. The default is `localhost`. A client on another machine still reaches hosted files and Functions HTTP routes, and those functions can write through `firebase-admin`, so the backend is not private on your network. Sandbox, Studio, and MCP routes answer clients on this machine only. |
| `--bridge` | Mount MCP at `/__pyric/mcp`. |
| `--ui` | Open Studio instead of the served application. Studio is served by default. |
| `--no-ui` | Do not serve Studio, docs, workspace, or project routes. |
| `--no-open` | Do not open a browser. Browser opening is also disabled for `--json`, CI, and non-interactive output. |
| `--seed <file>` | Load a JSON document map or a Pyric state file. |
| `--persist` | Save documents and auth users to `.pyric/state/state.json`. |
| `--fresh` | With `--persist`, discard existing saved state before startup. |
| `--no-watch` | Disable Firestore, Realtime Database, and Storage rules hot reload. |
| `--no-capture` | Do not write `.pyric/last-session.json`. |
| `--no-cache` | Rebuild browser SDK bundles. |
| `--no-run` | Do not run an explicit or configured child command. |
| `--json` | Print one machine-readable readiness line. A configured command is skipped unless it is also supplied explicitly. |
| `--project <id>` | Set the Firebase project, a project id or a `.firebaserc` alias. It names the default Realtime Database instance, selects `.firebaserc` deploy targets, and labels the bridge. |
| `--permissive` | Allow unauthenticated RTDB access when no RTDB rules file exists. Use only for local prototypes. |
| `--allowed-host <host>` | Add allowed Host headers. Use commas for multiple hosts. |
| `--only hosting` | Accepted for Firebase CLI compatibility. Hosting is the only supported value. |

## Auth identity

`pyric auth impersonate`, `pyric auth whoami`, and `pyric auth sessions` are service-tool commands, derived like every `pyric <tool> <method>` command, and act on this project's local `.pyric/state`. No running bridge is required.

```bash
pyric auth impersonate --uid <uid> [--tenantId <id>] [--customClaims '<json>'] [--json]
pyric auth actAsAdmin [--json]
pyric auth actAsAnonymous [--json]
pyric auth useAppSession [--json]
pyric auth whoami [--json]
pyric auth sessions [--json]
```

A boolean argument is written alone, `--disabled`, or with `true` or `false`, `--disabled false`. Any other word after it is refused by name, so a word the flag would otherwise take as its value is never read as `true`.

`impersonate` runs every later call as the named user. `--tenantId` sets the Identity Platform tenant, and `--customClaims` takes a JSON object of custom claims that rules read as `request.auth.token.<name>`. `actAsAdmin` runs every later call with rules bypassed; `actAsAnonymous` runs every later call unauthenticated; `useAppSession` runs every later call as the application's own signed-in user, with its tenant and claims.

`whoami` reports two identities apart: `agent`, the one your own calls run as, and `appSession`, the user the sandbox's SDK is signed in as. The sign-in commands (`pyric auth signInWithEmailAndPassword`, `signInAnonymously`, `signInWithCustomToken`, `signInWithCredential`, `signOut`) move the app session and leave the agent identity alone. `sessions` lists both.

`pyric auth reset` is different: it sets who a bridge's *clients* act as. A client is a mobile runtime, a Studio tab, or a Node client attached to `pyric sandbox --bridge`. It needs a running bridge, which it finds through `.pyric/serve.json` in the project directory; without one it prints how to start it and exits `1`.

```bash
pyric auth reset [--target <id>] [--json]
```

`reset` returns the named client (or, with no `--target`, your own bridge identity) to the application session, the user the app is signed in as.

With `--target`, `reset` applies to the client it names and to nothing else. Without `--target`, it records your own identity on the bridge, which governs the tool calls you then forward through it: the Firestore data tools run under it with Security Rules enforced, and a call that passes its own `as` argument uses that instead without changing what you recorded. `sandbox_inspect`, the rules simulator, the Realtime Database inspectors, and the auth user tools take no identity and keep bypassing rules.

Every command prints its scope after a successful call.

## Project configuration

Create `pyric.json` in the project root to define defaults:

```json
{
  "command": "next dev",
  "port": 3473,
  "project": "demo-app",
  "rules": {
    "firestore": "firestore.rules",
    "database": "database.rules.json",
    "storage": "storage.rules"
  }
}
```

`rules` can also be a string when only one rules file is needed.

`owners` sets which application frames Pyric records for each listener and SDK call: `skip` lists globs for the app's data-layer wrapper modules, whose frames are never shown first, and `frames` is how many application frames to keep (default `3`). See [Name the code behind a data-layer wrapper](../build/inspect-activity.md#name-the-code-behind-a-data-layer-wrapper).

Command-line values override `pyric.json`. `--project` overrides `PYRIC_PROJECT`, and `PYRIC_PROJECT` overrides the configured project. Without any of them, the project is the one `firebase use` made active for this directory or a parent directory, then the only `.firebaserc` alias, else `.firebaserc` `projects.default`, as the Firebase CLI resolves it.

## Environment variables

In any process the register activates, an import that resolves into the real `firebase-admin` fails before the file loads, with the error code `PYRIC_REAL_SDK_STOPPED`. The register routes every `firebase-admin` import it recognizes to the sandbox, so a real `firebase-admin` there is an import it missed, such as an absolute path, an npm alias, or a link under another name, and it would run with your machine's credentials. The same holds for the real `firebase` and `@firebase/*` packages, except where pyric uses the real SDK on purpose: `firebase/ai` in production AI mode, and the `firebase/app` and `firebase/app-check` it attaches to. Only the import that asked fails, and the log names the import, the file that imported it, the file it resolved to, and the import to write instead. The register finds the package from the `package.json` it ships, not from its folder name. This applies in every worker thread the process starts and in every Node child process the process starts: the register adds itself to the child's `NODE_OPTIONS` and copies in the `PYRIC_*` variables the child's environment lacks, whatever `env` or `execArgv` the child is given. A shell command that sets its own `NODE_OPTIONS`, as in `NODE_OPTIONS=--max-old-space-size=4096 node server.js`, replaces it. Append to the inherited value instead: `NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=4096"`. To run the real SDK, start that process outside a registered process, without `@pyric/cli/register`. `@pyric/cli` requires Node `>= 22.15`; on an older Node without `module.registerHooks`, activation stops immediately with `PYRIC_UNSUPPORTED_NODE_VERSION`. Likewise, `pyric sandbox` refuses to spawn `bun`, `bunx`, or `deno` child commands (`PYRIC_UNSUPPORTED_RUNTIME`), where Node's `module.registerHooks` preload never runs.

`PYRIC_ALLOW_UNSWAPPED_EDGE=1` downgrades Next.js Edge runtime detection in `withPyric` from a startup error (`PYRIC_EDGE_RUNTIME_UNSUPPORTED`) to a warning when an Edge route or middleware intentionally never imports `firebase` or `firebase-admin`.

`PYRIC_GUARD` and `PYRIC_GUARD_ALLOW` are deprecated no-ops. Pyric no longer installs runtime socket or HTTP network interception; setting either variable prints a single deprecation notice to stderr and does not block or alter outbound requests.

`PYRIC_SANDBOX` activates `@pyric/cli/register` in a process and says which sandbox host it uses. Set it to `remote` in `.env` files, package scripts, and agent configuration. The variable alone doesn't load the register: the process also needs `--import @pyric/cli/register` in its `NODE_OPTIONS`, which `pyric sandbox` adds. `withPyric` refuses to start `next dev` when `PYRIC_SANDBOX` is set and the register isn't active, as when the variable comes only from a `.env` file that Next reads, when `NODE_ENV=production` makes the register refuse, or when a package script replaces `NODE_OPTIONS`. With `remote`, the process finds the running host through the `.pyric/serve.json` file that `pyric sandbox` and the Vite plugin write in the project directory, so it follows the host to whatever port it takes, on any machine. `pyric sandbox` prints `export PYRIC_SANDBOX=remote` for a command you start yourself. Use `remote:<url>` only for a process that runs outside the project directory, where `.pyric/serve.json` cannot be found. If nothing answers at that url, or a different host answers there, the process warns once and uses this project's running host when `.pyric/serve.json` names one. Otherwise it fails and says the url is stale. It never attaches to a host that no `.pyric/serve.json` in the project names.

`PYRIC_SANDBOX_INSTANCE` is set by `pyric sandbox` and the Vite plugin's Functions runtime on every child they start, beside `PYRIC_SANDBOX=remote:<url>`. It names the host at that url, so the child attaches there from any working directory. You do not set it yourself.

`PYRIC_BEACON_TOKEN` is set by `pyric sandbox` on every child it starts. A child that has loaded `@pyric/cli/register` presents it when it reports that interception is installed, and the server rejects a report without it. A process you start yourself has no token, so the server does not count its report.

`PYRIC_PROCESS_HEALTH=off` stops a registered process from answering the process health request on its own servers. See [Process health on registered processes](#process-health-on-registered-processes).

`PYRIC_AVATARS` selects the profile-photo source for provider-created auth users. Unset, provider sign-ins get a deterministic generated avatar. `0` and `false` disable avatars, matching Firebase's own behaviour for a provider that supplies no photo. Any other value names a pre-built avatar set directory, resolved from the project root. There is no `--avatars` flag; `pyric sandbox` reads this variable only, one tier short of the Vite plugin's `avatars` option, which also accepts a custom generation source. See [Assign default avatars to sandbox users](../build/default-avatars.md).

## Output and readiness

With `--json`, stdout contains one JSON object with the URL, port, MCP URL, rules hash, persistence state, and restored item counts. The normal banner is written to stderr.

Check `GET <url>/__pyric/init.json`. A `200` response means the server is ready and includes the current rules hash.

## Process health on registered processes

A Node process under `@pyric/cli/register` or `@pyric/live/register` answers `GET /__pyric/health` on each HTTP and HTTPS server it runs, when the request carries the `x-pyric-process-health` header and comes from this machine. Every other request reaches your app, the same path without the header included. So a `withPyric` app still forwards `/__pyric/health` to the sandbox host.

The answer says what the process is:

```json
{ "pyricProcess": { "mode": "live", "projectId": "my-project", "unobservedAdmin": ["firebase-admin/remote-config"] } }
```

- **A sandbox process** answers `mode: "sandbox"`, with `instanceId` from `PYRIC_SANDBOX_INSTANCE` and `host`, the sandbox URL in `PYRIC_SANDBOX=remote:<url>`, when they are set.
- **A live process** answers `mode: "live"` and `projectId`. It adds `unobservedAdmin`, the `firebase-admin` services it loaded that no row serves, and `gatedAdmin`, the `firebase-admin` services checked against the project but not recorded, such as `firebase-admin/app-check`. Each list is absent when it is empty.

To leave the path to your app for every request, set `PYRIC_PROCESS_HEALTH=off`. A dev server's proxy check then reads that process as not under pyric.

## Check a dev server's proxy targets

When a Vite dev server with `pyric()` or `pyricLive()` starts listening, it asks each `server.proxy` target on this machine for its process health. A target that doesn't answer is asked again after its first proxied response. The check prints a warning in the dev server's terminal, at most once per target and verdict, and never refuses a request. Targets on other machines are not checked.

The host's `GET <url>/__pyric/health` lists each verdict in `proxyTargets`, as `{ "context": "/api", "verdict": "same" }`:

| Verdict | Meaning | Warning |
|---|---|---|
| `same` | The target is in the same mode, on the same sandbox or the same project. | None |
| `pyric-host` | The target is a pyric host itself, such as `pyric sandbox`. | None |
| `not-pyric` | The target gave no process health: it runs without a register, sets `PYRIC_PROCESS_HEALTH=off`, or didn't answer. | On a sandbox page, its calls may reach production. None on a live page. |
| `other-mode` | A sandbox page in front of a live backend, or a live page in front of a sandbox backend. | Names the mode and how to start the backend |
| `other-instance` | A sandbox page in front of a backend on another pyric sandbox. | Names the instance and `pyric run --sandbox <url>` |
| `other-project` | A live page in front of a backend in live mode for another project. | Names both projects |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Invalid command or options. |
| `2` | Runtime failure. |

## Examples

Start the sandbox host and serve the configured hosting directory:

```bash
pyric sandbox
```

Run a Next.js development server inside the sandbox:

```bash
pyric sandbox -- next dev
```

Start a machine-readable MCP bridge without a child command:

```bash
pyric sandbox --bridge --json
```

Run an explicit command while keeping machine-readable output:

```bash
pyric sandbox --bridge --json -- npm run dev
```
