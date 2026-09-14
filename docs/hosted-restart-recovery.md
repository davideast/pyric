# Hosted app recovery after a host restart

Restarting the Node host previously left existing app pages permanently disconnected. Persisted data survived and fresh pages worked, but existing SDK writes failed with `The hosted sandbox connection is closed.`

Resume grants belong to a host process. The browser now includes the issuing process identity during admission. A replacement process grants a new session; the client verifies the project identity and restores app configuration and Auth before restoring observers and accepting operations. This reuses the existing sandbox `auth.restorePortSession` operation and client subscription registry.

The client rejects operations during interruption/restoration. It does not replay uncertain writes. A missing or malformed process identity cannot turn an invalid resume grant into fresh admission. Invalid grants for the current process remain refused. Deleted users restore as signed out and cannot write through their old authority. SharedWorker remains the default.

## Verification

The original normal-SDK/process-restart regression failed twice, in 13.3 and 13.0 seconds, with the reported closed-connection error. Its first unchanged-fixture green completed in 6.2 seconds including runner overhead. Review added tenant/claims/Rules and deleted-user checks. A separate malformed-identity admission test failed before the guard correction and passed afterward with the same fixture.

Final checks against the repaired implementation:

| Check | Result |
| --- | --- |
| Restart, admission, tenant identity, deleted users, socket recovery, lost acknowledgment, app deletion, checkpoint restore and default SharedWorker | 11 passed in 27.0 seconds |
| RTDB connectivity, offline choice, deletion and observers across hosted, SharedWorker and in-page modes | 14 passed in 23.2 seconds |
| Four restart/admission cases on minimum Node 22.15.0 | 4 passed in 14.9 seconds |
| Relay, remote isolation/stress, worker Auth, per-port sessions and cleanup in six isolated processes | 79 passed |
| CLI and hosted fixture TypeScript checks | Passed |
| Code form against the checkpoint commit | Seven TypeScript files, zero findings |
| Browser entry budgets and prohibited dependencies | Socket 7,141/16,384 bytes; worker client 54,943/98,304; RTDB listeners 12,930/32,768; zero findings |

Primary commands, from the repository root:

```sh
bun x playwright test --config packages/cli/test/e2e/hosted/playwright.config.ts host-restart-reconnect.pw.ts reconnect-listener.pw.ts lost-ack.pw.ts delete-during-attach.pw.ts host-persistence-checkpoints.pw.ts
bun x playwright test --config packages/cli/test/e2e/hosted/playwright.config.ts rtdb-connectivity.pw.ts
bun scripts/test-isolated.ts packages/cli/test/bridge/worker-relay.test.ts packages/cli/test/bridge/remote-session-isolation.test.ts packages/cli/test/bridge/remote-session-stress.test.ts packages/cli/test/serve/worker/auth.test.ts packages/cli/test/serve/worker/per-port-sessions.test.ts packages/cli/test/serve/worker/disconnect.test.ts
bun x tsc -p packages/cli/tsconfig.json --pretty false
bun x tsc -p packages/cli/test/e2e/hosted/tsconfig.json --pretty false
bun scripts/check-changed-code-form.ts 4b2ae881496bbe5bd415a3e871a3e4f9532e6033
```

The minimum-Node run invoked the installed `@playwright/test/cli` with Node 22.15.0 directly, so the real host processes inherited that runtime. An initial runner-path lookup failed before any test started; it is not behavioral evidence.

## Manual retest

Restart the demo using the rebuilt CLI, then reload each page once to load the updated browser code. Write a distinct message and keep both pages open. Restart the host again on the same port. Both existing pages should observe subsequent writes without a reload. Checkpoint restoration can then be tested separately.

## Scope and remaining findings

This is a scoped repair on top of checkpoint `4b2ae881`. The broad implementation JSON ledger describes the earlier checkpoint; it is historical evidence, not verification of this repair. This document records the subsequent repair checks. No full hosted/live-mode or release gate is closed here; the full browser suite and copied standalone binary were not rerun.

Recovery after session retention expires in the same process still needs separate work. This change distinguishes a replacement process from the process that issued the grant.

Review also found that an explicit anonymous sign-in can reuse a deleted UID after restart. The failing assertion and fixture are preserved separately in the local QA archive. The reconnect check verifies that automatic recovery leaves the deleted account absent and the app signed out; anonymous UID allocation remains an unfixed Auth issue. Startup restoration counts also remain misleading even when SDK reads confirm restored data.
