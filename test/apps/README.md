# App scenarios

Each directory here is a plain user project: a `package.json`, a `vite.config.js`, `firebase.json`, `.firebaserc`, rules files, a page, and sometimes a server script. Each one also has a `scenario.ts` that drives it. The runner installs the app the way a user does and runs the scenario against real processes:

- **Install.** The app is copied to a temporary directory and installed with `npm install`. The Pyric packages come from packed tarballs (`scripts/pack-packages.sh`), never from workspace sources. `firebase`, `firebase-admin`, and `vite` come from the npm registry at the versions the app's `package.json` names.
- **Host.** The app's own Vite dev server runs as a child process on a free port.
- **Server.** Server scripts run as `node --import @pyric/cli/register <script>` from the app directory.
- **Browser.** Pages open in Playwright Chromium, and no scenario reaches a Google or Firebase production endpoint. Requests to any host other than `127.0.0.1` or `localhost`, including those a service worker makes, are aborted and logged in `app.browserLog` unless the scenario answers them with `route`. A page WebSocket to another host is closed before it opens, and logged, unless the scenario answers it with `routeWebSocket`. Chromium also launches with host resolver rules that leave only `localhost`, `127.0.0.1` and `::1` resolvable. No route sees a SharedWorker's requests or a WebSocket that any worker opens, so those are blocked by name resolution alone, with no line in `app.browserLog`. A scenario that launches its own browser uses `launchScenarioBrowser(options)` and calls `guardContext` on each context it opens, as `host-closes-silent-page` does. The driver's own tests for this are in `driver-network.test.ts`.

Every app process gets a fresh `HOME` and no inherited credentials or API keys.

## How the scenario browser differs from a user's Chrome

**The HTTP cache is off.** `guardContext` routes every request (`context.route`), and Playwright turns off the browser's HTTP cache in any context with a route. That covers `app.browser()`, every page `app.page()` opens, and each context a scenario guards itself. Every load fetches every module in full, so a bug that needs the cache, such as a stale Pyric runtime module after a dev server restart, a wrong 304, or the SDK loading twice, cannot show there. `hosted-dev-server-restart` also opens a page in a second browser that has the resolver rules and no route, so its cache stays on. It first proves the rules alone keep that browser on loopback: a fetch and a WebSocket from the page and from a dedicated worker, to names and addresses the rules do not exclude, never reach a listener on every local address. Then it checks that the page, reloaded across the restart, runs the new host generation's modules.

**Playwright's default Chromium switches.** Playwright 1.62.0 (`chromiumSwitches` in `playwright-core`) launches every scenario browser with these, so a scenario sees none of what they turn off unless it passes them to `ignoreDefaultArgs`:

| Switch | What a user's Chrome does that the scenario browser does not |
|---|---|
| `--disable-background-timer-throttling` | Throttles timers in hidden tabs: at most once a second, and about once a minute for timer chains after five minutes hidden |
| `--disable-renderer-backgrounding` | Lowers the priority of renderers for background tabs |
| `--disable-backgrounding-occluded-windows` | Treats a covered or minimized window as hidden |
| `--disable-back-forward-cache` | Keeps a page in the back-forward cache when it navigates away, with its socket open |
| `--disable-ipc-flooding-protection` | Limits how fast a page can call navigation and history APIs |
| `--disable-hang-monitor` | Offers to stop a page that stops responding |
| `--disable-popup-blocking` | Blocks popups a page opens without a user gesture |
| `--disable-prompt-on-repost` | Asks before resubmitting a form on reload |
| `--allow-pre-commit-input` | Drops input before a page first paints |
| `--disable-background-networking` | Makes background requests such as component updates and safe browsing lists |
| `--disable-field-trial-config` | Runs Chrome's field trial features |
| `--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion` | Among these: upgrades `http` navigations to `https`, holds paint across same-origin navigations, and partitions third-party storage by top-level site |
| `--enable-features=CDPScreenshotNewSurface` | Nothing; it changes how CDP takes screenshots |
| `--disable-breakpad`, `--disable-client-side-phishing-detection`, `--disable-component-extensions-with-background-pages`, `--disable-component-update`, `--no-default-browser-check`, `--disable-default-apps`, `--disable-dev-shm-usage`, `--disable-edgeupdater`, `--disable-extensions`, `--disable-updater-scheduler`, `--force-color-profile=srgb`, `--metrics-recording-only`, `--no-first-run`, `--password-store=basic`, `--use-mock-keychain`, `--no-service-autorun`, `--export-tagged-pdf`, `--disable-search-engine-choice-screen`, `--unsafely-disable-devtools-self-xss-warnings`, `--edge-skip-compat-layer-relaunch`, `--disable-infobars`, `--disable-sync` | Crash reports, phishing checks, extensions, updates, first-run and sign-in prompts, sync, and the color profile, none of which a scenario page reads |
| `--headless`, `--hide-scrollbars`, `--mute-audio`, `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4` | Added for headless: no window, no scrollbars, no sound, and a page that reports hover and a fine pointer |
| `--no-sandbox` | Runs renderers in Chromium's sandbox; Playwright leaves it out unless `chromiumSandbox` is set |

