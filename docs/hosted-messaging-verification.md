# Messaging recipient and lifecycle verification

Verified on 2026-09-16, before adding Messaging UI to Orbit.

## Behavior

- Token and topic sends reach only matching recipients. Each recipient's own
  visible windows decide foreground versus background delivery.
- Browser identity lives in IndexedDB. Concurrent tabs share an installation;
  separate profiles have distinct installations. Recipient identity also
  includes Firebase app identity and Service Worker scope.
- Explicit Service Worker registration remains selected for subsequent
  `getToken()` and `deleteToken()` calls.
- Tokens, deleted-token state, and topic membership participate in existing
  sandbox persistence. Hosted mutations flush before acknowledgment.
- Hosted reconnect restores Messaging observers and the latest visibility;
  it does not replay sends.
- The Service Worker entry avoids top-level await. Installation and activation
  wait for background observer attachment. SharedWorker relay identity includes
  worker scope, so separate registrations do not replace each other's ports.
- Remote Admin Messaging uses the owning host's broker and persistence.

## Focused checks

Run with Node 22 and built workspace packages. From the repository root:

```sh
bun run --cwd packages/pyric build
bun node_modules/typescript/bin/tsc -p packages/pyric-admin/tsconfig.json
bun node_modules/typescript/bin/tsc -p packages/cli/tsconfig.json
bun run --cwd packages/cli scripts/postbuild.ts

bun test packages/pyric/test/messaging packages/pyric-admin/test/messaging packages/pyric-admin/test/remote/remote-messaging.test.ts packages/cli/test/serve/worker/messaging-ops.test.ts packages/cli/test/serve/worker/messaging-sandbox-deliver.test.ts packages/cli/test/serve/worker/service-worker-relay.test.ts packages/cli/test/serve/worker/persistence-durability.test.ts packages/cli/test/serve/worker/persistence-project-scope.test.ts packages/cli/test/serve/worker/durable-persistence.test.ts

node node_modules/@playwright/test/cli.js test --config packages/cli/test/e2e/hosted/playwright.config.ts messaging-recipients.pw.ts
node node_modules/@playwright/test/cli.js test --config packages/cli/test/e2e/playwright.config.ts messaging-app-boundary.pw.ts --workers=1
```

Results: 189 focused checks passed, 7 existing conformance skips; 6 browser
checks passed in 12.4 seconds; 2 existing app/Service Worker lifecycle checks
passed in 3.4 seconds. Pyric, Admin, and CLI TypeScript compilation passed.
The browser fixtures stop their test servers and close their browser contexts.

The expanded `serve-init.test.ts` run has six existing Traffic-history hydration
failures. An isolated copy using the HEAD version of `serve-init.ts` reproduced
all six (33 passing). They are not Messaging regressions; no history behavior or
conformance registry verdicts were changed here.

## Orbit integration

Orbit now has a Notifications panel, per-user browser opt-in, and a real
Messaging Service Worker. An RTDB Cloud Function reads saved messages and sends
mentions to private recipient tokens through the Admin SDK. Authorship and token
rules are enforced. Sign-out revokes the token; reload restores opt-in.

See `examples/teams-workspace/README.md` for the executable two-profile manual
checkpoint and focused browser-test commands. Tests cover foreground isolation,
background Service Worker delivery, cross-channel navigation, sign-out/account
switching, permission denial, reload, rules boundaries, and SharedWorker delivery
through the Functions bridge. Desktop and 390px phone layouts were inspected.

These checks verify local sandbox delivery. They do not establish production
FCM/Web Push behavior, delivery while the browser is closed, or operating-system
notification display when browser/OS permission is denied. The automated
background check observes a real Service Worker receiving a data message;
visibility changes are supplied deterministically at the browser event boundary.


Orbit results: 5 hosted browser checks passed in 7.1 seconds; the SharedWorker
backend-delivery/reload scenario passed in 4.7 seconds. Mode-specific tests are
explicitly skipped in the other mode. Orbit TypeScript, production build, and
3 existing assistant context checks passed. No temporary browser-test servers
or Functions children remained after the runs. The user-facing Orbit server
and its one Functions child remain running on port 5217.

The Vite SharedWorker Functions startup failure is now recoverable. If the last
browser closes while the child initializes, that failed child stops; the next
sandbox peer connection retries startup. Connections during an in-flight attempt
coalesce into one retry, and closing Vite removes the reconnect listener. A real
browser regression closes the first context during module initialization, opens
a new one, and verifies one RTDB-triggered write and no remaining child processes.
This recovery applies to the Vite plugin; it does not change the standalone CLI
Functions runner's startup-failure policy.

## Tailscale connection correction

