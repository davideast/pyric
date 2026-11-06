# Production oracle: SDK behavior against a real database

Some truth lives in the SDK and the backend's delivery path, not in a rules
verdict: a listener cancelled after a write revokes its read, a transaction's
retries, offline pending writes, an error raised client-side, onDisconnect
timing. The rules oracles cannot answer these. The referee is the bare upstream
`firebase` SDK, driven against a real database in the dedicated oracle project
with rules deployed for the probe.

The committed answers are `packages/conformance/observations/firestore/`,
`observations/rtdb/` and `observations/rtdb-modular/`. Check them before any
capture: an observation can refute a confident hunter.

## Which runner produced what

| Observations | Runner | Rig manifest |
|---|---|---|
| `firestore-*`, `rtdb-*`, `rtdb-modular-*`, `auth-*`, `storage-*` from the main probe list | `packages/conformance/src/run.ts` (the `probes` array) | `rigs/oracle-run.ts` |
| `rtdb-modular-*` climb probes (three of them, listener cancellation, query index enforcement and deploy refusals, deploy their own rules) | `src/capture/rtdb-climb/<name>.probe.ts`, loaded by `run.ts` | `rigs/oracle-run.ts` |
| onDisconnect and abrupt-disconnect `rtdb-modular-*` | `src/capture/rtdb-disconnect/probes.ts`, loaded by `run.ts` | `rigs/oracle-run.ts` |
| `firestore-transaction-contention-retries`, `firestore-browser-lifecycle` (real Chromium), `firestore-collection-group-listener`, and `rules-firestore-get-after-and-exists-after` | `packages/conformance/src/run-firestore-real.ts` | none |
| Firestore `request.resource.data` for client writes | `packages/conformance/src/run-firestore-write-request-resource.ts` | none |
| `admin-firestore-*` | `packages/conformance/src/admin-firestore-probes.ts` | `rigs/admin-firestore.ts` |
| SDK behavior scenarios: `firestore-*` and `rtdb-modular-*` from the 2026-10-27 hunt on | `packages/conformance/src/run-sdk-scenarios.ts`, one `src/capture/sdk-scenarios/<service>/<name>.scenario.ts` per observation | none (its prefixes belong to `rigs/oracle-run.ts`) |

Each rig manifest in `packages/conformance/rigs/` states the runner's env,
project setup, what it writes and how it cleans up. Read it, and the runner's
header, before the first capture.

## `run.ts`: the main SDK probe list

Before an RTDB capture, run the readiness check
(`PYRIC_ORACLE_FIREBASE_CONFIG=... bun run packages/conformance/src/check-rtdb-preflight.ts`):
it confirms the web config has a `databaseURL`, anonymous sign-in is enabled,
and the oracle namespace is writable, and exits 1 with a remediation per
failure.

```sh
# one probe (or every probe whose name contains the substring)
PYRIC_ORACLE_PROJECT_ID=<oracle project id> \
  bun run packages/conformance/src/run.ts rtdb-modular-listener-cancellation
```

- Always pass a probe name. Arguments are name substrings; with none, every
  probe runs and every observation file it owns is rewritten.
- There is no inert preview. With neither credential set it uses Application
  Default Credentials and throws without `PYRIC_ORACLE_PROJECT_ID`. A key file
  (`PYRIC_ORACLE_SA_PATH`), when one is used, stays outside the checkout.
- Use the oracle credential, not `PYRIC_ORACLE_FIREBASE_CONFIG`, for RTDB
  work, and leave the config unset. The climb and disconnect probes are only
  added to the list when a service account mints the database admin token.
  When the config is set, it wins even if the service account is set too
  (`loadConfig` in `run.ts` returns early), and those probes silently drop
  out. The weekly re-capture (`.github/workflows/oracle-recapture.yml`) runs
  that way.
- With a service account, the run merges the oracle namespace into the
  project's Firestore and Storage rules and restores them; a clean run prints
  `the project's Firestore and Storage rules are restored and verified`. It
  also merges the oracle namespace into the RTDB rules and does not restore
  that merge (`packages/conformance/docs/oracle-project-setup.md`).
- A climb probe that needs its own rules writes them to `/.settings/rules.json`
  with the admin token and restores them itself; follow
  `src/capture/rtdb-climb/listener-cancellation.probe.ts` for a new one. Each
  `*.probe.ts` file in that directory is picked up by name, with no list to
  edit.