The driver adds `--host-resolver-rules` (above). Playwright also turns on CDP focus emulation for every page it drives, which holds the page visible: a tab another tab covers still reports `document.visibilityState === 'visible'`, and Chromium does not throttle it even without the switches. `host-closes-silent-page` restores the back-forward cache with `ignoreDefaultArgs`. A tab opened over CDP in a browser context Playwright does not manage gets no focus emulation, so with the three throttling switches dropped it is hidden and throttled as in Chrome.

These live at the repository root, not under a package, because each app exercises several published packages together (`@pyric/cli`, `pyric-admin`, `pyric`) as one installed project.

## Run them

```sh
bun test/apps/run.ts                       # every app, longest first, as many at once as the load allows
bun test/apps/run.ts hosted-dev-server-restart
bun test/apps/run.ts --build               # rebuild the workspace before packing it
bun test/apps/run.ts --packages dist/packages   # install these tarballs instead of packing
bun test/apps/run.ts --keep                # keep each installed app directory
bun test/apps/run.ts --jobs 2              # run 2 apps at a time
bun test/apps/run.ts --skip-slow           # leave out the slow apps
bun test/apps/run.ts --only-slow           # run only the slow apps
```

A scenario that waits on real timeouts, such as a liveness window, marks itself slow next to its default export:

```ts
export const slow = true;
```

Build & Test runs the app scenarios with `--skip-slow`. On main, nightly, in a merge group, and on a pull request labeled `ci-full` or `ci-slow-scenarios`, it runs every one. On any other pull request it runs only the scenarios whose files under `test/apps/<name>/` the pull request changes and the `test/apps/<name>` scenarios its body names, as the body reads when the run starts; a change to the runner or another shared file under `test/apps`, or to `build.yml`, runs every one. With none selected, the app scenario jobs skip. The Slow app scenarios workflow (`.github/workflows/slow-scenarios.yml`) runs the slow ones with `--only-slow` on pushes to main, nightly, on demand, and on a pull request when the `ci-slow-scenarios` label is added. An app named on the command line runs whether or not it is slow. The runner imports each `scenario.ts` to read the marker before installing anything, so a scenario imports only the driver, Playwright, and node built-ins at its top level.

A scenario that runs longer than the runner's 300 s limit by design exports `timeoutMs` next to `slow`. The long-session soak (`long-session-soak`) does: it uses a scaffolded web template on the Node host for `SOAK_MINUTES` (default 60) with a seeded script (`SOAK_SEED`), checks the app's state against the script's model every few minutes, and fails on a crash, an error page, a state that does not match, steady memory growth in a page load or a dev server process, or a dev server process of 10 minutes or more whose memory does not level off. It makes no restart in the first 60% of the run, so the hour has one such process. A failure names the seed, the action index and the last 20 actions, and the action log and memory samples are saved in `test-results/apps/long-session-soak/`. The slow workflow runs it for 5 minutes; its `soak` job runs the hour nightly, and on demand with `soak_minutes` (and `soak_seed` to replay a failure). Its seeded parts are tested in `soak.test.ts`.

On CI the apps run in shards. The plan job runs `bun test/apps/shard-plan.ts plan --apps <file>`, with the selection `scripts/ci/plan.ts` wrote, which groups the apps by dependency set and packs them into shards whose App scenarios step should take about 90 s, at most 7, by the times main's last run recorded. An app with no recorded time is planned at the longest recorded time. Each App scenarios job runs `bun test/apps/run.ts --skip-slow --shard-plan <file> --shard <n>`: the runner first checks that the plan names exactly the apps an unsharded run would select (for a pull request's selection, only such apps), then runs shard `n` and writes the apps it ran to `test-results/app-shards/`. `CI / required` runs `shard-plan.ts check`, which fails unless the shards together ran every planned app exactly once, and on main it saves the merged times for the next plan.

