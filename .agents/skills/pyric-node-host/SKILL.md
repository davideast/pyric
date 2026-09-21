---
name: pyric-node-host
description: Install Pyric from a local checkout, start a project's sandbox in Node host mode, and exercise it. Use to test hosted mode, where one Node process runs the sandbox for every browser and tool and keeps state in SQLite. Requires a cloned Pyric repository, because Node host mode is not published to npm. Don't use for ordinary Pyric work (use pyric) or to convert an app that already runs the SharedWorker sandbox (use pyric-migrate-to-node-host).
---

# Test Pyric's Node host mode

Run this project's sandbox in one long-lived Node process instead of a per-browser SharedWorker,
then exercise it and report what you find.

## What is different in this mode

- The sandbox runs in the dev server's Node process. Every browser, Studio, the CLI, and MCP tools
  attach to that one sandbox and see the same data.
- State is durable. It lives in `.pyric/state/hosted/state.sqlite` and survives restarts.
  Persistence is always on; there is no `--persist` to add.
- The bridge is mounted automatically. Do not add `bridge: true` or `--bridge` for it.
- One host owns a project at a time. A second start in the same project is refused with
  `A sandbox already owns this project's persisted state.` Attach to the running one instead.
- `GET <url>/__pyric/health` reports `"sandboxConnected": true` as soon as the host starts. No
  page has to be open, because the Node process is the sandbox.

## Requirements

- Node 22.15 or later. Hosted mode uses `node:sqlite`. It refuses to start under Bun and in the
  standalone binary, and says so. Run the launcher with Node even if the project uses Bun as its
  package manager.
- A cloned Pyric repository. Ask for its path if you were not given one. Call it `<pyric>` below.
- Bun and npm on the PATH. The checkout builds with Bun; packing uses npm.

Node prints `ExperimentalWarning: SQLite is an experimental feature` on every hosted start. That
is expected.

## Choose the checkout branch

Use `main`. It carries Node host mode and every fix from its review, including restoring RTDB,
presence, and event-stream subscriptions after a host restart, and the bounded engine event log.
Pull before you pack. Say which commit you tested in your report.

## Install from the checkout

Never install `@pyric/cli@latest` for this. The published package has no Node host.

1. Build and pack, from the project being tested. The script ships with this skill in the checkout:

   ```sh
   bash <pyric>/.agents/skills/pyric-node-host/scripts/pack-local.sh <pyric> .pyric-local
   ```

   It builds the checkout, packs `pyric`, `pyric-admin`, `create-pyric`, and `@pyric/cli`, rewrites
   their `workspace:*` ranges, and prints the four tarball paths.
2. Install all four together as development dependencies, by relative path, with the project's
   package manager. With npm:

   ```sh
   npm install --save-dev ./.pyric-local/pyric-*.tgz ./.pyric-local/create-pyric-*.tgz
   ```

   All four must be installed in one command. `@pyric/cli` depends on the other three at a version
   that exists only in these tarballs.
3. Add `.pyric-local/` and `.pyric/` to `.gitignore`. Do not commit the tarballs or the
   `file:` dependency lines; this install is for testing.
4. Confirm the version: `npx --no-install pyric --version` prints a version newer than npm's
   `latest`.

After pulling new commits in `<pyric>`, run the pack script and the install command again.

## Start one host

1. Inspect `package.json`, `vite.config.*`, `firebase.json`, and `pyric.json`.
2. Choose one launcher:
   - **Vite:** in the existing `plugins` array, use one `pyric({ hosted: true })` call, imported
     from `@pyric/cli/vite`. Keep the project's other options such as `seed` and `rules`. Start the
     existing dev script under Node. Hosted mode needs Vite's own HTTP server; it does not support
     Vite's middleware mode.
   - **Any other app:** `pyric sandbox --hosted --json -- <command>`, with Pyric flags before the
     child command. With no child command, `npx --no-install pyric sandbox --hosted --json` starts
     only the host.
3. Keep the URL the launcher prints. With `--json` it is the `url` field; `restoredDocs` and
   `restoredUsers` report what was loaded from the store.
4. Keep the process running in the background. Stop it with an interrupt signal, not a kill, so it
   drains in-flight work and closes the store.

## Verify before testing

1. `GET <url>/__pyric/health` returns `"sandboxConnected": true`.
2. `npx --no-install pyric serve diagnostics --json` reports `server.mode` as `"hosted"` and
   `server.persistence.state` as `"healthy"`.

Report the URL, the branch and commit of `<pyric>`, and both results before going further. If
`persistence.state` is `"unhealthy"`, stop and report; the host refuses every further write by
design until it is restarted.

The plugin's `pyric` MCP server discovers the host through `.pyric/serve.json`, as in any Pyric
session. Data tools work without a page open.

## What to exercise

Work through these and record the observed result for each. Each line states what should happen.

1. **Restart durability.** Write Firestore documents, RTDB data, an Auth user, and a Storage
   object. Interrupt the host and start it again. All four are present, and the launcher's
   `restoredDocs` and `restoredUsers` are nonzero.
2. **Two clients, one sandbox.** Open the app in two browser profiles, or a browser plus MCP tools.
   A write from one reaches a listener in the other without a reload.
3. **Host restart with a page open.** Leave a page with Firestore and RTDB listeners open, restart
   the host on the same port, then write. The page recovers its listeners and receives the write
   without a reload. Writes made while the host was down are not replayed.
4. **Reset and checkpoint load with live listeners.** Each listener fires once per state change,
   not twice. RTDB rules still apply after a reset.
5. **Interrupted write.** Kill the host with SIGKILL during a burst of writes, then start it. It
   recovers from the write-ahead log and every acknowledged write is present.
6. **Second host refused.** Start a second host in the same project. It exits with the ownership
   message and the first host is unaffected.
7. **Fresh start.** `--fresh` (or `fresh: true` in the Vite options) archives the current store
   and starts empty. The archive is a directory, `.pyric/state/hosted.archive-<time>-<id>`. To go
   back, stop the host, move the current `.pyric/state/hosted` aside, and rename the archive to
   `.pyric/state/hosted`. The launcher prints the same instruction.
8. **Memory under sustained writes.** Watch the Node process's resident memory across several
   minutes of writes. It levels off. Growth that keeps climbing in
   step with the bytes written is a finding; report the branch, the write size, and the numbers.

## When something breaks

- Never delete `.pyric/state/` to get unstuck. It is the evidence. If a start is refused with
  `Hosted state could not be restored`, the message names the repair command:

  ```sh
  pyric sandbox salvage --source .pyric/state/hosted --out ./recovered
  ```

  It writes every readable record to the new directory, lists each excluded record in
  `recovery-report.json`, and never modifies the source. Report the refusal and the recovery
  report.
- For any failure, capture `pyric serve diagnostics --json`, the host's stderr, the steps, and the
  `<pyric>` commit. Do not paste document contents that the owner would not want shared.
- A first start with `--seed` into an empty store prints `--seed applied` with its counts. A later
  start prints the restored counts and skips the seed, because a seed loads only into an empty
  store.
