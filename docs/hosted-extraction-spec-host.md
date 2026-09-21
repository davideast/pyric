# Extraction specification: host slice

Written 2026-09-19 after the transport slice merged as `main` `bbf30034`. Same method as `docs/hosted-extraction-spec.md` and `docs/hosted-extraction-spec-transport.md`; read those first for the rules. This document states the boundary, the prerequisites that must land first, and the proofs.

## What the slice is

The Node hosted runtime, its SQLite persistence, the CLI commands that drive it (hosted method calls, salvage, serve diagnostics), and the files that wire hosting into the serve path, applied onto a branch cut from `main`. Because `main` now carries the foundation and transport slices, this slice is a direct tree difference between `main` and the shared branch for a fixed set of paths, not a merge-base diff. Use the two-argument form `git diff origin/main origin/hosted-main-integration -- <paths>` everywhere below.

The boundary was established by the reviewer on 2026-09-19 by applying the tree difference for the paths listed here onto `main` `bbf30034`. With the live-mode files present the package builds, both `packages/cli` and `packages/studio` typecheck, every host acceptance item passes, and the serve, cli, bridge, and remote suites are green with no test changed. Without the live-mode files the build fails on two imports of `serve/live/firebase-resolution.js`. That is the only boundary defect, and it is removed by prerequisite 1 rather than by a follower.

Size at the dry run: 82 files, about 4,700 insertions and 950 deletions. The numbers shrink after prerequisite 1.

## Prerequisites, in order

### 1. Ruling D3: remove live mode from the shared branch

Ruled 2026-09-18: `entries/live`, `serve/live`, and every reference leave the branch; live parks on its own branch with gates 7 through 9 open; the emulator-backed tests under `test/e2e/live` are deleted.

On `hosted-main-integration`, in this order:

1. Create `live/parked` at the current shared tip so nothing is lost. Pushing it needs the owner's approval; state that in the submission with `Needs: owner`.
2. Delete `packages/cli/src/serve/live/`, `packages/cli/src/serve/entries/live/`, and `packages/cli/test/e2e/live/`.
3. Remove the live branches from the files that wire it: `serve/bundler.ts` (`defaultSdkEntries({ live })`, `liveProjectRoot`, `firebaseResolvePlugin`), `serve/vite-module-swap.ts` (`isLiveSdkImport`, the `live` option), `serve/vite-plugin.ts`, `serve/sandbox-session.ts`, `cli/serve.ts`, `cli/snapshot.ts`, `serve/namespace.ts`, and `bridge/server/in-process.ts`. Delete the option and every branch on it; do not leave a flag that is always false.
4. Remove the live lines from `scripts/fixtures/cli-release-contract.json` and the live server block from `scripts/packed-resolution-smoke.mjs`.
5. Remove the live scenarios from `packages/site-docs` and the references in `docs/` that describe live as available. The `hosted-sandbox-live-mode-*` evidence documents move to `live/parked` with the code; they are not part of any slice.

Proof: `grep -rn "serve/live\|entries/live\|usesLiveSdk\|liveProjectRoot\|isLiveSdkImport" packages/cli/src packages/cli/test scripts` returns nothing; `bash scripts/build.sh --packages-only`; `bun run --cwd packages/cli typecheck`; `bun test packages/cli/test/serve packages/cli/test/cli`; `bun scripts/verify-ledger.ts --all` with every closed item still passing. Submit as one item in the standard block.

### 2. Ruling D1: revert the undo history in `packages/pyric` on `main`

The foundation slice was cut before the D1 revert (`08828705`), so `main` still carries the durable undo history in the engine: schema additions in `value-codec.ts`, `event-log.ts`, `history-controls.ts`, `local-environment.ts`, `simulator-tools-impl.ts`, and `sandbox/internal/{index,root,sandbox-impl}.ts`, plus two tests. The shared branch's tree for `packages/pyric` differs from `main` by exactly the revert's ten files, and the reviewer confirmed the patch applies cleanly to `main`.