npm downloads are cached in `~/.cache/pyric-app-scenarios-npm` (set `PYRIC_APPS_NPM_CACHE` to move it), so a second run installs in seconds. Apps start longest first, by the times the last run recorded in `test-results/app-durations.json`; an app with no recorded time starts before the rest. Without `--jobs`, a local run takes one app per four free CPU threads, at most 6, and CI takes one per runner thread. Apps whose package.json names the same packages share one `npm install` per run, copied into each app's `node_modules`. An app whose install runs its own scripts or links its own directories installs alone. When the cached package listings are older than a version a dependency asks for, npm fails with `ETARGET` or `ENOVERSIONS`, and the runner retries that install once with `--prefer-online`. Without `--packages`, the runner packs the current workspace build. Run `bun run build` first, or pass `--build`. Install Chromium once with `bunx playwright install chromium`.

Every run, including one of named apps, is a heavy run, and so is `bun run test`. At most two heavy runs go at once on one machine, across all worktrees: each takes a slot in `~/.cache/pyric/heavy-runs/` before it samples the load, and a third waits until one finishes, printing which runs hold the slots. `PYRIC_HEAVY_RUN_SLOTS` changes the count. Targeted runs such as `bun test <file>` never wait for a slot.

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
| `app.devServer({ env, port, cwd })` | Starts `vite` from the app's `node_modules` on a free port, or on `port`, and waits until `/` and `/__pyric/init.json` answer. Returns `{ url, port, process }`. Pass the port of a stopped server to bring a host back on the same URL. Pass `cwd` to run a project the scenario created inside the app directory, from its own `node_modules`. |
| `app.sandboxServer({ env, port })` | Starts the installed `pyric sandbox --no-run` on a free port, or on `port`, from the app directory, and waits until `/` and `/__pyric/init.json` answer. It serves `firebase.json`'s `hosting.public` directory through the import map, with no Vite. Returns `{ url, port, process }`. |
| `app.serverScript(script, args, { env })` | Runs the script under `node --import @pyric/cli/register` until it exits. Throws on a non-zero exit. |
| `app.pyric(args, { env })` | Runs the installed `pyric` command to exit and returns its exit code and output. |
| `app.pyricProcess(args, { env })` | Starts the installed `pyric` command and returns at once, for a command that runs until stopped, such as `pyric sandbox -- next dev`. |
| `app.command(command, args, { cwd, env, timeoutMs })` | Runs a command a user types, such as `npm run dev` or `node node_modules/create-pyric/dist/bin.js`, from `cwd` inside the app directory until it exits. Returns the exit code and output rather than throwing. |
| `app.commandProcess(command, args, { cwd, env })` | Starts a command and returns at once, as `serverProcess` does, for one that runs until stopped, such as `node node_modules/.bin/pyric-live`. |
| `app.installProject(path)` | Installs a project the scenario created in the app directory, such as one `create-pyric` scaffolded: its Pyric dependencies point at the packed tarballs, then `npm install` runs in it. |
| `app.page(url)` | Opens a page in the app's browser context. |
| `app.browser()` | The app's browser context, for routes (`route`, `routeWebSocket`) that answer external requests and WebSockets. |
| `process.waitForLog(pattern, { since })` | Waits for a log line. `process.mark()` gives the `since` offset. |
| `app.readFile` / `app.writeFile` | Read or edit a file in the installed app, for example `vite.config.js`. |
| `app.freePort()` | A port nothing listens on. |
| `app.blackholedPort()` | A port whose connects never complete and never refuse, as a closed port behaves under WSL mirrored networking. |
| `app.browserLog` | Every page's console lines, page errors, and error responses so far, for asserting what a user would see in the console. It also holds a line for each blocked external request (`[blocked external request]`) and WebSocket (`[blocked external WebSocket]`). |
| `app.expectHostError(pattern)` | Allows a page request to a `/__pyric/` route to answer with an error, matched against `"<status> <method> <path>?<query>"`. |
| `app.expectLeftoverProcess(pattern)` | Allows a process an app process started to outlive it, matched against the leftover's command name. |
| `app.noteErrorResponse(status, method, url)` | Counts an error response to a page the scenario opened in a browser it launched itself, as `app.page()` counts its own. |

