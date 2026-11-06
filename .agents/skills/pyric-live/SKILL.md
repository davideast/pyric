---
name: pyric-live
description: Install @pyric/live from npm or from a local Pyric checkout, start live mode in a project, verify which Firebase project it is on, and exercise it. Use to test live mode, where the app's own Firebase SDK talks to a real Firebase project and Pyric shows each Firestore, Realtime Database and Auth call with production's answer. Don't use for ordinary Pyric sandbox work (use pyric) or to test Node host mode (use pyric-node-host).
---

# Test Pyric's live mode

Run this project's app against a real Firebase project with `@pyric/live`, then exercise it and
report what you find.

## Safety first

Live mode is not a sandbox. Every call reaches a real Firebase project.

- Use a test Firebase project, never the owner's production project, unless the owner names the
  project to use.
- Before starting, confirm the project the app's own Firebase config points at (see "Confirm the
  app's project"). The start line names the settings project, not where the app's calls go.
- Every write, account creation, password reset or sign-in link email, and SMS is real. Production
  bills it, and an email or SMS can reach a real person. A write or sign-up can also set off the
  project's Cloud Functions triggers, which may send real email or SMS.
- Write only new documents, under a collection the owner names or under a unique test prefix such
  as `pyric-live-test-<time>`. Never change or delete existing documents.
- Never change the app's code, queries or listeners to make a test cheaper or safer. Live mode
  observes what the app does; a changed app makes the observation worthless.
- Your own test reads, queries and listeners target only the documents you wrote under your test
  collection or prefix. That keeps them small without changing anything.
- Exercising an app flow that reads a whole collection is billed like any production read. If the
  owner hasn't said it's fine, ask first and name the flow.
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
- npm on the PATH. Installing from a checkout also needs Bun, and a cloned Pyric repository.
- An app whose installed `firebase` is in `^12.12.0`, with exactly one copy of `@firebase/app`.
  Live mode refuses to start otherwise, with `Live mode did not start.` and the version it found,
  or the path of every copy.
- A Firebase project set for the app. With none, the start is refused with
  `No Firebase project is set for <folder>`.

## Choose the source

Install from one of two sources, and say which in your report:

- **npm, the `exp` tag.** The default. It is the latest published build.
- **A Pyric checkout.** Use it when you were asked to test a commit or branch that is not
  published yet, or when the owner names a checkout.

## Install from npm

1. Install the three packages together as development dependencies, with the project's package
   manager. With npm:

   ```sh
   npm install --save-dev pyric@exp @pyric/cli@exp @pyric/live@exp
   ```

   `@pyric/cli` brings `pyric-admin` and `create-pyric` at the same version.
2. Run `npm ls pyric @pyric/cli @pyric/live`. All three must be the same version, the one
   `npm view @pyric/live dist-tags.exp` prints. If one is older, the project pinned it: change that
   range to `exp` and install again.
3. Add `.pyric/` to `.gitignore`.
4. Confirm it runs: `npx --no-install pyric-live --help` prints the usage.

Installing `@pyric/live` with npm 7 or later also installs its `firebase` peer into that package. In a layout where pyric sits in a separate package beside the app, set
`legacy-peer-deps=true` in that package's `.npmrc` so a second `firebase` does not trip the
one-`@firebase/app` start check.

To move to a newer build later, run the install command again.

## Install from a checkout

Call the checkout's path `<pyric>`. Ask for it if you were not given one. Use `main` unless you
were given a branch or commit, and pull before you pack.

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

After pulling new commits in `<pyric>`, empty `.pyric-local/` so old tarballs are not installed
next to new ones, then run the pack script and the install command again.

## Confirm the app's project

Live mode learns the app's project only from its calls, so a warning about a different project
comes after a call has already reached it. Check before starting:

1. Find every `initializeApp` call and the options it passes, and any environment values those
   options read (for Vite, `import.meta.env.VITE_*`; for Node, `process.env`). For Vite, check
   `.env` and the files that override it: `.env.local`, `.env.development`, `.env.[mode]` and
   `.env.[mode].local`. A Node `initializeApp()` with no arguments reads its config from the
   environment; treat that as a project you can't tell, and stop.
2. Check that `projectId` is the test project you were given. If it isn't, or you can't tell,
   stop and report what you found.

## Start live mode

1. Inspect `package.json`, `vite.config.*`, `firebase.json` and `.firebaserc`.
2. Choose one launcher:
   - **Vite:** in the existing `plugins` array, replace any `pyric()` call from `@pyric/cli/vite`
     with `pyricLive()`, imported from `@pyric/live/vite`, and move its options over. Never keep
     both: each registers `pyric:sandbox` with `enforce: 'pre'`. Start the existing dev script.
     The dev server is the live host.
   - **Node process:** `node --import @pyric/live/register server.js`. It reports its calls to the
     live host for the same project, so start a host first. When pyric sits in a package beside
     the app, point `--import` at that package's file:
     `node --import ../rules/node_modules/@pyric/live/dist/register.js server.js`.
   - **No Vite dev server:** `npx --no-install pyric-live --no-open`, with `--port` (default
     3473), `--host` and `--project <id>`. It starts no child command; start the Node process in
     another terminal.
