# Section 2: recovery and identity

Started 2026-09-15 at `a9538130` on `hosted-live-mode`, following the user's
instruction to begin phase 2. Section 1's automated checks are complete; this
instruction authorises advancing but is not recorded as a manual QA pass.

This section closes hardening queue items 10–11. SharedWorker remains the default,
hosted mode is opt-in, and genuine in-page mode remains supported. Use the approved
S1 application SDK, S2 bridge consumer and S3 CLI lifecycle seams. Keep the manual
demo on port 43110 untouched. No PR, release or new long-running goal is required.

| ID | Completion assertion | State |
| --- | --- | --- |
| I1 | Tenant configuration flows through sign-in, the resulting user, cached/refreshed token claims and Rules enforcement in all three runtimes. Changing the next sign-in tenant cannot alter an existing identity. | Verified for anonymous sign-in, forced refresh, next-tenant configuration and sign-out/sign-in in hosted, SharedWorker and in-page modes. |
| I2 | Independent apps and browser clients retain their own users, tenants and claims when another signs in, switches tenant, refreshes claims or signs out. Allowed and denied Rules operations agree with each client's user/token. | Verified: eight named-app/page scenarios, including hosted restart, with real claim changes and Rules allow/deny checks. |
| R1 | Host restart or fresh admission restores the original valid identity and current claims before listeners and subsequent operations. Deleted/revoked identities are not silently recreated or elevated. | Verified: original tenant/claims before listeners; fresh current claims after revocation; disabled/deleted accounts cannot restore access. |
| R2 | Host session expiry and delayed browser notification are independently controlled; the original app recovers with one listener and authorised new work. Invalid grants remain refused and uncertain mutations never replay. | Verified: independently paused browser, real host expiry, late close delivery, one listener, fresh writes and no uncertain-increment replay; invalid/tampered grants refused. |
| R3 | Identity isolation and sign-out remain correct after recovery; deletion during restoration cannot revive the app. | Verified: both hosted topologies retain independent identity after restart and sign-out; existing deletion/interrupted-restoration cases pass. |
| J | Required assertions pass, affected types/form/regressions and runtime checks pass, verified changes are pushed, and a manual checkpoint is provided. | Verified automated checkpoint; manual procedure provided below. No manual pass claimed. |

Work one observable behaviour at a time. The first slice tests I1 before changing
production. Preserve passing characterisations without inventing a fix. Record a
reproduced failure and unchanged green for each repair. Use targeted checks during
development and one affected integration run at the section join; do not rerun the
entire hosted suite after every edit.

RTDB disconnect semantics, transaction contention, packed-install/version matrices,
slow observation consumers and release acceptance remain in later sections.

## First slice: preserve the signed-in tenant

The three-runtime SDK test reproduced two faults against `a9538130`. Hosted and
SharedWorker mode changed the active session's tenant when `auth.tenantId` changed,
so the current user lost access to its tenant's documents before another sign-in.
In-page mode retained the correct Rules identity but omitted `firebase.tenant`
from both cached and refreshed token claims. The same behaviour assertions pass
after the fix.

Tenant configuration now affects subsequent sign-ins. Token minting uses the
shared `normalizeAuthState` foundation and the signed-in user's tenant. The token
cache distinguishes tenant as well as UID, and reauthentication forwards the
user's tenant when refreshing. A fourth hosted bridge test verifies that two
sessions holding one UID under different tenants retain their own cached tokens.
This is a cache boundary check; it does not close I2's broader client isolation
matrix or establish tenant-scoped account storage.

Final verification passed before pushing this slice:

- 22 affected Playwright scenarios in 43.9 seconds, with no failures, skips or
  flaky results. These cover the four tenant cases, checkpoint claim refresh,
  host restart, interrupted recovery, deletion during recovery and in-page
  token refresh.
- 126 regressions across eight isolated Auth, worker and Admin test files.
- Pyric and CLI production types, strict hosted fixture types, changed-code
  form and whitespace checks.
- Scoped import audit: 1,030 files, no added edges or unresolved imports.
  Browser client budget: 58,456 / 98,304 bytes; live Firestore budget:
  387,843 / 524,288 bytes. Neither report has boundary findings.

Reports and the original failing fixture are retained under
`ignored/section2/tenant-token/`. The final browser command selected
`tenant-token-identity.pw.ts`, `host-restart-reconnect.pw.ts`,
`checkpoint-auth.pw.ts`, `token-refresh-session.pw.ts`,
`interrupted-recovery.pw.ts` and `delete-during-recovery.pw.ts` using the hosted
Playwright configuration and Node 22.15.0. The full hosted suite was not needed
for this bounded change. No registry rows or codec fallback branches changed.

