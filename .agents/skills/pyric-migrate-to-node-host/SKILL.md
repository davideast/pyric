---
name: pyric-migrate-to-node-host
description: Move a project that already runs Pyric's SharedWorker sandbox to Node host mode, carrying its sandbox data across and keeping a way back. Use when an existing Pyric app should share one durable sandbox across browsers, Studio, and tools. Don't use to start Pyric in a project for the first time (use pyric), or only to try Node host mode in a scratch project (use pyric-node-host).
---

# Migrate a SharedWorker app to the Node host

Switch an existing Pyric project from the per-browser SharedWorker sandbox to one Node process that
runs the sandbox for everything attached to the project.

## Decide whether to migrate

Migrate when the project needs one sandbox shared by several browsers, Studio, the CLI, and MCP
tools, or state that survives restarts without a browser profile holding it.

Stay on the SharedWorker when any of these hold. Say so and stop:

- The dev launcher cannot run under Node 22.15 or later. Hosted mode uses `node:sqlite`; it refuses
  to start under Bun and in the standalone binary.
- The project mounts Pyric in Vite's middleware mode, inside another server. Hosted mode needs
  Vite's own HTTP server.
- Several developers or processes start sandboxes in the same project directory at once. One host
  owns a project at a time; a second start is refused.

## What changes and what does not

| | SharedWorker | Node host |
| --- | --- | --- |
| Where the sandbox runs | A SharedWorker in each browser profile | The dev server's Node process |
| Who shares it | Tabs of one browser profile | Every browser, Studio, CLI, and MCP tool on the project |
| State | In the browser, or `.pyric/state/state.json` with `persist` | `.pyric/state/hosted/state.sqlite`, always durable |
| Bridge | Opt in with `bridge: true` or `--bridge` | Mounted automatically |
| `/__pyric/health` `sandboxConnected` | True once a page is open | True as soon as the host starts |
| Instances per project | One per browser profile | One, enforced by a lock |

Application code does not change. Firebase imports, rules files, `firebase.json`, seeds, and
production builds stay as they are.

No data moves on its own. The Node host never reads the SharedWorker's stores, and it never deletes
them, so the old mode stays intact as the way back.

## 1. Preflight

1. Read `package.json`, the lockfile, `vite.config.*`, `firebase.json`, and `pyric.json`. Record
   the current launcher and every Pyric option and flag in use, especially `bridge`, `persist`,
   `fresh`, `seed`, and `rules`.
2. Check `node --version` is 22.15 or later, and that the dev script runs under Node.
3. Check the installed `@pyric/cli` has the Node host: `npx --no-install pyric sandbox --help`
   is not enough, because the flag is not listed while the mode is unannounced. Instead confirm
   `node_modules/@pyric/cli/dist/serve/hosted/runtime.js` exists. If it does not, the published
   package predates the mode; install from a Pyric checkout by following the install section of
   the `pyric-node-host` skill, then return here.
4. Commit or stash unrelated work so the migration is one reviewable change.

## 2. Carry the sandbox data across (optional)

Skip this when the project's `seed` file already describes the data it needs.

Do this before the first hosted start. `pyric snapshot` reads a running persisted sandbox first,
then a hosted SQLite store if one exists, and only then the SharedWorker's JSON store, so once
`.pyric/state/hosted/` exists it no longer exports the old data.

1. `pyric snapshot` can only reach SharedWorker state that is persisted. If the project does not
   already use `persist: true` or `--persist`, turn it on for this one run. Data that lives only in
   a browser profile from earlier unpersisted sessions cannot be exported; recreate it instead.
2. Start the project the old way and open the app so the sandbox is live and its state is written.
3. Export it while that launcher runs. Pass the dev server's port when it is not Pyric's default:

   ```sh
   npx --no-install pyric snapshot --out pyric-carryover.json --port <port>
   ```

   The `--json` result reports the `source` it read and the `docs` and `users` counts. Check the
   source is the running sandbox or `.pyric/state/state.json`, not a hosted store. The fixture has
   `firestore`, `auth`, and `storage` sections. Passwords are redacted by default. Add
   `--include-passwords` only if test users must keep signing in with their passwords, and in that
   case keep the file out of version control.
4. Stop the old launcher before starting the Node host. A persisted SharedWorker launcher and the
   Node host claim the same project state lock, and either way two dev servers contend for the
   port.

RTDB data is not part of the fixture. Recreate it from the app, a script, or MCP tools after the
switch, and say in your report that it was not carried.

## 3. Switch the launcher

Change only the Pyric options. Leave the rest of the configuration alone.

- **Vite:** in the one existing `pyric({ ... })` call, add `hosted: true`. Remove `bridge: true`
  and `persist: true`; hosted mode implies both. To load carried data, set
  `seed: 'pyric-carryover.json'`, or keep the project's own seed.

  ```ts
  import { pyric } from '@pyric/cli/vite';

  export default defineConfig({
    plugins: [pyric({ hosted: true, seed: 'pyric-carryover.json' })],
  });
  ```

- **`pyric sandbox` launcher:** replace `--bridge --persist` with `--hosted`. Keep `--json` and the
  child command as they were:

  ```sh
  pyric sandbox --hosted --seed pyric-carryover.json --json -- <command>
  ```

Add `.pyric/` to `.gitignore` if it is not there. The SQLite store is local state, not source.

## 4. First start

1. Start the dev script under Node and keep it running.
2. A seed loads only into an empty store, so it applies on this first start and not on later ones.
   The launcher prints `--seed applied` with the document and user counts; confirm them against
   the snapshot's `docs` and `users`, and read one carried document.
3. Expect `ExperimentalWarning: SQLite is an experimental feature` from Node on every start.

## 5. Verify

1. `GET <url>/__pyric/health` returns `"sandboxConnected": true` with no page open.
2. `npx --no-install pyric serve diagnostics --json` reports `server.mode` `"hosted"` and
   `server.persistence.state` `"healthy"`.
3. Open the app. Sign in as a carried user, read carried Firestore documents and Storage objects,
   and confirm a rules-denied operation is still denied.
4. Open the app in a second browser profile. A write in one appears in the other's listener
   without a reload. This is the behavior the migration is for.
5. Interrupt the dev server and start it again without the seed. The data is still there.
6. Run the project's own tests that touch Firebase.

Report each result. If `persistence.state` is `"unhealthy"`, stop: the host refuses further writes
until restarted, and the cause belongs in the report.

## 6. Tell the owner what is different day to day

- One dev server per project directory. A second start says
  `A sandbox already owns this project's persisted state.`
- Data persists until `--fresh` (or `fresh: true`), which archives the store to
  `.pyric/state/hosted.archive-<time>-<id>` and starts empty. Reloading the page no longer resets
  anything.
- All browsers share users and data. A test that relied on a private sandbox per browser profile
  now sees other clients' writes.
- If a start is ever refused with `Hosted state could not be restored`, the message names
  `pyric sandbox salvage --source <hosted-directory> --out <new-directory>`, which recovers every
  readable record into a copy without touching the original. Never delete `.pyric/state/` to get
  past it.

## Going back

Remove `hosted: true` or `--hosted`, restore the `bridge` and `persist` options recorded in the
preflight, and start the project. The SharedWorker's own state was never touched, so it resumes
where it was. Data written while hosted stays in the SQLite store; export it first with
`pyric snapshot` if it should come along.