Branch `slice/undo-revert` from `origin/main`. Apply `git diff origin/main origin/hosted-main-integration -- packages/pyric` with `git apply --index`; commit as `revert(sandbox): remove the durable undo history from the engine`. Proof: `bun test packages/pyric`; `bun run --cwd packages/cli typecheck` and `bun test packages/cli/test/serve` on the same branch, because `main`'s cli must compile against the engine without those exports; `bun run --cwd packages/studio typecheck`; `bun run compat:generate` and `compat:validate` produce no diff, then add the `Conformance-Exempt:` trailer commit as the foundation slice did. Open as its own pull request; it is small and the host slice does not depend on it at the tree level, but the release must not ship the undo schema, so it merges before the host slice.

### 3. Host items closed on the shared branch

All of the following closed on 2026-09-20 (C9, C10, D2, D4 at `c6c899ed`; H1, I12, I13, and the support statement at `9c92ce08`), so the slice can be cut from shared tip `d10b47c3` or later. Originally: cut the slice only after these ledger items are closed: C9 (hosted runtime disposes before draining in-flight work), C10 (Service Worker install fails permanently on a transient bridge outage), D2 (close during startup returns success instead of the contracted error), D4 (capture flush deadline), H1 (salvage command verification), I12 (Bun refusal branch test), the remaining I13 sub-items, and the support contract statement that hosted mode requires Node and is unavailable in the standalone binary. Closed already and carried by this slice: A7, I5, I7, I8, I14, C5, C6, C14.

## Paths

Included, as the tree difference between `origin/main` and `origin/hosted-main-integration`:

```
packages/cli/src/
packages/cli/test/serve/
packages/cli/test/cli/
docs/hosted-persistence-contract.md
scripts/fixtures/cli-release-contract.json
```

Correction, 2026-09-20: the first version of this list enumerated source files and was fixed before C10 and the I13 seed fix landed. Those edited `serve/entries/messaging-sw-client.ts` and `serve/state-store.ts`, which the list did not name, so the first extraction attempt failed the C10 acceptance. With live mode removed nothing under `packages/cli/src/` is held back, so the whole directory is taken. At shared tip `343b121d` that is the previously listed files plus those two.

`packages/cli/src/serve/worker/` is included even though the transport slice owned it, because I14 (the typed persistence flush policy) and C5 (Firestore-only listener rebinding) edited worker host files after that slice was cut. The tree difference for the directory is exactly those two fixes plus `operation-persistence.ts`.

Excluded, with where each goes:

| Path | Destination |
| --- | --- |
| `packages/cli/src/serve/live/`, `packages/cli/src/serve/entries/live/`, `packages/cli/test/e2e/live/` | Removed by prerequisite 1; parked on `live/parked` |
| `packages/cli/test/e2e/` (267 added files) and `packages/cli/test/manual/` | Acceptance slice, phase 4 |
| `packages/cli/test/e2e/sdk-flow.pw.ts` (modified) | Studio slice; it asserts the new traffic inspector selectors |
| `packages/cli/scripts/check-browser-boundaries.ts` and its test | Evidence slice, as recorded in the transport spec |
| `scripts/tool-parity.annotations.json` | Not extracted. The shared branch lacks the `messaging_deliveries` annotation `main` gained from the transport pull request; extracting it would delete that entry. Housekeeping: the shared branch should adopt `main`'s file. |
| `scripts/packaging-test.sh`, `scripts/packed-resolution-smoke.mjs`, `scripts/lib/packaging-processes.sh`, `scripts/packaging-processes.test.mjs` | Peel; process-handling hardening unrelated to hosting |
| `.github/workflows/build.yml`, `scripts/check-code-form*.ts`, `scripts/check-changed-code-form*.ts`, `scripts/code-form-exceptions.*`, `scripts/test-isolated*.ts`, `scripts/check-support-contract*.ts` | Peel and evidence slices (the code-form gate is B4; the support contract check is phase 4) |
| `scripts/diagnostics/`, `scripts/hosted-persistence-baseline*.mjs`, `scripts/hosted-multiclient-acceptance.mjs`, `scripts/prepare-hosted-example.mjs`, `packages/playground/scripts/hosted-checkpoint.mjs` | Evidence slice, phase 4 |
| `packages/studio/`, `packages/ui/`, `packages/playground/`, `examples/teams-workspace/` | Studio slice, phase 5 |
| `packages/site-docs/` | Held by ruling D2 until phase 4 passes in CI; `main` has no hosted page, so nothing to remove there |
| `docs/hosted-*` other than the persistence contract, `docs/connection-diagnostics.md`, `docs/node-host-local-example-checkpoint.md`, `docs/worker-ai-traffic-checkpoint.md`, `docs/code-conventions.md`, `docs/decisions/0001-*` | Evidence and peel slices; the review ledger, release plan, and extraction specs ride as handoff documents as before |

