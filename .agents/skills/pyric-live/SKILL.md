---
name: pyric-live
description: Install @pyric/live from npm or from a local Pyric checkout, start live mode in a project, verify which Firebase project it is on, and exercise it. Use to test live mode, where the app's own Firebase SDK talks to a real Firebase project and Pyric shows each Firestore, Realtime Database, Cloud Storage, AI Logic and Auth call, and a Node backend's firebase-admin calls, with production's answer. Don't use for ordinary Pyric sandbox work (use pyric) or to test Node host mode (use pyric-node-host).
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
- Write only new documents and files, under a collection or path the owner names or under a unique
  test prefix such as `pyric-live-test-<time>`. Never change or delete existing documents or files.
  Delete the files you uploaded when you finish.
- Never change the app's code, queries or listeners to make a test cheaper or safer. Live mode
  observes what the app does; a changed app makes the observation worthless.
- Your own test reads, queries and listeners target only the documents you wrote under your test
  collection or prefix. That keeps them small without changing anything.
- Exercising an app flow that reads a whole collection is billed like any production read. If the
  owner hasn't said it's fine, ask first and name the flow.
- Never use real people's email addresses or phone numbers. Use addresses and numbers the owner
  controls or gives you.
- Never paste document contents, ID tokens, refresh tokens or API keys into a report.
- A backend's `firebase-admin` calls use the backend's own credential and bypass Security Rules.
  A test write from the backend changes production data whatever the rules say. Keep it under
  the test prefix like any other write.

## What is different in this mode

- The app keeps its own Firebase SDK, and that SDK talks to the real project, with its real data
  and real billing.
- Pyric only observes. It doesn't change what the app sees, it holds no production credential,
  and it never blocks a request at the network. A Google call no row observes goes out, and the
  terminal and the health report name its host.
- The chip's Traffic panel, Studio and the terminal show each call with production's answer.
- Nothing in `pyric` or `@pyric/cli` turns live mode on. Without `@pyric/live` installed in the
  project, the app gets the sandbox.

## Requirements

- Node 22.15 or later. A backend that uses `firebase-admin` needs Node 23 or later, and
  `firebase-admin` 13.
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
   `appProjectIds`, the `billed` counts (`reads`, `writes`, `deliveries`), `admin`, `passThrough`
   when the host passes imports through, `unobserved` when the host process called a Google
   host no row observed, and `clients` while a page or Node process is connected. A sandbox host
   has no `live` field. When the dev server has
   `server.proxy` targets on this machine, `proxyTargets` lists a verdict for each.
4. A Node backend that uses `firebase-admin` prints its own start lines. On Node 23 or later with
   `firebase-admin` 13, one line says `firebase-admin is observed for the Firebase project
   <project>`, that its Admin calls bypass Security Rules, which services are observed, and that
   App Check calls are checked but not observed. On Node 22 the line says `firebase-admin is
   refused in this process` and names Node 23: stop and report it, since the backend's Admin
   calls will fail.

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
4. **Cloud Storage.** An upload, `getMetadata`, `getBytes`, `list` and `deleteObject` under the test
   prefix each appear as a row served by production, named with its service (such as
   `storage.uploadBytes`) and showing a `gs://<bucket>/<path>` path. An `uploadBytesResumable` task
   is one row, however many chunks it sends. A call on a second bucket names that bucket. A call
   the rules deny shows `storage/unauthorized` and reads "Production denied". Fetching a
   `getDownloadURL` URL makes no row, and Storage calls don't raise the billed-call count; neither
   is a finding.
5. **AI Logic.** `generateContent`, `generateContentStream`, `countTokens` and a chat's
   `sendMessage` and `sendMessageStream`, each with a short prompt, appear as a row served by
   production, named with its service (such as `ai.generateContent` or `ai.chat.sendMessage`) and
   showing the requested model. A row's detail shows production's input and output tokens (a
   `countTokens` row shows "Counted tokens"). A successful row's detail reads "Response content was
   not recorded for this request.", and a failed row's reads "No successful response was
   returned." A call from an app with no App Check token, on a project that enforces App Check for
   AI Logic, reads as failed with `unauthenticated`. Every call bills by token, so keep prompts
   short and calls few. AI Logic calls don't raise the billed-call count; that is not a finding.
6. **Auth.** Sign up and sign in with a test account. Each call is a row with production's answer.
   Skip this step if the project sends mail on sign-up (a Functions trigger or an Auth email
   setting), unless the owner agrees.
7. **Node process.** A process under `@pyric/live/register` prints
   `reporting calls to the live host at <url>`, and its calls appear as rows from a Node process.
8. **Admin SDK backend.** A backend's `firebase-admin` Firestore write and read, Auth
   `verifyIdToken` of the test account's token, Realtime Database write, Storage `save` and
   Messaging send (only to a registration token the owner gives you) each appear as a row named
   `<Class>.<method>`, such as `DocumentReference.set` or `Auth.verifyIdToken`, marked as an Admin
   call that bypassed Security Rules, with the test account's uid on the `verifyIdToken` row. App
   Check calls make no row; the process health lists `firebase-admin/app-check` in `gatedAdmin`,
   and that is not a finding. `Query.stream`, `BulkWriter`, `recursiveDelete`,
   `createReadStream` and `createWriteStream` make no row either. They are a gap in what pyric
   shows, not a finding, and not a sign the calls were checked.
