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
PYRIC_ORACLE_SA_PATH=<service-account.json> \
  bun run packages/conformance/src/run.ts rtdb-modular-listener-cancellation
```

- Always pass a probe name. Arguments are name substrings; with none, every
  probe runs and every observation file it owns is rewritten.
- There is no inert preview. With neither credential set it falls back to
  `ignored/service-account.json` in the checkout and throws if that is absent.
  Keep the service account outside the checkout and pass its path by env.
- Use `PYRIC_ORACLE_SA_PATH`, not `PYRIC_ORACLE_FIREBASE_CONFIG`, for RTDB
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
  `PYRIC_ORACLE_SA_PATH`) checks access before an onDisconnect capture: rules
  backup, an anonymous write, read and remove, and a rules restore read back.

## `run-firestore-real.ts`: Firestore with probe rules deployed

```sh
PYRIC_ORACLE_SA_PATH=<service-account.json> \
  bun run packages/conformance/src/run-firestore-real.ts --collection-group-listener
```

- Inert without `PYRIC_ORACLE_SA_PATH`.
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
without `PYRIC_ORACLE_SA_PATH`, a temporary probe ruleset, the prior release
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
- Add or extend the registry row and the service's node count file in the same
  change (AGENTS.md boundary 6). Every `rtdb-modular` row needs a CDD
  assertion as well.

## What is missing

- **No scenario-driven SDK runner.** RTDB rules have a corpus and
  `run-rules-rtdb.ts`; SDK behavior has only hand-written probes. A new SDK
  question means a new probe in `run.ts`, a new `rtdb-climb/*.probe.ts`, or a
  new mode in `run-firestore-real.ts`. In #1247, DF-4, DF-5 and LD-9 waited on
  this.
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
