# Combined hosted hardening verification

**Latest acceptance, 2026-09-17:** after incremental persistence and capture
scheduling fixes, the [full sustained run](hosted-capture-delivery.md) completed
90,000 writes with zero refusals, worst-window p95 276 ms and maximum capture
delay 1,409 ms. Overall acceptance remains open for history-count coverage and
the stalled-reader close-code check, plus the previously failing 192 MiB
RSS-growth gate. The report below records the earlier 2026-09-15 verification;
it is not the latest verdict.

**Verification and handoff are complete. The hardening milestone remains blocked
by one memory-budget failure.** Verification started at `1beafaba` on
`hosted-live-mode`, 2026-09-15. This pass repaired a diagnostic-ordering regression
and a test-fixture port assumption. It did not publish packages or open a PR.

## Current acceptance

| Hardening queue | Canonical record | Current result |
| --- | --- | --- |
| 1–7: identities, persistence, replacement and recovery | [Original queue](hosted-hardening-progress.md) | Verified within the documented scope; 48 additional persistence cases pass. |
| 8–9: request bounds and lifecycle | [Section 1](hosted-section-one-results.md) | Verified, including the repaired malformed-reply path. |
| 10–11: delayed recovery and identity isolation | [Section 2](hosted-section-two-progress.md) | Verified; affected identity/recovery checks repeated after repair. |
| 12–13: RTDB disconnect and concurrent writes | [Section 3](hosted-section-three-progress.md) | Verified; affected normal-operation checks repeated after repair. |
| 14–15: installed packages and admission | [Section 4](hosted-section-four-progress.md) | Eleven final installed cases pass, including Vite HMR and warm restart. |
| 16: slow-client isolation and bounds | [Section 5](hosted-section-five-progress.md) | **Open: host RSS exceeds the declared 192 MiB growth budget intermittently.** Output refusal and latency pass. |
| 17: Rules hot reload | [Section 5](hosted-section-five-progress.md) | Verified in hosted, SharedWorker and in-page modes. |
| 18–19: compatibility and diagnostics | [Section 6](hosted-section-six-progress.md) | Actual-version checks and final diagnostics/Studio checks pass. |
| 20: combined verification and handoff | This report | Complete assessment and handoff; no clean milestone verdict. |

## Immediate next task: resolve the existing memory budget

The unchanged `section-five-slow-client.pw.ts` sends up to 192 replacements of
one 256 KiB document per cycle while an event reader is paused. It requires two
fill/drain cycles, a 24 MiB output cutoff, p95 writes below one second, maximum
write latency below two seconds, and host RSS growth below 192 MiB.

The final stable-artifact run measured **243,433,472 bytes (232.2 MiB)** RSS
growth in its first cycle, exceeding **201,326,592 bytes (192 MiB)**. Its p95 was
83.4 ms, maximum 105.5 ms, and the stalled reader closed with the correct 1013
reason. Eight neighboring diagnostic/Studio cases passed.

Two isolated repeats then produced **one pass and one failure**. The passing run
grew by 167.2/169.0 MiB over its two cycles; the failing run measured
**217,530,368 bytes (207.5 MiB)**. A passing repeat does not close this gate.
The earlier broad run passed under substantially different machine load; that
result cannot override the final failures. RSS includes allocator/GC behavior,
so these samples do not by themselves identify a leak or its owner.

Reproduce from the repository root:

```sh
/tmp/node-v22.15.0-darwin-arm64/bin/node node_modules/@playwright/test/cli.js test \
  -c packages/cli/test/e2e/hosted/playwright.config.ts \
  section-five-slow-client.pw.ts --repeat-each=2
```

Next, attribute the retained memory under this same workload: compare heap,
external/buffer memory and retained observation, undo and socket owners at each
cycle boundary. Distinguish reachable retained state from delayed collection.
Preserve the current workload, latency assertions and threshold while diagnosing;
do not hide the failure with retries or a higher limit. Section 5 already
excludes a general bound on direct SDK/Firestore undo history, but that does not
waive this declared process-memory budget. Close this bounded gate before the
larger 6B soak. No new long-running goal was created.

## Repair found during the combined run

The original 300-case run passed 299 cases and failed the hosted malformed-reply
envelope case. A `null` reply stranded a public SDK read and threw while reading
`.t`: the phase-six diagnostic hook inspected fields before the existing shared
receiver could validate them. A one-null-message minimization reproduced it.

The three-line repair reuses the existing envelope and reply-outcome validators
before inspecting diagnostics. Every response still reaches the existing
receiver, which owns rejection and cleanup. No new schema, queue, transport,
retry policy or SDK shape was introduced. The original regression is unchanged;
the minimized fixture is archived locally. Eleven focused reply checks pass.

