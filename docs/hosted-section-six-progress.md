# Section 6: compatibility and fault diagnostics

Started from `3137f6d3`. Scope is hardening items 18–19 through the already
approved S1 SDK, S2 wire, S3 CLI lifecycle and existing diagnostic surfaces. The observed Studio gap and its S5 integration
plus the S6 code-form gate are included in this section.
Preserve hosted opt-in, default SharedWorker and in-page fallback. Existing
manual demos and Tailscale routes stay untouched. No PR or production action.

## Acceptance gates

| Gate | Required evidence | State |
| --- | --- | --- |
| V1 | Record the actual compatibility contract and pinned artifact identities before testing. | Verified |
| V2 | Actual isolated compatible consumers pass Auth, write/listener and reconnect checks; unsupported hosted combinations refuse before mutation/fallback. | Verified |
| D1 | Connection, restoration and persistence faults identify runtime/stage and agree with SDK outcomes. Recovery removes stale current failure state. | Verified |
| D2 | Recognizable credential/private-data markers do not appear in default diagnostic/support output. | Verified |
| J | Focused regressions, applicable runtime parity, types/form/build/budgets, installed artifacts, manual checkpoint and pushed evidence. | Verified |

## Compatibility policy under test

Bridge protocol 1 is the current wire contract. Browser SDK modules are supplied
by their serving CLI build, with worker epochs handling a changed served build;
there is no existing blanket semver compatibility promise. The public Node
remote client uses protocol 1 and currently warns, rather than refuses, when the
CLI package stamps differ. We will characterize the candidate pair and the
published `@pyric/cli@0.1.0-alpha.19` remote consumer against the candidate host.
This establishes the tested Auth/Firestore/listener subset only, not all methods
across an invented version range. Retain each installed dependency version and
tarball hash; equal alpha version labels can identify different local builds.

A published host lacking hosted-mode support is not a supported Node-host
combination. Test a candidate browser against that actual published host rather
than treating a hand-edited version frame as an older package. Existing invalid
protocol/capability tests remain separate defenses and cannot replace artifacts.

## Diagnostic scope

Exercise existing CLI startup/error text, public runtime status/chip and Studio
attachment diagnostics. Explicit data-inspection tools, captures, and SDK data
results are not default support output. Deliberate Rules denials remain recorded
history; they must not be confused with a current connection/persistence failure.
Use disposable state and recognizable secret/private-data markers. No new
telemetry system or generic logging framework is planned.

## Results and bounded scope

The declared candidate and published alpha.19 remote subset passes. The older
CLI uses `dev`, not `sandbox`; its actual running bridge lacks browser worker
ports. A candidate browser pointed at that bridge refuses before sending any
write and remains in hosted mode. The error now says to upgrade @pyric/cli,
restart with `--hosted`, and reload. The published remote client emits its existing
version warning but passes authenticated writes, listeners and explicit
close/reconnect against the candidate host. No broader version range is promised.

The Studio walkthrough uncovered a missed integration boundary. Studio opened
its own SharedWorker even when the app selected the Node host. Persisted startup
hydration could conceal this: opening Studio after a write showed a snapshot,
but subsequent writes were absent. Studio now receives the host declaration
before startup and uses the existing hosted transport. It does not register a
competing browser peer. Live Firestore updates, the same Auth account, and
Storage writes reach the same Node host, including when SharedWorker is absent.
Default SharedWorker and in-page application paths remain intact.

Runtime/chip and Studio status now follow connection state. Restart clears the
current connection failure; history retains prior operation errors. Studio hides
stale connected counts and the MCP availability badge while its hosted connection
is unavailable. Persistence errors preserve the distinction between committed
in memory and refused-before-execution. Repairing permissions still requires a
host restart before admitting mutations.

Malformed state-file JSON no longer quotes file contents. Invalid envelope and
controller versions no longer echo arbitrary values; malformed Auth/Storage
records produce bounded recovery guidance. The file is preserved on refusal.
Recognizable password, document and Storage-content markers are absent from the
checked default diagnostic surfaces. Explicit data browsing and exports continue
to return their data. The default startup activation snippet no longer prints the
beacon token; launched children still receive it privately. Separately launched
commands retain interception, but automatic confirmation requires launching the
command through Pyric.

## Code-form and architecture review

