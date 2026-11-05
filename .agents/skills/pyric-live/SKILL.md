---
name: pyric-live
description: Install @pyric/live from a local Pyric checkout, start live mode in a project, verify which Firebase project it is on, and exercise it. Use to test live mode, where the app's own Firebase SDK talks to a real Firebase project and Pyric shows each Firestore and Auth call with production's answer. Requires a cloned Pyric repository, because @pyric/live is not published to npm yet. Don't use for ordinary Pyric sandbox work (use pyric) or to test Node host mode (use pyric-node-host).
---

# Test Pyric's live mode

Run this project's app against a real Firebase project with `@pyric/live`, then exercise it and
report what you find.

## Safety first

Live mode is not a sandbox. Every call reaches a real Firebase project.

- Use a test Firebase project, never the owner's production project, unless the owner names the
  project to use.
- Confirm the project the start line names before the app makes any call. If it is not the one
  you were given, stop.
- Every write, account creation, password reset or sign-in link email, and SMS is real. Production
  bills it, and an email or SMS can reach a real person.
- Never use real people's email addresses or phone numbers. Use addresses and numbers the owner
  controls or gives you.
- Never paste document contents, ID tokens, refresh tokens or API keys into a report.

## What is different in this mode

- The app keeps its own Firebase SDK, and that SDK talks to the real project, with its real data
  and real billing.
- Pyric only observes. It doesn't change what the app sees, and it holds no production credential.
- The chip's Traffic panel, Studio and the terminal show each call with production's answer.
- Nothing in `pyric` or `@pyric/cli` turns live mode on. Without `@pyric/live` installed in the
  project, the app gets the sandbox.

## Requirements

- Node 22.15 or later.
- A cloned Pyric repository. Ask for its path if you were not given one. Call it `<pyric>` below.
- Bun and npm on the PATH. The checkout builds with Bun; packing uses npm.
- An app whose installed `firebase` is in `^12.12.0`, with exactly one copy of `@firebase/app`.
  Live mode refuses to start otherwise, with `Live mode did not start.` and the version it found,
  or the path of every copy.
- A Firebase project set for the app. With none, the start is refused with
  `No Firebase project is set for <folder>`.

## Choose the checkout branch

Use `main`. Pull before you pack. Say which commit you tested in your report.

## Install from the checkout

`@pyric/live` is not on npm yet, so install it from the checkout.

1. Build and pack, from the project being tested. The script ships with this skill in the checkout:

   ```sh
   bash <pyric>/.agents/skills/pyric-live/scripts/pack-local.sh <pyric> .pyric-local
   ```

   It builds the checkout, packs `pyric`, `pyric-admin`, `create-pyric`, `@pyric/cli` and
   `@pyric/live`, rewrites their `workspace:*` ranges, and prints the five tarball paths.
2. Install all five together as development dependencies, by relative path, with the project's
   package manager. With npm:

   ```sh
   npm install --save-dev ./.pyric-local/pyric-*.tgz ./.pyric-local/create-pyric-*.tgz
   ```

   All five must be installed in one command. `@pyric/live` depends on `@pyric/cli`, and
   `@pyric/cli` on the other three, at a version that exists only in these tarballs.
3. Run `npm ls pyric @pyric/cli`. If either resolves to a registry copy, add `overrides` to
   `package.json` that point each one at its tarball, then install again:

   ```json
   "overrides": {
     "pyric": "file:./.pyric-local/pyric-<version>.tgz",
     "@pyric/cli": "file:./.pyric-local/pyric-cli-<version>.tgz"
   }
   ```

4. Add `.pyric-local/` and `.pyric/` to `.gitignore`. Do not commit the tarballs, the `file:`
   dependency lines or the overrides; this install is for testing.
5. Confirm it runs: `npx --no-install pyric-live --help` prints the usage.

After pulling new commits in `<pyric>`, run the pack script and the install command again.

## Start live mode