9. **Refusals.** Each throws an error with the code `PYRIC_LIVE_REFUSED` before any request
   leaves, and says what was refused:
   - importing `firebase/functions` (Cloud Functions);
   - a named Firestore database, such as `getFirestore(app, 'reports')`;
   - AI Logic's Live API (`getLiveGenerativeModel`, `new LiveGenerativeModel`), its server prompt
     templates (`getTemplateGenerativeModel`, `new TemplateGenerativeModel`), and Imagen
     (`getImagenModel`) on firebase below 12.19; nothing reaches production for them. The full
     list is in the live mode guide's "AI Logic calls" section
     (`packages/site-docs/src/content/observe/live-mode.md`);
   - a `firebase-admin` app initialized with another project's `projectId`, on its first call;
   - a `firebase-admin` Realtime Database `ref()` on an instance that is neither
     `<project>-default-rtdb`, `<project>`, nor one firebase.json names;
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
10. **Real SDK stopped.** `@google-cloud/firestore` in a Node process under the register fails with
   `PYRIC_REAL_SDK_STOPPED`.
11. **Unobserved calls go out.** A Node process's own `fetch` to a Google host no row observes,
    such as `cloudtrace.googleapis.com`, goes through. Its stderr prints one `unobserved call to
    <host>` line for that host, and the process health lists the host in `unobserved`. Nothing
    is refused.
12. **Mode mismatch.** A request to the live backend that carries an ID token from a pyric
    sandbox makes `verifyIdToken` reject with `code: 'auth/argument-error'` and
    `pyricCode: 'PYRIC_MODE_MISMATCH'`, with no row.
13. **Billed-call count.** The chip and Studio count goes up as calls production answers with
    success. Reads and writes count once per call, not per document; listener deliveries count the
    documents delivered. A denied call is not counted.

Live mode can't see some calls, so a missing row for one of these is not a finding: an `import()`
of the exact URL of an SDK file the page already loaded, or that URL with a fragment; the page's
own `fetch` to the Firestore REST API, Auth, App Check, AI Logic or a Storage download URL; and, in a Node
process, the process's own request to a host a row's SDK reaches, such as `firestore.googleapis.com`,
which reads as observed with no line. A host also names at most eight projects in its label and warning.

## Read the unobserved lines and health

- `@pyric/live/register: unobserved call to <host> (<service>).` or the same line from
  `@pyric/live/vite`: the process called a Google or Firebase host no row observes. The call went
  to production. Only the first call to each host prints a line. Report the hosts, since each is
  a call pyric can't show.
- `@pyric/live/register: firebase-admin/<service> loads unobserved.`: the backend loaded an Admin
  service no row serves, such as Remote Config. Its calls go to production with the backend's
  credential and make no row.
- The live host's `GET <url>/__pyric/health` lists its own process's hosts in `live.unobserved`.
  Each connected Node backend's entry in `live.clients` (`kind: "node"`) carries the backend's
  own `unobserved`, `unobservedAdmin` and `gatedAdmin` lists, each absent when empty. The backend
  sends them as they change, so they arrive a moment after its calls. You can also ask the
  backend itself, from this machine, with the process health header:

  ```sh
  curl -s -H 'x-pyric-process-health: 1' http://localhost:<backend port>/__pyric/health
  ```

  The answer is `{ "pyricProcess": { "mode": "live", "projectId": ..., "unobserved": [...],
  "unobservedAdmin": [...], "gatedAdmin": [...] } }`, each list absent when empty. A backend with
  `PYRIC_PROCESS_HEALTH=off` doesn't answer, and the request reaches the app.

## What a refusal means

A refusal stopped a call before it left, so nothing reached production for it. Tell the developer
what was refused and what to change:

- **`PYRIC_LIVE_REFUSED` naming another project.** The backend's `firebase-admin` app, or one of
  `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT` or `FIREBASE_CONFIG`, names a project other than the
  live host's. Point the app at the live project, or start live mode for the other project. Never
  change the project yourself.
- **`PYRIC_LIVE_REFUSED` naming a Realtime Database instance.** The instance isn't one live mode
  can tell is the project's. If it is the project's, the owner adds it to firebase.json's
  `database` list and starts again.
- **`PYRIC_LIVE_REFUSED` naming Node 23.** The backend runs on Node 22. Restart it on Node 23 or
  later.
- **`PYRIC_LIVE_REFUSED` on an import.** Live mode doesn't serve that Firebase import. The app can
  list it in `passThrough`, unobserved, or run without `@pyric/live`.
- **`PYRIC_MODE_MISMATCH`.** The page and the backend are in different modes: a sandbox token
  reached a live backend, or a production token reached a sandbox backend. Start both in the same
  mode.
- **A proxy check warning at dev server start.** A `server.proxy` target is in another mode, on
  another project, or not under pyric. It is a warning, not a refusal. Report the verdict from
  `proxyTargets`.

## When something breaks

- Capture the start line, the host's terminal output, the steps, and the npm version or the
  `<pyric>` commit. For a host, add the `live` field of `GET <url>/__pyric/health`.
- Do not share document contents, tokens, API keys, or the email addresses and phone numbers used.
- Do not retry a write, sign-up or email to get unstuck. Each attempt is real and billed.