The actual HTTPS checkpoint at port 8457 initially loaded HTML but stalled at
“Loading workspace…”. A browser network probe showed sandbox WebSockets dialing
`wss://<tailnet-host>:5217/__pyric/sandbox` and receiving connection refusal.
The bridge URL helper was retaining the server's internal port for its existing
two-server development behavior. Hosted page and Messaging-worker callers now
explicitly use the page origin, preserving the public proxy port. The old
separate-bridge-port behavior remains available for existing callers.

The regression failed before the change and passed afterward (5 URL tests).
CLI TypeScript compilation passed. Fresh browsers then reached sign-in through
both localhost and the actual Tailscale URL; both hosted connections used port
8457 over Tailscale with no socket errors.

Agent diagnostics verified against the running Orbit host: `pyric sandbox
inspect --json` and `pyric sandbox events --limit 5 --json`, run from the example
project directory. These expose sandbox state and operation history. They do not
replace browser network diagnostics when a connection fails before reaching the
host. HTTP 200 alone is insufficient: a connection check must also assert that
application initialization completes.

## Delivery evidence checkpoint

The CLI's `messaging deliveries --json` and attached MCP's read-only
`messaging_deliveries` tool read the same owning broker's retained event stream.
Each entry includes its message and recipient IDs, routing, and browser-reported
acknowledgments (`observerId`, `stage`, sandbox timestamp):

- `received`: the receiver callback boundary was reached.
- `handler-completed` / `handler-rejected`: the callback's returned promise settled.
- `display-requested` / `display-accepted` / `display-rejected`: a native
  `ServiceWorkerRegistration.showNotification()` call was observed.

`handled` retains its old meaning: a broker handler ran, which can mean only that
it forwarded a message to a transport. `receipt: unconfirmed` means no receiver
acknowledgment is retained. It is not a success, a definitive delivery failure,
or a reason to resend. No acknowledgment is replayed after a disconnect.
Display acceptance does not prove an OS banner appeared.

Display correlation requires `tag: payload.messageId` and a display call made
within the background callback's returned promise. Orbit uses that standard
notification option. Other tags or detached asynchronous work leave display
outcome unknown. The observer preserves native rejection and does not capture
titles, bodies or arbitrary errors. Concurrent message tags remain separate.

Each live subscription accepts reports only for its latest 32 delivered message
IDs; reports from other ports, expired entries and removed subscriptions are
refused. Repeated stages are idempotent. Worker display tracking also retains
at most 32 message IDs and releases completed callbacks. Evidence shares the
sandbox's existing history retention and is not durable delivery storage.


## Parallel follow-up verification (2026-09-16)

Delivery acknowledgments, Vite SharedWorker Functions startup recovery, and
packaging smoke-server cleanup were checked in that order. The final focused run
passed 138 tests with 4 existing conformance skips in 2.1 seconds. Three real
browser checks passed in 9.6 seconds: background receipt/display rejection in
both runtimes (including attached MCP and the hosted CLI), and interrupted
SharedWorker Functions startup recovery. Pyric build and CLI TypeScript
compilation passed.

```sh
bun test packages/pyric/test/messaging packages/cli/test/serve/worker/messaging-ops.test.ts packages/cli/test/serve/worker/messaging-display.test.ts packages/cli/test/functions-rtdb/development-runtime.test.ts packages/cli/test/serve/vite-functions-development.test.ts packages/cli/test/bridge/worker-relay.test.ts packages/cli/test/bridge/peer-standby.test.ts packages/cli/test/bridge/tool-families.test.ts packages/cli/test/bridge/tool-parity.test.ts scripts/tool-parity.test.mjs

node node_modules/@playwright/test/cli.js test --config packages/cli/test/e2e/hosted/playwright.config.ts messaging-recipients.pw.ts vite-functions-recovery.pw.ts --grep 'sends only|Functions recovers'

node --test scripts/packaging-processes.test.mjs
```

The packaging gate now uses a unique work directory and owns the smoke server's
process group. EXIT cleanup covers errors and explicit exits; INT, TERM and HUP
preserve the corresponding exit status and trigger cleanup. Teardown allows a
bounded graceful exit, then kills remaining descendants in that group. It does
not kill unrelated processes. SIGKILL cannot run a shell trap.

All 8 process lifecycle checks passed in 3.2 seconds, including a stubborn child,
startup failure and an unrelated process that must survive. These checks also
run at the start of the packaging gate. A separate real hosted-CLI smoke served
`/__pyric/init.json` and left no process in its owned group after teardown. This
is focused cleanup verification, not a rerun of the full packaging release gate.

Actual OS notification display on the user's Android device remains unverified.
Firebase preview deployment and real Web Push implementation remain paused.