3. The settings project comes from, in order: `--project` (or the plugin's `project` option),
   `PYRIC_PROJECT`, `firebase use`, then `.firebaserc`. Live mode does not read `pyric.json`. The
   app's own Firebase config decides where its calls go.
4. Keep the process running in the background. Stop it with an interrupt signal, not a kill.

## Verify before testing

1. The start line names the expected project. It is the settings project from step 3 of
   "Start live mode", not the one the app's config points at, which is why you checked that first:

   ```text
   pyric-live: live mode for the Firebase project <project>. Your app talks to production with its real data, and production bills each read, write and listener delivery. The chip and Studio show "Live: <project>" while it runs.
   ```

   The Vite entry prints it as `@pyric/live/vite: ...`, and a Node process under the register as
   `@pyric/live/register: ...`, followed by a line saying which host its calls reach.
2. The chip and Studio show `Live: <project>` before the app makes its first call. Until a call
   is made, that label is also the settings project.
3. `GET <url>/__pyric/health` has a `live` field: `projectId`, `configProjectId`, `configSource`,
   `appProjectIds`, the `billed` counts (`reads`, `writes`, `deliveries`), and `passThrough`
   when the host passes imports through. A sandbox host has no `live` field.

Report the project, the URL, the source (the npm version, or the branch and commit of `<pyric>`),
and these results before going
further. If the terminal, the chip or Studio warns that the app's calls go to a different project
(`Live mode: your app's calls go to the Firebase project <a>, not <b>.`), stop and report.

## What to exercise

Work through these and record the observed result for each. Each line states what should happen.

1. **Firestore.** A write of a new document, and a read, a query and a listener, all on the test
   collection or prefix in the `(default)` database, each appear
   as a row served by production, with the method (such as `setDoc`), production's answer, the
   client (this page, another tab or a Node process), and the signed-in account's id and claim
   names. No row shows a token.
2. **Denied write.** A write the project's rules deny shows `permission-denied` as production's
   answer. It does not raise the billed-call count.
3. **Realtime Database.** A write, a read, a transaction and a listener under the test prefix each
   appear as a row served by production, named with its service (such as `rtdb.set` or
   `rtdb.onValue`) and showing the path. Each listener delivery is its own row. A call the rules
   deny shows `permission_denied`. A named instance's calls appear the same way, though the row
   doesn't name the instance yet. A `.info/connected` listener makes no row. RTDB listeners don't
   show in the chip's Data tab or Studio's Listeners view yet, and RTDB calls don't raise the
   billed-call count; neither is a finding.
4. **Auth.** Sign up and sign in with a test account. Each call is a row with production's answer.
   Skip this step if the project sends mail on sign-up (a Functions trigger or an Auth email
   setting), unless the owner agrees.
5. **Node process.** A process under `@pyric/live/register` prints
   `reporting calls to the live host at <url>`, and its calls appear as rows from a Node process.
6. **Refusals.** Each throws an error with the code `PYRIC_LIVE_REFUSED` before any request
   leaves, and says what was refused:
   - importing `firebase/functions` (Cloud Functions);
   - a named Firestore database, such as `getFirestore(app, 'reports')`;
   - `firebase-admin` in a Node process under the register;
   - a Studio edit or an MCP tool that writes.

   Live mode refuses each Firebase import it doesn't serve. An app that lists one, as in
   `pyricLive({ passThrough: ['firebase/functions'] })`, loads it from its own installed SDK,
   unobserved: its calls still bill, and the start line, the chip and Studio name it as passing
   through. A list that names an import live mode serves, such as `firebase/database`, stops the
   dev server at start with `passThrough lists firebase/database, which live mode already serves
   and observes; remove it.` A Node process under the register passes through the same list: at start it reads
   the list from its live host's `/__pyric/health`, prints a line for each import, and passes the
   same ones to its children and workers. Start the process after the host; a process started
   with no live host, or under `pyric-live`, which takes no list, still refuses them.
7. **Real SDK stopped.** `@google-cloud/firestore` in a Node process under the register fails with
   `PYRIC_REAL_SDK_STOPPED`.
8. **Own requests blocked.** A Node process's global `fetch` to Firestore rejects with
   `TypeError('fetch failed')`, whose `cause.code` is `PYRIC_GUARD_BLOCKED`. That process's own
   stderr names the host.
9. **Billed-call count.** The chip and Studio count goes up as calls production answers with
   success. Reads and writes count once per call, not per document; listener deliveries count the
   documents delivered. A denied call is not counted.

Live mode can't see some calls, so a missing row for one of these is not a finding: an `import()`
of the exact URL of an SDK file the page already loaded, or that URL with a fragment; the page's
own `fetch` to the Firestore REST API, Auth or App Check; and, in a Node process, a connection
opened with `http2`, `tls`, `@grpc/grpc-js` or `undici`, or an `http.request` through a `CONNECT`
proxy tunnel. A host also names at most eight projects in its label and warning.

## When something breaks

- Capture the start line, the host's terminal output, the steps, and the npm version or the
  `<pyric>` commit. For a host, add the `live` field of `GET <url>/__pyric/health`.
- Do not share document contents, tokens, API keys, or the email addresses and phone numbers used.
- Do not retry a write, sign-up or email to get unstuck. Each attempt is real and billed.
