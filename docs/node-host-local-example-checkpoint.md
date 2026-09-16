# Node-host local example checkpoint

Verified September 15, 2026, in `/tmp/pyric-hosted-main-integration` on
`hosted-main-integration`. Main's new Orbit example, commit `f7e90081` (#652),
is included by merge `3430b5fe`. The original `hosted-live-mode` checkout was
not modified by this integration work.

This is functional verification, separate from the outstanding RSS stress budget.
Servers ran sequentially. Browser checks used temporary Chromium contexts that
closed in `finally`; no model keys, cloud deployment, or native emulators were needed.
All servers started for this pass were stopped, and the final process check found
no remaining owned example or Next.js servers. The fixes and checkpoint files are
local changes on the integration branch; they have not been pushed.

## Results

| Application | Node-host result | Observed behavior |
| --- | --- | --- |
| `examples/teams-workspace` (Orbit) | Passed through the CLI and normal Vite dev script | Seeded email/password login; seeded conversation; cross-context typing, messages, reactions and replies; file upload and recipient download; expected Firestore and RTDB denials. Both independent browser contexts reported `hosted`. |
| `examples/vite-sandbox-app` | Passed as a CLI-served application build | Signed-out denial; Google test-provider sign-in; write and listener delivery; user/data restored after reload. Runtime reported `hosted`. |
| `examples/ai-chat` | Passed | Scripted streamed response and weather function-call round trip. Runtime reported `hosted`. No external model call. |
| `examples/nextjs-sandbox-app` | Passed through its real Next dev server | Signed-out denial; Google test-provider sign-in; browser write/listener; reload restoration. `/api/status` returned `{"status":"ok","environment":"pyric-sandbox","count":1}` after the browser write. Runtime reported `hosted`. |
| `packages/studio` | Passed focused integration checks | Orbit's collections, seeded Auth users, RTDB paths and uploaded Storage objects are visible. A user created in Playground appears in Studio. |
| `packages/playground` | Passed after fixes | Session creation; Node seed users in Auth; creating an Auth user propagates to Studio; editing App.tsx compiles a preview that signs in as the Node-seeded David account. Check explicitly throws on any SharedWorker construction. |

The initial Orbit and Vite-reference checks used application builds with
canonical `firebase/*` imports left external, served by `pyric sandbox --hosted`.
Orbit was subsequently verified through its normal Vite dev script with the new
`pyric({ hosted: true })` selection. Next.js uses its existing `withPyric`
integration and the CLI child runner.

Google provider sign-in requires enabling the sandbox's Google provider first.
The tests did that on the Node host and completed the local account picker.
Without this configuration, provider rejection is expected.

The Playground AI agent showed its expected missing-key error; AI generation,
cloud account sign-in, GitHub import/publish, Firebase deployment, and long-running
inference were not tested. Orbit's Ollama configuration was not carried into the
CLI checkpoint, and its assistant/model integration was not tested. Next emitted
a Webpack dynamic-dependency warning for `flow-treatments/controller.js`; changing
Flow treatments in Next is not covered by this pass.

## Bugs found and fixed

1. **Seeded Auth disappeared behind restored Firestore data.** Persisted state
   fixtures restore documents before Auth initialization. The existing-data guard
   then skipped the separate Auth section. Initialization now restores missing
   persisted accounts without replacing existing accounts. The regression checks
   actual password login, preservation of existing accounts, and repeated init.
2. **Hosted attachment downloads received JSON instead of a Blob.** `getBlob`
   used a MessagePort-only operation. It now reconstructs a Blob from the existing
   base64 byte-read operation, including its content type. `getDownloadURL` works
   across browser contexts. SharedWorker uses the same tested path.
3. **Playground's bundled session-list listener crashed.** Rollup removed an
   implicit listener-registration side effect. The modular listener module now
   explicitly imports the registration it depends on. A minimal Vite/Rollup
   browser-bundle regression reproduces the original `onSnapshot is not a function`
   error and now passes.
4. **Playground shared mode ignored the Node host.** It now honors the same host
   declaration Studio uses, preserving the SharedWorker default when absent.
   Its HTML also identifies its bundled sandbox runtime so the CLI does not
   inject a second runtime into the page. Its local session metadata remains
   separate from the shared workspace sandbox.