The Studio/chip factories exposed a checker limitation: changing one callback
pulled every untouched callback into scope. The checker now reports exact
unchanged nested functions as exclusions, with lexical ownership and function/
class headers included in their identity. Changed callbacks and guards, new
copies, changed headers, suppressions and non-boolean decisions remain checked.
The regression suite exercises these refusals.

Five **pre-existing** Studio foreign-SDK casts remain. U3 explicitly permits
individually recorded and tested foreign-SDK adapters. Their FirestoreApi, Auth,
AuthApi, FirebaseStorage and StorageApi expressions are pinned by exact source
hash in `scripts/code-form-exceptions.json`; the report exposes each exception.
The checker requires the cast to exist in the baseline AST, consume one explicit
exception, and match its path, type and hash. Changed/new/duplicated casts fail.
This preserves the existing UI adapter boundary without adding blanket file
exemptions or pretending those casts disappeared. Studio adapter regressions and
actual hosted Firestore/Auth/Storage UI checks cover the retained boundary.

The only new product modules own the server-stamped hosted target and its Studio
status adapter. They reuse the existing WebSocket transport and Studio runtime
interface. Browser leaves retain their dependency constraints; no SDK operation
module, Rules evaluator, shared value codec or conformance registry changed.

## Verification

- **42 focused browser cases** pass on Node 22.15.0 in 1.6 minutes. The final
  eight phase-six cases pass again after the last diagnostic changes in
  **28.2 seconds**. These are overlapping groups, not 50 distinct cases.
- **14 final installed-package cases** pass: three actual-artifact compatibility
  cases and 11 hosted/SharedWorker/in-page, Vite, admission and recovery cases.
- **126 regressions/checker cases** pass: 69 Studio/state/status/site cases,
  24 launcher/activation cases, and 33 code-form cases.
- CLI, Studio and embedded-site builds, strict CLI/hosted fixture types,
  code form (zero unapproved findings), and whitespace checks pass.
- Browser budgets: client **58,471/98,304**, socket **13,168/16,384**, RTDB
  **12,969/32,768**, codec **18,649/24,576**, live Firestore **387,843/524,288** bytes.
- Normal npm installations outside the repository contain **5,721 candidate**
  and **3,689 published** package files, verified byte-for-byte against their
  tarballs. npm's `prebuild-install` deprecation warning remains; this is not a
  warning-free installation claim.
- The actual in-app walkthrough verified a new app write arriving in an already
  open Studio document, hosted Connected/Reconnecting states, restart recovery,
  and the final removal of stale connected/MCP indicators. Only the two test
  tabs and disposable server on 48771 were closed. Existing demos and Tailscale
  routes remain untouched. Phone testing is not claimed.

Exact logs, red/green failures, package locks, artifact identities and source
hashes are in `ignored/section6/`. The [manual checkpoint](hosted-section-six-manual-qa.md)
contains commands, actions, expected errors and repair steps.

## Final artifact identities (SHA-256)

Candidate CLI `0.1.0-alpha.20`:
`1d0c87ff0265d34049951328d83cbff5196ed700661f541c67af6ea4d35feb3c`.
Candidate `pyric@0.1.0-alpha.22`:
`c9ec8bee0c5bae3c30c80147028c453a15ed7f3db8b1525c708239dee3a282c8`.
Candidate `pyric-admin@0.1.0-alpha.22`:
`afeed7d9b96a50053cd5bd4ea955e44f4caf3ca6f00eb714948791a978eae1d3`.
Candidate `create-pyric@0.1.0-alpha.22`:
`8d5d93ebf8fc93709a71acc726d8e265becb476038741863b71fa002b2187d92`.

Published CLI `0.1.0-alpha.19`:
`d441b0827dc75f03addee25a13845e0548eaeab32fe2df94043b449c20b27b02`.
Published `pyric@0.1.0-alpha.19`:
`ec533290539b8fe356d7f83847f03934c53fc1ee307bb357a7fe414054846746`.
Published `pyric-admin@0.1.0-alpha.19`:
`355b1af7bd34cd9fe413c89a0fc18df74a94745f6d90e3595fa9c61ad114f3d1`.
Published `create-pyric@0.1.0-alpha.19`:
`762dcc04efa3544e2a1b0fedb5ff1be68b304434ebc76c9064ca4b623679b7ec`.

Section 6 closes items 18–19 only. Final combined verification/handoff and the
broader release gates, including the separate 6B workload, remain open. No PR,
publication, deployment or production write is part of this section.
