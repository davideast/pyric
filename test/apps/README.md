# App scenarios

Each directory here is a plain user project: a `package.json`, a `vite.config.js`, `firebase.json`, `.firebaserc`, rules files, a page, and sometimes a server script. Each one also has a `scenario.ts` that drives it. The runner installs the app the way a user does and runs the scenario against real processes:

- **Install.** The app is copied to a temporary directory and installed with `npm install`. The Pyric packages come from packed tarballs (`scripts/pack-packages.sh`), never from workspace sources. `firebase`, `firebase-admin`, and `vite` come from the npm registry at the versions the app's `package.json` names.
- **Host.** The app's own Vite dev server runs as a child process on a free port.
- **Server.** Server scripts run as `node --import @pyric/cli/register <script>` from the app directory.
- **Browser.** Pages open in Playwright Chromium. Requests to any host other than `127.0.0.1` or `localhost` are aborted unless the scenario answers them with a route, so no scenario reaches a Google or Firebase production endpoint.

Every app process gets a fresh `HOME` and no inherited credentials or API keys.

These live at the repository root, not under a package, because each app exercises several published packages together (`@pyric/cli`, `pyric-admin`, `pyric`) as one installed project.

## Run them

```sh
bun test/apps/run.ts                       # every app, 3 at a time
bun test/apps/run.ts hosted-dev-server-restart
bun test/apps/run.ts --build               # rebuild the workspace before packing it
bun test/apps/run.ts --packages dist/packages   # install these tarballs instead of packing
bun test/apps/run.ts --keep                # keep each installed app directory
bun test/apps/run.ts --skip-slow           # leave out the slow apps
bun test/apps/run.ts --only-slow           # run only the slow apps
```

A scenario that waits on real timeouts, such as a liveness window, marks itself slow next to its default export:

```ts
export const slow = true;
```

Build & Test runs the app scenarios with `--skip-slow`, on pull requests and on main. The Slow app scenarios workflow (`.github/workflows/slow-scenarios.yml`) runs them with `--only-slow` on pushes to main, nightly, on demand, and on a pull request when the `ci-slow-scenarios` label is added. An app named on the command line runs whether or not it is slow. The runner imports each `scenario.ts` to read the marker before installing anything, so a scenario imports only the driver, Playwright, and node built-ins at its top level.

npm downloads are cached in `~/.cache/pyric-app-scenarios-npm` (set `PYRIC_APPS_NPM_CACHE` to move it), so a second run installs in seconds. Apps whose package.json names the same packages share one `npm install` per run, hard-linked into each app's `node_modules`. An app whose install runs its own scripts or links its own directories installs alone. When the cached package listings are older than a version a dependency asks for, npm fails with `ETARGET` or `ENOVERSIONS`, and the runner retries that install once with `--prefer-online`. Without `--packages`, the runner packs the current workspace build. Run `bun run build` first, or pass `--build`. Install Chromium once with `bunx playwright install chromium`.

A failure names the app and the step, and prints the dev server log, each server script's output, and the browser console. Full logs are saved to `test-results/apps/<name>/`.

## Add an app from a bug report

1. Create `test/apps/<name>/`, named for the behavior, and copy the report's files into it unchanged.
2. Add the dependencies the report used to `package.json`. Any version works for Pyric packages (`"@pyric/cli": "*"`): the runner installs the packed tarball.
3. Write `scenario.ts`. Each `app.step` names what the app should see, and its assertions use `node:assert/strict`:

   ```ts
   import assert from 'node:assert/strict';
   import { scenario } from '../driver.ts';

   declare function readStatus(): Promise<unknown>;

   export default scenario(async (app) => {
     const host = await app.step('start the hosted dev server', () => app.devServer());
     await app.step('the server script writes status', () =>
       app.serverScript('server.mjs', ['ok'], { env: { PYRIC_SANDBOX: `remote:${host.url}` } }));
     await app.step('the page reads it', async () => {
       const page = await app.page(host.url);
       await page.waitForFunction(() => 'readStatus' in window);
       assert.equal(await page.evaluate(() => readStatus()), 'ok');
     });
   });
   ```

4. Run `bun test/apps/run.ts <name>` against a build without the fix and confirm the scenario fails at the step that shows the bug. Then confirm it passes with the fix.

The dev server port comes from the command line, which overrides any `server.port` in the app's Vite config, so a report's config file can stay as written.

## The driver

`driver.ts` gives a scenario these helpers:

| Helper | What it does |
|---|---|
| `app.devServer({ env, port })` | Starts `vite` from the app's `node_modules` on a free port, or on `port`, and waits until `/` and `/__pyric/init.json` answer. Returns `{ url, port, process }`. Pass the port of a stopped server to bring a host back on the same URL. |
| `app.serverScript(script, args, { env })` | Runs the script under `node --import @pyric/cli/register` until it exits. Throws on a non-zero exit. |
| `app.pyric(args, { env })` | Runs the installed `pyric` command to exit and returns its exit code and output. |
| `app.pyricProcess(args, { env })` | Starts the installed `pyric` command and returns at once, for a command that runs until stopped, such as `pyric sandbox -- next dev`. |
| `app.command(command, args, { cwd, env, timeoutMs })` | Runs a command a user types, such as `npm run dev` or `node node_modules/create-pyric/dist/bin.js`, from `cwd` inside the app directory until it exits. Returns the exit code and output rather than throwing. |
| `app.installProject(path)` | Installs a project the scenario created in the app directory, such as one `create-pyric` scaffolded: its Pyric dependencies point at the packed tarballs, then `npm install` runs in it. |
| `app.page(url)` | Opens a page in the app's browser context. |
| `app.browser()` | The app's browser context, for routes that answer external requests. |
| `process.waitForLog(pattern, { since })` | Waits for a log line. `process.mark()` gives the `since` offset. |
| `app.readFile` / `app.writeFile` | Read or edit a file in the installed app, for example `vite.config.js`. |
| `app.freePort()` | A port nothing listens on. |
| `app.blackholedPort()` | A port whose connects never complete and never refuse, as a closed port behaves under WSL mirrored networking. |
| `app.browserLog` | Every page's console lines, page errors, and error responses so far, for asserting what a user would see in the console. |
| `app.expectHostError(pattern)` | Allows a page request to a `/__pyric/` route to answer with an error, matched against `"<status> <method> <path>?<query>"`. |

`process.stop()` sends SIGTERM to the process group, then SIGKILL after 5 seconds. A process that still has not closed 5 seconds after that, such as one whose pipes another process holds open, is recorded as gone with a note in its log, so a step and the run's teardown never wait on it longer. When a spawn fails with `EBADF` before the process writes any output, which Bun's `spawn` does now and then under concurrency (#997), the driver starts it once more and says so in its log.

A page request that a `/__pyric/` route answers with a 4xx or 5xx status fails the app after its scenario finishes, even when every step passed. A user sees those errors in the browser console on every page load, so a scenario that triggers one on purpose, such as a download URL with the wrong token, declares it with `app.expectHostError` just before the request.
