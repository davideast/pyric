# Section 4: installed packages and admission isolation

Started 2026-09-15 at `7b47e2af` on `hosted-live-mode`. Scope is hardening items
14–15 through the approved SDK, bridge and CLI seams. Production behavior already
satisfies the scoped automated checks; this section adds characterization tests,
reusable manual fixtures and runnable commands. No production source changed.

| Gate | Required outcome | State |
| --- | --- | --- |
| P1 | Actual current tarballs install outside the worktree without workspace resolution or links; retain package hashes and commands. | Verified: four normal npm-installed artifacts, 5,701 installed files byte-identical to tar contents. Optional native-build warning recorded below. |
| P2 | Installed served imports complete Auth and SDK write/listener checks in all three runtimes, including reload. | Verified: hosted, default SharedWorker and genuine in-page; cold startup, reload and warm restart. |
| P3 | Installed Vite cold/warm startup, reload and HMR preserve selected runtimes and one listener delivery per new write. | Verified: Vite 5.4.21 with SharedWorker and in-page, preserving Auth identity through HMR. |
| A1 | Existing origin policy refuses untrusted browser origins before state exposure or mutation, while intended clients remain usable. | Verified: installed hosted and Vite browser/socket refusal, HTTP MCP refusal and healthy SDK controls. |
| A2 | Foreign project discovery and invalid host-bound resume credentials refuse before data access/mutation; valid clients continue working. | Verified: foreign beacon, misdirected SDK bridge, foreign resume refusal and issuing-host resume. Changed-host fresh admission remains intentional. |
| J | Applicable minimum-Node, types, form, browser boundaries and regressions pass; reviewed changes are pushed with runnable manual steps. | Automated checks verified; interactive checkpoint loaded, then blocked by the locked Mac. Interactive write/reload/HMR steps remain pending. |

## Verification

All **10 packed browser scenarios passed in 23.4 seconds** on minimum Node
**22.15.0**, one worker, zero skips, failures or retries. They execute the installed
CLI and Vite plugin from an isolated npm consumer, resolve installed package paths
outside the worktree, and use served canonical Firebase imports. The dedicated
Playwright config keeps these opt-in installation tests out of the ordinary
hosted run, where no isolated consumer is configured.

**19 existing regressions passed** in three isolated files: WebSocket upgrade
guard (7), HTTP MCP origin/Host guard (6), and remote session isolation (6).
Pyric, admin and CLI builds, strict fixture types, five-file changed-code form,
fixture JavaScript syntax and whitespace checks passed. Four browser entry checks
against installed package paths have no forbidden dependencies or budget failures:

| Entry | Bytes | Limit |
| --- | ---: | ---: |
| Worker client | 58,471 | 98,304 |
| WebSocket connection | 12,810 | 16,384 |
| RTDB listeners | 12,969 | 32,768 |
| Value codec | 18,649 | 24,576 |

The boundary checker used workspace esbuild 0.28.1 to bundle the installed paths;
the real installed server/Vite scenarios also exercise their own dependency graph.
The unchanged live entry is outside this sandbox checkpoint. No SDK return shape,
Rules evaluator, shared codec fallback implementation or conformance registry row
changed, so no new integration-boundary claim is made for those areas.

## Installation identity

Fresh Pyric/admin/CLI builds and `scripts/pack-packages.sh --skip-build` produced
the tested artifacts. Installation used npm 11.6.2 on Node 22.18.0; execution then
used minimum Node. An initial `--ignore-scripts` diagnostic install was followed
by a successful normal `npm ci --no-audit --no-fund --foreground-scripts` before
the final minimum-Node run. Every installed file in the four tarballs was compared
byte-for-byte with the corresponding installed package.

| Artifact | SHA-256 |
| --- | --- |
| pyric 0.1.0-alpha.22 | `5440b37d64c431ceee47545ff8f800074bb2c4c992d9982fe80a946a36edc8b2` |
| pyric-admin 0.1.0-alpha.22 | `d3bff88cd30a238cb7a543a146245c8bb3800466847db68790232349fb167721` |
| @pyric/cli 0.1.0-alpha.20 | `b00257777bf6898783b2f7e69aa0cb7146e4282bff35398363dba9d9b894ca3d` |
| create-pyric 0.1.0-alpha.22 | `8d5d93ebf8fc93709a71acc726d8e265becb476038741863b71fa002b2187d92` |

Normal installation succeeded while optional `node-liblzma@2.2.0` failed to build
because this Mac lacks `pkg-config`. The lock marks it optional, npm omitted it,
and none of these sandbox paths depended on it. This caveat prevents claiming a
warning-free installation or exercising every optional CLI integration.
`create-pyric` installation is verified; its scaffolding workflow is not exercised.
The separately packed UI package is not part of this consumer proof.

## Admission policy and limits

Origin admission uses a **hostname allowlist**, not strict scheme/port origin
equality. Loopback and explicitly allowed hosts are trusted; non-browser clients
may omit Origin. Untrusted and opaque `null` socket origins are refused before
attachment. WebSocket refusal destroys the socket (observed 1006); HTTP MCP
refusal is 403. The real browser probe serves an untrusted-origin page through a
local test route, with no external site or production Firebase access.

A grant issued by host A cannot resume on host B when B's identity is supplied
(1008). A changed host identity deliberately requests **fresh admission** for
restart recovery, returning a different grant and session. This is not reuse of
A's session and must not be described as blanket refusal of every request that
contains a foreign grant. Copied CLI discovery and an SDK init directed to another
canonical project are separately refused. Healthy clients remain usable.

Vite has no hosted sandbox option in its existing public configuration. Its
supported SharedWorker/in-page matrix and the CLI's three-runtime matrix are
verified without adding a new feature. This is a local-development trust policy,
not authentication against already admitted local developers. Cross-version,
other Vite releases, browser engines and operating systems remain later work.

## Manual checkpoint and diagnostic history

The [manual procedure](hosted-section-four-manual-qa.md) includes exact installation,
server, reload, warm-start, HMR and automated admission commands. The installed
hosted page on **48769** opened in the in-app browser showing `hosted`, an anonymous
UID, `version-one`, `Ready`, one initial update and no runtime errors. The Mac
then locked and automatic unlock failed. Interactive writes/reload/HMR are
**pending**, although the automated suite passed those flows. Earlier manual
projects on 43110, 48765 and 48768 were untouched.

Initial diagnostic failures were fixture/environment issues, not product defects:
repeated identical writes after reload did not warrant a snapshot, so writes now
use distinct UUID messages; socket refusal was initially expected to be HTTP 403
instead of the existing connection close; sandbox port restrictions required
rerunning socket regressions with local binding permission; a nonexistent test
path was replaced with the actual remote-session isolation file. These failed or
unexecuted attempts are excluded from passing counts.

Reports, commands, the consumer lock hash, artifact hashes and 1,112 input-file
fingerprints are retained in `ignored/section4/`. The automated requirements of
items 14–15 are verified. Section 4's interactive checkpoint remains open until
browser control is available. Section 5 covers slow consumers and Rules hot reload
(items 16–17); compatibility, diagnostics and release acceptance remain open.