- `bun run packages/conformance/src/capture/rtdb-disconnect/preflight.ts` (with
  the oracle credential) checks access before an onDisconnect capture: rules
  backup, an anonymous write, read and remove, and a rules restore read back.

## `run-firestore-real.ts`: Firestore with probe rules deployed

```sh
PYRIC_ORACLE_PROJECT_ID=<oracle project id> \
  bun run packages/conformance/src/run-firestore-real.ts --collection-group-listener
```

- Inert without `PYRIC_ORACLE_SA_PATH` or `PYRIC_ORACLE_PROJECT_ID`.
- It snapshots the Firestore release, deploys a probe ruleset, runs the
  probes, and restores the release in a `finally` path. With no flag it
  captures transaction contention and the Chromium lifecycle (which also
  rewrites the `getAfter` rules observation);
  `--browser-only` re-captures only the lifecycle;
  `--collection-group-listener` captures only that listener.
- It prints no restore line. After every run, read the Firestore release back
  and confirm it points at the ruleset it pointed at before, and that the run's
  documents are gone.
- It takes a lock at `/tmp/pyric-firestore-real.lock`. A second run does not
  wait: it fails fast with "another ... probe is already running (pid N)".

`run-firestore-write-request-resource.ts` follows the same pattern: inert
without `PYRIC_ORACLE_SA_PATH` or `PYRIC_ORACLE_PROJECT_ID`, a temporary probe ruleset, the prior release
restored in a `finally` path.

## After the capture

- The observation lands under `observations/<surface>/` and changes only by
  re-capture. Capture in a scratch worktree
  ([SKILL.md](../SKILL.md#captures-run-in-a-scratch-worktree)) and copy back
  only the files your probe owns; whatever else a broad run rewrote is removed
  with the scratch tree.
- The replay tests hold pyric to it: `packages/pyric/test/firestore/oracle-conformance.test.ts`
  and `packages/pyric/test/database/oracle-conformance.test.ts`. A
  disagreement is pinned there, with both sides, before any fix.
- Add or extend the registry row in the same change as a delta file in the
  service's count directory, `assurance-node-counts/<service>/<pr-number>.json`
  (AGENTS.md boundary 6). Every `rtdb-modular` row needs a CDD
  assertion as well.

## `run-sdk-scenarios.ts`: one scenario, two referees

```sh
PYRIC_ORACLE_PROJECT_ID=<oracle project id> PYRIC_ORACLE_FIREBASE_CONFIG='<web config json>' \
PYRIC_ORACLE_RTDB_URL=https://<dedicated-instance>.firebaseio.com \
  bun run packages/conformance/src/run-sdk-scenarios.ts <observation-name>
```

- A scenario file drives the modular SDK through an injected module, so the
  runner passes `firebase/firestore` or `firebase/database` and the pyric
  suites pass `pyric/firestore`, `pyric/database` or the served worker client
  through the same code. A new SDK question is a new scenario file; the
  directory is the index.
- Inert without names or credentials: it prints the scenario list.
- Firestore deploys nothing and deletes the run tree with the admin SDK. RTDB
  runs only against `PYRIC_ORACLE_RTDB_URL`, refuses a default instance,
  merges the scenario's rules under the run's path in the oracle namespace, and restores the
  exact rules text in a `finally` path, printing `rules restored: true`.
- The replays live in `packages/pyric/test/firestore/oracle-captures/`,
  `packages/pyric/test/database/cdd/capture-*.test.ts` and
  `packages/cli/test/serve/worker/oracle-captures/`. A pin names its finding
  and both answers (`replay-comparison.ts`).

## What is missing

- **Scenarios cover only the SDK hunt's captures.** Older SDK questions are
  hand-written probes in `run.ts`, `rtdb-climb/*.probe.ts`, or a mode in
  `run-firestore-real.ts`.
- **No Firestore climb directory.** Firestore probes that deploy their own
  rules all live in `run-firestore-real.ts`, selected by flag, not by name.
- **No preview for `run.ts`.** It cannot list what it would capture without
  credentials.
- **Three Firestore observations have no probe in the tree:**
  `firestore-limittolast-preconditions`, `firestore-startat-snapshot-implicit-name`
  and `firestore-updatedoc-dotpath-fieldpath`, captured before the public
  history began. Re-capturing them needs a probe added to `run.ts`.
- `run-firestore-real.ts` and `run-firestore-write-request-resource.ts` have no
  rig manifest, so `rigs/` does not list their env or cleanup.