5. **Automatic Auth IDs collided after host restart.** The counter restarted at
   `user-1` even when persisted accounts already used that ID. Automatic allocation
   now skips occupied IDs. Existing accounts retain their credentials, and explicit
   duplicate IDs still fail. The saved Playground checkpoint reproduces this across
   an actual host restart and now verifies creation without overwriting accounts.

Focused validation: 47 Auth administration / UID tests, 39 initialization tests,
20 worker/Storage tests, 30 session /
mode / listener-attribution tests, one Rollup browser-bundle regression, and one
real hosted Storage browser regression. The last two took approximately 0.9 and
2.8 seconds respectively. Pyric and CLI production TypeScript builds and hosted
browser-fixture typechecking passed. Studio/site and Playground builds succeeded.
These counts exclude the application workflow scripts above.

## Run Orbit or another compatible plain web example

The integration checkout already has dependencies and compiled packages. Use Node
22.15 or newer. From that checkout:

```sh
cd /tmp/pyric-hosted-main-integration
pyric_repo="$PWD"
pyric_example=$(node scripts/prepare-hosted-example.mjs teams-workspace)
cd "$pyric_example"
node "$pyric_repo/packages/cli/dist/cli/index.js" sandbox \
  --hosted --seed seed.json --no-open --no-watch --no-capture --port 5217
```

Open `http://localhost:5217/`. Sign in as `david@orbit.example` with password
`orbit-demo`. In another browser/profile sign in as `alice@orbit.example` with
that password. Send a message, reply, react, type, and attach a small text file.
Both pages should update and the recipient should be able to download the file.
Open **Demo scenarios** and run **Denied Firestore write** and **Denied RTDB write**;
both should report a rules rejection. Open `http://localhost:5217/__pyric/ui/auth`
and verify the same four seeded users. Studio's RTDB and Storage views should show
activity from the app. Stop this server with Ctrl+C before starting another.

For the small Vite reference or AI chat, substitute `vite-sandbox-app` or `ai-chat`
in the preparation command and **omit `--seed seed.json`**. Use port 5220 or 5221.
For AI chat, send `hello`, then press **Weather tool demo**. Expect a scripted
streamed greeting and the Lisbon weather round trip.

For the Google sign-in examples, the following local-only control command enables
Google on the running host. Run it from the integration checkout, adjusting port:

```sh
node --input-type=module <<'JS'
import { connectRemoteSandbox } from './packages/cli/dist/remote/index.js';
const control = await connectRemoteSandbox({ url: 'http://localhost:5220' });
try {
  await control.channel.op({
    method: 'auth.setProviderConfig', providerId: 'google.com', enabled: true,
  });
} finally {
  control.close();
}
JS
```

Then press **Sign in with Google**, enter a test email and display name in the
sandbox dialog, and submit it. Create a post and reload; the user and post should
remain. Signing out and attempting another write should be denied.

The preparation helper creates a disposable project outside the source checkout,
uses that project's root as its static hosting directory, and omits prior state,
dependency directories and environment files. Firebase configuration values in
compiled example code use their demo defaults. The helper does not start a process.

## Run Next.js

From the integration checkout (stop the previous example first):

```sh
pyric_repo="$PWD"
cd examples/nextjs-sandbox-app
node "$pyric_repo/packages/cli/dist/cli/index.js" sandbox \
  --hosted --no-open --no-watch --no-capture --port 5222 -- \
  node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 5223
```

Open `http://localhost:5223/`. Enable Google on **5222** using the preceding
control command, then complete the account picker and add a post. Reload.
Open `http://localhost:5223/api/status`: the sandbox Admin API should count the
post written by the browser. The first Next page compilation took approximately
20 seconds during this pass; subsequent loads were fast. Ctrl+C stops the host
and its owned dev child.

## Run Playground with Studio

Build the current Playground, then prepare a separate host directory. This is a
local static checkpoint; it does not run Playground's deployment build script.