The subsequent affected group passed 74 cases and hit one startup error while
a generated asset directory was being corrected. That error was an ENOENT before
the test action; the unchanged four-case depth group then passed against stable
assets. The emitted runtime stayed fixed during the original broad run. Failed
runs remain in the evidence rather than being relabeled as passes.

The Vite fixture also assumed its default port 5173 was free. Three installed
cases refused startup when it was occupied. The fixture now allows Vite to choose
an available port when none is requested; explicitly requested warm-restart ports
remain strict. The original installed assertions pass, and the unrelated server
was left untouched.

## Verification evidence

- **349 distinct browser cases accepted; one memory case remains blocked**, after
  reconciling the original 300-case audit, 48 persistence cases and affected
  repair checks. This is an evidence union, not a claim that one clean run passed
  350 tests. No automatic retries or skipped cases count as passing evidence.
- **730 regressions in 74 isolated files** pass; 29 affected connection/Studio
  regressions were repeated after repair and pass. Repeats are not added to the
  unique count.
- **307 changed TypeScript files** have zero unapproved code-form findings against
  `6b0728b8`; the same five exact legacy SDK casts remain documented exceptions.
  Production/fixture types and the edited JavaScript fixture's syntax pass.
- The scoped CLI/Pyric graph covers **1,034 files and 122 added edges**, with no
  new cycles or unresolved imports. Studio reuses the browser client; that client
  has no Studio dependency. Third-party/computed imports are outside this graph.
- Five browser checks pass: client **58,471/98,304 bytes**, socket
  **13,186/16,384**, RTDB **12,969/32,768**, codec **18,649/24,576**, live Firestore
  **387,843/524,288**. No prohibited engine/host imports were found.
- Final isolated package checks: **11 runtime/admission cases in 21.7 seconds**,
  **three actual-version cases in 5.2 seconds**. Candidate and published alpha.19
  remote clients pass the declared subset; the actual older host refuses the
  candidate browser before writes. This is not a blanket compatibility promise.
- Rebuilt, copied macOS standalone: **four SDK/ownership/MCP cases in 15 seconds**.
- Final candidate **5,721 package files** match their tarballs byte for byte;
  published **3,689 files** retain their verified original identity. Final CLI,
  Studio and mounted Astro assets were rebuilt. An initial npm-cache permission
  error was resolved with a temporary cache; a wrong generated staging directory
  was corrected before final package acceptance. Superseded package runs and
  setup failures are excluded.

The main run took 21.9 minutes, including real retention/deadline waits and high
machine load; the 48-case persistence group took 4.7 minutes. This is not a
performance baseline. The repair used an affected selection rather than repeating
the full 300-case audit. Exact commands, reports, the impact map and input hashes
are under `ignored/milestone-final/`. Those ignored artifacts remain local; this
committed summary is the remote record.

## Final installed candidate identities

| Package | Version | SHA-256 |
| --- | --- | --- |
| pyric | 0.1.0-alpha.22 | `ee3a20fe0fc956deb1f9cf1add40fdccd2a0f4fedccc5aa122e48676ea9ac1d2` |
| pyric-admin | 0.1.0-alpha.22 | `bdb219d747779f7f6660c8a3bdf18d42ee1f714d26b95e374e2dac7f70c8579f` |
| @pyric/cli | 0.1.0-alpha.20 | `58e5ddadd29f2521a1053760016d1dda49d3d93101a4aef522683d65e95a57c9` |
| create-pyric | 0.1.0-alpha.22 | `8d5d93ebf8fc93709a71acc726d8e265becb476038741863b71fa002b2187d92` |

The latest installation is recorded in `ignored/milestone-final/consumer-dir.txt`
and `ignored/section6/consumer-dir.txt`. Pre-repair tarballs were preserved
separately; matching version labels do not mean identical candidate bytes.

## Manual evidence and broader release boundaries

The [phase-six manual checkpoint](hosted-section-six-manual-qa.md) passed in the
in-app browser before this diagnostic guard repair, including actual upload
selection, connection loss, permission repair and invalid-state restoration.
Normal diagnostics and Studio behavior were rechecked automatically on the final
artifact. No new phone/Tailscale or independent browser-engine pass is claimed.
Existing demos, Tailscale routes and the pre-existing `.unlazy/` directory were
left untouched. Temporary verification fixtures use their own shutdown cleanup.

SharedWorker remains the default, hosted is opt-in, and in-page mode remains
supported. The original [release gates](hosted-sandbox-live-mode-gates.md) remain
separate: the full 6B sustained workload, live recording/non-interference and
real upstream credential/tenant acceptance (7–9), and supported platform,
package-manager and browser matrices plus required CI. Cross-service crash
atomicity/concurrent capture claims remain limited to the tested contracts.
Do not start those broader investigations in place of the concrete RSS blocker.
