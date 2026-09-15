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
| I2 | Independent apps and browser clients retain their own users, tenants and claims when another signs in, switches tenant, refreshes claims or signs out. Allowed and denied Rules operations agree with each client's user/token. | Pending; reuse existing fixtures where applicable. |
| R1 | Host restart or fresh admission restores the original valid identity and current claims before listeners and subsequent operations. Deleted/revoked identities are not silently recreated or elevated. | Existing restart/expiry fixtures require identity-specific reconciliation. |
| R2 | Host session expiry and delayed browser notification are independently controlled; the original app recovers with one listener and authorised new work. Invalid grants remain refused and uncertain mutations never replay. | Pending; Section 1 heartbeat tests alone do not establish late notification after host expiry. |
| R3 | Identity isolation and sign-out remain correct after recovery; deletion during restoration cannot revive the app. | Pending; compare recovery-specific assertions with Section 1's completed lifecycle evidence. |
| J | Required assertions pass, affected types/form/regressions and runtime checks pass, verified changes are pushed, and a manual checkpoint is provided. | Pending. |

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

Next: reconcile I2's existing coverage, then test simultaneous clients whose
tenant configuration, token refresh and sign-out occur independently. Follow
that with R2's independently controlled host expiry and delayed browser
notification. R1/R3 still need assertion-by-assertion reconciliation; the passing
recovery fixtures above do not close those rows by themselves. Section 2 remains
open, and no manual QA result is claimed.