```sh
cd /tmp/pyric-hosted-main-integration
pyric_repo="$PWD"
(cd packages/playground && bun node_modules/astro/astro.js build)
pyric_playground=$(mktemp -d /tmp/pyric-playground-checkpoint.XXXXXX)
mkdir "$pyric_playground/public"
cp -R packages/playground/dist/client/. "$pyric_playground/public/"
cp examples/teams-workspace/seed.json "$pyric_playground/seed.json"
printf '%s\n' '{"hosting":{"public":"public"}}' > "$pyric_playground/firebase.json"
cd "$pyric_playground"
node "$pyric_repo/packages/cli/dist/cli/index.js" sandbox \
  --hosted --seed seed.json --no-open --no-watch --no-capture --port 5219
```

In a second terminal:

```sh
cd /tmp/pyric-hosted-main-integration
node packages/playground/scripts/hosted-checkpoint.mjs http://localhost:5219
```

The script opens a temporary browser, forbids SharedWorker creation, creates a
local session, checks the seeded users, creates a new local test user, confirms
it in Studio, edits App.tsx through the real editor, and signs in from its compiled
preview. It closes the browser unconditionally. Two `PASS` messages and exit 0
are required. It saves `pyric-playground-hosted-checkpoint.png` in the system
temporary directory. The host remains running until Ctrl+C.

For hands-on testing open `http://localhost:5219/?sandbox=shared`, enter any prompt,
and start a session. A missing-model-key error is expected. Open **Firebase → Auth**
to inspect the shared users, and compare with `http://localhost:5219/__pyric/ui/auth`.
**Isolated session** intentionally selects Playground's separate in-page runtime.

## Not included in the Node-host pass

- `inpage-todo-app`: directly owns `SandboxSimulationDriver` and local sandbox
  handles; it is an in-page architecture example, not a Firebase-import swap app.
- `runtime-flow-lab`: its main app explicitly owns an in-page runtime, and its
  separate SDK server selects in-page or SharedWorker. Neither advertises a
  Node-host selection. Orbit supplies the multi-service hosted app check here.
- `admin-playground`: a UI component showcase with local fixture sandboxes and
  replayed traffic, not the production Studio application. Actual Studio was tested.
- Android, Swift and Flutter examples: native-client examples, outside this web
  compatibility pass. Their Node protocol compatibility is **not established**;
  no expensive native builds or simulators were started.

## Vite Node-host selection

The plugin now accepts `pyric({ hosted: true })`. SharedWorker remains the default.
Hosted mode reuses the CLI's Node runtime, bridge, durable state and rules reload;
it does not build a SharedWorker or silently fall back to one. Studio receives the
same host selection. Middleware mode is rejected explicitly, and production
builds keep Firebase.

From this integration checkout, with Node 22.15 or later on `PATH`:

```sh
cd /tmp/pyric-hosted-main-integration
TEAMS_HOSTED=1 bun run --cwd examples/teams-workspace dev
```

Open `http://localhost:5217` in two browsers. Sign in as `david@orbit.example`
and `alice@orbit.example`, both with password `orbit-demo`. Type and send a
message; add a reaction and reply from the other browser; attach a text file and
open it from the recipient. Open `/__pyric/ui/firestore` and `/__pyric/ui/auth`
to inspect the shared workspace and users. These checks passed through the real
Vite pipeline. Stop the server with Ctrl+C. Omit `TEAMS_HOSTED` for SharedWorker.

Focused automated checks passed:

- Four real-Vite browser/lifecycle tests in 7.2 seconds: cross-context writes,
  capture, rules denial after reload, persisted restart, default SharedWorker,
  explicit middleware rejection, exclusive ownership and release on close.
- 48 Vite configuration, generation, Functions and build-selection tests in
  11.54 seconds. Hosted selection does not activate the production-build swap.
- CLI production and hosted-browser-test TypeScript checks.

The Orbit verification server was stopped and its port was confirmed closed.
The RSS stress threshold remains a separate release gate.

## Overview and Flow startup verification

The React diagnostic hook now registers synchronously before application modules.
The Vite and CLI HTML paths share that bootstrap, and chip initialisation wraps
the existing hook after sandbox setup. Existing DevTools hooks are preserved.
Overview explains when recorded sources have no identified page regions; the
message clears when regions become available.