Followers: none expected after prerequisite 1. The release-contract fixture then differs from `main` by the `serve diagnostics` command and the `messaging_deliveries` tool only, both of which belong here. `scripts/ledger-acceptance.json` is restricted to the host items listed under prerequisite 3 plus the already-closed ones, as the earlier slices did. Leave out `hosted-runtime-contract`: its test is `scripts/check-support-contract.test.ts`, which belongs to the evidence slice with `docs/hosted-support.json`, so it cannot run here. It stays mapped on the shared branch.

## Steps

1. `git fetch origin main hosted-main-integration` then `git checkout -b slice/host origin/main`.
2. Write the tree difference for the included paths to a file, `git diff origin/main origin/hosted-main-integration -- <paths> > host-slice.patch`, apply it with `git apply --index host-slice.patch`, and commit as `feat(serve): hosted Node runtime, SQLite persistence, and CLI commands`. Do not use `git checkout <ref> -- <path>`; the guard refuses it.
3. Add the handoff documents and the runner with `git show` as in the foundation spec, and restrict `scripts/ledger-acceptance.json`. Commit as `docs(hosted): handoff for the host slice`.
4. Prove: `bun install --frozen-lockfile`, `bash scripts/build.sh --packages-only`, `bun run --cwd packages/cli typecheck`, `bun run --cwd packages/studio typecheck`, `bun scripts/verify-ledger.ts --phase 3` (every item listed there), `bun test packages/cli/test/serve/hosted-sqlite.test.ts` with no skipped case, `bun test packages/cli/test/serve`, `bun test packages/cli/test/cli`, `bun test packages/cli/test/bridge`, `bun test packages/cli/test/remote`. Every one green with no test changed. State the Node version the SQLite fixtures ran under; if a second Node release is installed, run the hosted SQLite suite under it as well and state both, otherwise state that the minimum-version run is owed to the phase 4 CI job.
5. Run the checks the pull request's required CI jobs run, so they do not first fail there. Each of these caught something on an earlier slice that the package suites did not: `bun run tool:parity:check` (the agent tool parity audit), `bash scripts/ci/conformance-coupling-gate.sh` and `bash scripts/ci/conformance-gates.sh`, `bun run test:ci:cli --shard=1/2` and `--shard=2/2` (sharding groups test files differently from a directory run, which is how the served-entry order dependence surfaced), `bun run test:ci:libraries:core`, and `bun run --cwd packages/cli test:app-conformance` and `bun run --cwd packages/cli test:identity-conformance` (the same CI job runs both; the first version of this list named only the first, and the popup sign-in spec that later hung on `main` lives in the second) (Playwright; run `bunx playwright install chromium` in `packages/cli` first if the browser is missing). State each result in the submission. Linux file ordering still cannot be reproduced on macOS; a failure that appears only in CI is reproduced by importing the shard's test files in CI's order from one driver file.
6. Submit in the standard block, including `git diff --stat origin/main`, and mark the push and pull request `Needs: owner`.

## What the reviewer checks

- Commit 1 equals the tree difference for exactly the included paths, byte for byte, against the shared tip named in the submission.
- No file outside the included paths, the handoff documents, and the two scripts is present.
- Every proof command reproduces on the reviewer's machine after a dist rebuild.
- CI: the engine coupling gate is not triggered (no `packages/pyric` change); the agent tool parity audit passes without a manifest change; the served-app conformance job passes.