`process.stop()` sends SIGTERM to the process group, then SIGKILL after 5 seconds. A process that still has not closed 5 seconds after that, such as one whose pipes another process holds open, is recorded as gone with a note in its log, so a step and the run's teardown never wait on it longer. When a spawn fails with `EBADF` before the process writes any output, which Bun's `spawn` does now and then under concurrency (#997), the driver starts it once more and says so in its log.

A page request that a `/__pyric/` route answers with a 4xx or 5xx status fails the app after its scenario finishes, even when every step passed. A user sees those errors in the browser console on every page load, so a scenario that triggers one on purpose, such as a download URL with the wrong token, declares it with `app.expectHostError` just before the request. A pattern that matched no error fails the app too, as does an `expectLeftoverProcess` pattern that matched no leftover and an `expectedCrashes` entry that matched no crash, so an allowance cannot outlive what it describes. An error that comes only in some runs, such as one a race decides, passes `{ mayNotHappen: '<why, with its issue>' }`, and only then may its pattern match nothing. The driver refuses a reason that is blank or cites no issue (`#<number>`). Remove the `mayNotHappen` when its issue closes.

## Recorded production (`replay/`)

`replay/` plays production Firebase for the real `firebase` web SDK, so a scenario can run an app as if it talked to production while nothing reaches Google. It holds harness code only, no scenario.

| File | What it does |
|---|---|
| `server.ts` | `startReplayServer(recordings)` answers Firestore's Listen and Write streams over WebChannel and the Auth REST calls a sign-in makes, on `127.0.0.1`. A request no recording answers is refused (a listener or write fails with `failed-precondition` naming it, Auth answers `PYRIC_REPLAY_NO_RECORDING`) and listed in `server.unmatched`; every request is listed in `server.received`. It also takes the paths the SDK's own `connectAuthEmulator` and `connectFirestoreEmulator` build, so an app that points its SDK at a local backend reaches it unchanged. With `{ grpc: { projectDir } }` it answers the Node build's gRPC streams too (`grpc.ts`). |
| `grpc.ts` | Firestore's Listen and Write over gRPC, from the same proto3 JSON recordings: a `@grpc/grpc-js` server with the protos the Firestore Node build installed in `projectDir` carries, converting each message both ways. Every other Firestore RPC is answered `UNIMPLEMENTED` and listed in `unmatched`. |
| `serve.ts`, `process.ts` | `startReplayProcess(recordings, projectDir)` runs the server in a `node` process (Bun's HTTP/2 server resets grpc-js streams) and reads `/__replay/received` and `/__replay/unmatched` from it. A scenario starts it with `app.commandProcess('node', replayServerArgs(...))`. `--rtdb-capture <project>` (`{ rtdbCapture: project }` in either function) also serves RTDB capture A for that project, so the Node and browser builds of `firebase/database` reach it on `/.ws` with `connectDatabaseEmulator`; `rtdb-node.test.ts` runs the Node build against it. `--storage-capture <project>` (`{ storageCapture: project }`) also serves Storage capture S for that project, on its default bucket and on `<project>-live-second`, which gets the default bucket's answers, so `connectStorageEmulator` reaches it; `storage-capture.test.ts` runs the Node build against it. `/__replay/received` lists Firestore and Auth requests, then every frame RTDB clients sent but the keepalive, each `{ rpc: 'rtdb', as, message: { instance, frame } }`. |
| `seam.ts` | `routeFirebaseTo(origin)` wraps `globalThis.fetch` so requests for `firestore.googleapis.com`, `identitytoolkit.googleapis.com` and `securetoken.googleapis.com` go to the server, and refuses every other host that is not loopback. Install it before the SDK loads. The app's code does not change. |
| `format.ts` | The recorded-exchange file (`pyric-replay/1`). Server-issued values (ID and refresh tokens, read and commit times, resume tokens, target ids) are `{ "$": "<name>" }` placeholders the server fills in; `{ "$": "any" }` matches any request value, and `{ "$": "idToken", "uid": ... }` in an Auth request matches a token the server minted for that uid, so two accounts replay apart. `readRecording` refuses a file with a JWT, an API key, a real read time, or a document outside its project. |
| `recorder.ts`, `record.ts` | A forwarder that relays a real run unchanged and returns what it saw as a recording. `bun test/apps/replay/record.ts --project <test-project> --out <file> <run.ts>` is the only entry point that reaches Google: run it by hand, against a test project only. It refuses when `CI` or `GITHUB_ACTIONS` is set (`record-guard.ts`). |
| `sdk.ts` | Loads `firebase/app`, `firebase/auth`, and Firestore's browser build, which uses the same WebChannel transport in Node as in a page. |
| `fixtures/rooms.json` | Hand-written from the SDK's wire format: a sign-in, a read, a denied read, a query listener that a write updates, a write and a denied write. |
| `fixtures/live-mode-traffic.json` | Hand-written, not captured from production yet: two accounts, each with a sign-in, a read, a denied read, a query listener its write updates, and a write. `live-mode-traffic` replays it. `fixtures/live-mode-traffic.run.ts` is the run that records it from a test project, by hand, with `record.ts`; its comment says what the project must hold. |

The tests drive the real SDK through all of it with the network off:

```sh
unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay'
```