Verification:

- The browser regression failed with Flow disabled in both Node and SharedWorker
  modes before the fix.
- Four real-Vite browser cases passed in 15.8 seconds: both host modes, each with
  and without an existing DevTools hook. Each checks delayed init, Overview boxes,
  Flow painting after a real Firestore write, HMR and page reload. The DevTools
  cases also check that the existing hook identity and commit handler survive.
- 74 focused tests passed in 3.19 seconds, including the Overview explanation,
  hook lifecycle, overlay, HTML injection and Vite page setup.
- CLI production and hosted-test TypeScript checks passed.
- The restarted Orbit app produced 15 Overview boxes and 23 Flow-highlighted
  elements when switching channels, without diagnostic injection or page errors.
  Screenshots: `/tmp/pyric-orbit-overview-fixed.png` and
  `/tmp/pyric-orbit-flow-fixed.png`.

Orbit remains running on `http://127.0.0.1:5217/`. Reload an already-open page to
install the hook before React. The AI proxy and password issues found during
that diagnosis are resolved in the subsequent verification sections below.

## Direct Node AI upstream verification

Node AI now resolves the configured OpenAI-compatible upstream on the server
and calls it directly. SharedWorker and in-page clients retain the reserved
`/__pyric/ai-proxy` route. Vite's `ai.proxyUpstream` takes precedence over
`PYRIC_AI_PROXY_UPSTREAM`, with local Ollama as the default. Explicit engine URLs
remain explicit. The Node broker receives the host engine/model before the first
client request. Upstream I/O shares streaming and throttled failure diagnostics
with the proxy; the upstream setting is not added to browser init payloads.

Verification completed:

- 55 focused AI configuration, startup, worker, and proxy tests passed in 0.9s.
- Six Node/browser integration checks passed in 4.9s: direct requests without a
  frontend HTTP server, host model precedence, configured and explicit upstream
  streaming, rate-limit diagnostics, and canonical Firebase AI imports through
  Vite in both runtimes. The browser fixtures observed zero proxy requests in
  Node mode and two in SharedWorker mode (ordinary response plus stream).
- CLI production and hosted-test TypeScript checks passed.
- Actual Orbit, using the configured `ornith:9b` Ollama model, answered the prompt
  `Reply with exactly: Hello from Orbit.` with `Hello from Orbit.`. No browser
  proxy request or page error occurred. The temporary browser was closed and
  the model loaded for this check was unloaded afterward to release memory.

This AI check used the runtime chip's existing-user switch. The provider
sign-in/password overwrite was fixed and verified separately below.

## Password and linked-provider preservation

Provider acceptance now links to the existing account instead of reseeding it.
The account keeps its password, claims, verification and disabled flags,
creation time, and stored tenant metadata. A provider sign-in identifies the
provider actually used in its token. Session tenants remain per connection;
tenant-scoped Security Rules continue to enforce their boundaries.

Auth persistence now includes all linked providers. New passwordless-account
exports omit the password. Import recognizes the two older provider-placeholder
values as absence of a password, unless the record explicitly has a password
provider. Existing seed replacement semantics are unchanged.

Verification:

- 399 Auth/foundation tests, 78 worker/init tests, and 22 state-store/session
  tests passed. All three groups completed in under one second each.
- Two real-browser lifecycle checks passed in 7.9s, one for each host. Each
  checked original password → Google sign-in → original password, then password
  change → Google sign-in → changed password, rejection of the old password,
  persistence of both providers after a fresh browser and server restart, and
  allowed/denied tenant-scoped writes.
- Pyric, CLI, and hosted-test TypeScript checks passed.
- Actual Orbit passed password login → Google sign-in as David → password login,
  and the sequence passed again after restarting the Node host.

Before repairing the demo account, the state file was backed up to
`examples/teams-workspace/.pyric/state/state.before-password-repair-20260916T093721Z.json`
with owner-only permissions. The account-update API restored David's known
`orbit-demo` password and linked the password provider. Other account fields,
other accounts, document shards, and Storage records were verified unchanged by
that repair. No seed reset was performed. Temporary verification browsers and
servers were closed; Orbit remains available at http://127.0.0.1:5217/.