1. Inspect `package.json`, `vite.config.*`, `firebase.json`, `.firebaserc` and `pyric.json`.
2. Choose one launcher:
   - **Vite:** in the existing `plugins` array, add `pyricLive()`, imported from
     `@pyric/live/vite`. It is `@pyric/cli`'s plugin on the Node host with live rows, so it takes
     the place of a `pyric()` call from `@pyric/cli/vite`. Start the existing dev script. The dev
     server is the live host.
   - **Node process:** `node --import @pyric/live/register server.js`. It reports its calls to the
     live host for the same project, so start a host first.
   - **No Vite dev server:** `npx --no-install pyric-live`, with `--port` (default 3473), `--host`,
     `--no-open` and `--project <id>`. It starts no child command; start the Node process in
     another terminal.
3. The project comes from, in order: `--project` (or the plugin's `project` option),
   `PYRIC_PROJECT`, `pyric.json`, `firebase use`, then `.firebaserc`. The app's own Firebase
   config decides where its calls go.
4. Keep the process running in the background. Stop it with an interrupt signal, not a kill.

## Verify before testing

1. The start line names the expected project:

   ```text
   pyric-live: live mode for the Firebase project <project>. Your app talks to production with its real data, and production bills each read, write and listener delivery. The chip and Studio show "Live: <project>" while it runs.
   ```

   The Vite entry prints it as `@pyric/live/vite: ...`, and a Node process under the register as
   `@pyric/live/register: ...`, followed by a line saying which host its calls reach.
2. The chip and Studio show `Live: <project>` before the app makes its first call.
3. `GET <url>/__pyric/health` has a `live` field: `projectId`, `configProjectId`, `configSource`,
   `appProjectIds` and the `billed` counts (`reads`, `writes`, `deliveries`). A sandbox host has
   no `live` field.

Report the project, the URL, the branch and commit of `<pyric>`, and these results before going
further. If the terminal, the chip or Studio warns that the app's calls go to a different project
(`Live mode: your app's calls go to the Firebase project <a>, not <b>.`), stop and report.

## What to exercise

Work through these and record the observed result for each. Each line states what should happen.

1. **Firestore.** A read, a query, a listener and a write on the `(default)` database each appear
   as a row served by production, with the method (such as `setDoc`), production's answer, the
   client (this page, another tab or a Node process), and the signed-in account's id and claim
   names. No row shows a token.
2. **Denied write.** A write the project's rules deny shows `permission-denied` as production's
   answer.
3. **Auth.** Sign up and sign in with a test account. Each call is a row with production's answer.
4. **Node process.** A process under `@pyric/live/register` prints
   `reporting calls to the live host at <url>`, and its calls appear as rows from a Node process.
5. **Refusals.** Each throws an error with the code `PYRIC_LIVE_REFUSED` before any request
   leaves, and says what was refused:
   - importing `firebase/database` (Realtime Database);
   - a named Firestore database, such as `getFirestore(app, 'reports')`;
   - `firebase-admin` in a Node process under the register;
   - a Studio edit or an MCP tool that writes.
6. **Real SDK stopped.** `@google-cloud/firestore` in a Node process under the register fails with
   `PYRIC_REAL_SDK_STOPPED`.
7. **Own requests blocked.** A Node process's global `fetch` to Firestore fails with
   `PYRIC_GUARD_BLOCKED`, and the terminal names the host.
8. **Billed-call count.** The chip and Studio count goes up as calls are made. Reads and writes
   count once per call, not per document; listener deliveries count the documents delivered.

Live mode can't see some calls, so a missing row for one of these is not a finding: an `import()`
of the exact URL of an SDK file the page already loaded, or that URL with a fragment; the page's
own `fetch` to the Firestore REST API, Auth or App Check; and, in a Node process, a connection
opened with `http2`, `tls`, `@grpc/grpc-js` or `undici`, or an `http.request` through a `CONNECT`
proxy tunnel. A host also names at most eight projects in its label and warning.

## When something breaks

- Capture the start line, the host's terminal output, the steps, and the `<pyric>` commit. For a
  host, add the `live` field of `GET <url>/__pyric/health`.
- Do not share document contents, tokens, API keys, or the email addresses and phone numbers used.
- Do not retry a write, sign-up or email to get unstuck. Each attempt is real and billed.