At the first-slice checkpoint, the next work was to reconcile I2 and test clients whose
tenant configuration, token refresh and sign-out occur independently. Follow
that with R2's independently controlled host expiry and delayed browser
notification. R1/R3 still need assertion-by-assertion reconciliation; the passing
recovery fixtures above do not close those rows by themselves. Those rows were open at that checkpoint; the completion review below closes them.
No manual QA result is claimed.


## Completion review: isolation and delayed recovery

Three additional production faults were reproduced and repaired:

1. The in-page account sync channel broadcast and adopted the sender's current
   UID. A second page could become the first page's user and gain its Rules
   access. The channel now shares account records only. Removing session restore,
   sign-out and session-change callbacks also removes their obsolete wiring and
   explanations; account-change debounce and echo suppression remain.
2. After restart, the worker client restored a user under `auth.tenantId`, which
   may have changed since sign-in. Recovery now passes `user.tenantId` explicitly
   while restoring the next-sign-in configuration separately. Both named-app
   and separate-page reproductions failed before this change.
3. Host retention can expire before a sleeping browser observes its disconnect.
   The old client attempted the retired grant and then treated refusal as a
   permanent failure. The host now distinguishes a genuinely issued released
   grant from an unknown/altered grant using a per-host HMAC key. Released grants
   receive close code 4004; invalid grants still receive 1008. On 4004 an existing
   app requests fresh admission and follows the existing Auth/listener restore
   path. No expired session is readmitted, mutation replay is not added, and no
   unbounded tombstone store is introduced.

The isolation matrix covers named apps and separate pages in hosted, native
SharedWorker and genuine in-page modes. Each checks different users, tenants and
claims; a real account-claim change followed by token refresh; allowed and denied
writes; changing next-sign-in tenant; sign-out; and signing in again. Hosted
variants repeat the sequence after restarting the actual host. Separate restart
cases change claims or disable the account while admission is held, proving the
restored user cannot regain revoked access. Existing tests establish deleted-user
refusal, identity-before-listener ordering, interrupted restoration and app deletion.

The delayed-expiry test pauses browser time independently of the host, drops a
committed increment's acknowledgment, closes only the server connection, and
observes the real 60-second host retention expire. It then delivers the delayed
browser close and requires the original UID, one listener, a successful new write,
one increment in stored data and exactly one transmitted increment. Altered valid
resume grants must refuse while the original unaltered grant remains resumable.

Evidence discipline: the first delayed-close harness accidentally suppressed
later admission closes too. One attempted baseline run also used an already-built
fixed host. Both are diagnostic only. The corrected fixture was rerun against a
freshly rebuilt original transport and failed at the expected recovery assertion;
its source is retained with the report. The final uncertain-write review initially
expected plain data at the raw bridge seam; correcting its wire-envelope decoding
required rerunning only that scenario. No production change followed the other
42 passing integration cases. These corrections are retained, not hidden by retries.

Final acceptance is complete for Section 2:

- 43 distinct browser scenarios pass with no accepted skips or retries. The main
  integration run passed 42 cases in 128.4 seconds; after the fixture-only
  wire-decoding correction, the remaining real-expiry case passed in 67.9 seconds.
  Its required host-retention wait accounts for 62 seconds of that run.
- All 96 regressions in ten isolated files pass. Pyric and CLI builds, strict
  hosted fixture types and changed-code form pass. The final form report's
  source digests match the checked files.
- All five declared browser budgets pass: client 58,471 / 98,304; socket
  12,810 / 16,384; RTDB listener 12,969 / 32,768; codec 18,649 / 24,576;
  live Firestore 387,843 / 524,288 bytes.
- The 1,030-file import audit adds one acyclic dependency and reports no
  unresolved imports. No new transport owner, service-specific identity
  normalizer, SDK return shape, Rules algebra or codec fallback was introduced.
  No conformance registry rows changed.
- The report verifier checks the exact 43 accepted scenarios, excludes only the
  explicitly replaced failed expiry attempt, and verifies 6,051 current source,
  emitted artifact, fixture, configuration and checker hashes. Evidence is in
  `ignored/section2/finish/`; `verify.mjs` is the runnable acceptance oracle.

Section 2 closes hardening items 10–11. The next checkpoint is the
[manual verification procedure](hosted-section-two-manual-qa.md), followed by
Section 3's RTDB disconnect semantics and concurrent data operations. SharedWorker
remains the default, hosted remains opt-in, and in-page fallback remains supported.
The original manual demo was untouched. On 2026-09-15, the runnable manual
checkpoint also passed: hosted identity, claims, Rules, restart and listener
checks in Chrome and the Codex in-app browser; SharedWorker and in-page isolation
in paired in-app tabs; and the documented real-expiry fault-injection command.
The procedure records the commands, visible expectations and results. This does
not claim physical laptop sleep, independent browser-engine coverage,
mixed-version compatibility or release acceptance. Section 3 is next.
