# Extraction specification: transport slice

Written 2026-09-19 after the foundation slice merged as `main` `9ec53e1f`. Same method as `docs/hosted-extraction-spec.md`; read that first for the rules. This document only states the boundary and the differences.

## What the slice is

The `packages/cli` changes for the SharedWorker host, the bridge, the browser entries, the runtime chip, and the remote client, applied onto a branch cut from `main`, minus the hosted runtime, live mode, the CLI commands, the end-to-end suites, and the files that wire hosting into the serve path. One hand-authored follower line is required and is listed below.

Source of truth: `origin/hosted-main-integration` at the tip that includes C13 and A15 closed. Base: `origin/main` at `9ec53e1f` or later.

The boundary was established by the reviewer on 2026-09-19 by applying the full `packages/cli` diff onto `main` and reverting paths until the package typechecked. The result compiles with zero errors and has 203 files, about 8,900 insertions and 2,250 deletions.

## Paths

Apply the branch diff for `packages/cli` and then revert these paths to `main`'s version, in one commit each so the reviewer can check both against the remote:

Excluded source (lands with the host slice, or is removed by ruling D3):

```
packages/cli/src/serve/hosted/
packages/cli/src/serve/live/
packages/cli/src/serve/entries/live/
packages/cli/src/cli/
packages/cli/src/bridge/server/in-process.ts
packages/cli/src/serve/bridge-mount.ts
packages/cli/src/serve/bundler.ts
packages/cli/src/serve/diagnostics.ts
packages/cli/src/serve/namespace.ts
packages/cli/src/serve/sandbox-session.ts
packages/cli/src/serve/vite-module-swap.ts
packages/cli/src/serve/vite-sandbox-generation.ts
packages/cli/src/serve/vite-plugin.ts
packages/cli/src/serve/vite-generation-bridge.ts
packages/cli/src/serve/vite-functions-development.ts
```

Excluded tests (they exercise the excluded source):

```
packages/cli/test/serve/hosted/
packages/cli/test/serve/hosted-sqlite.test.ts
packages/cli/test/serve/fixtures/hosted-sqlite-*.ts
packages/cli/test/serve/diagnostics.test.ts
packages/cli/test/serve/persist.test.ts
packages/cli/test/serve/vite-functions-development.test.ts
packages/cli/test/serve/vite-plugin-integration.test.ts
packages/cli/test/serve/entries/ledger/a7-operation-admission-exhaustive.test.ts
packages/cli/test/cli/
packages/cli/test/e2e/
packages/cli/test/manual/
```

The A7 acceptance moves to the host slice because half of it targets `serve/hosted/persistence-admission.ts`. The A5 acceptance stays; all three of its files are in this slice. `test/serve/diagnostics.test.ts` imports the serve-diagnostics command under `src/cli`, so it moves with the host slice; the reviewer's dry run missed it because it fails at import rather than at an assertion.

Follower, one line, as its own commit named `fix(transport): follow the injectServeTags signature`:

```
packages/cli/src/cli/serve.ts
-      transformHtml: (html) => injectServeTags(html, undefined, workerVersion),
+      transformHtml: (html) => injectServeTags(html, { workerVersion }),
```

`main`'s serve command passes the old three-argument form; A5 changed the signature. Nothing else in `cli/serve.ts` changes.

Second follower, found by the pull request's build job on 2026-09-19 and applied by the reviewer as `fix(transport): audit the messaging inspection tool family`: the agent tool parity audit refuses any bridge factory the manifest does not list. The slice carries the `messaging-inspection` family, so `scripts/tool-parity.mjs` gains the branch's one-line manifest entry and `scripts/tool-parity.annotations.json` records `messaging_deliveries` as a deliberate MCP-only exposure, mirroring the RTDB inspection tools. The source branch never annotated it because no CI ran there. Later slices that add a tool family must include both files.

## Steps

1. `git fetch origin main hosted-main-integration` then `git checkout -b slice/transport origin/main`.
2. Apply `git diff origin/main...origin/hosted-main-integration -- packages/cli` with `git apply --index`; commit as `feat(serve): hosted transport for the worker, bridge, and browser entries`.
3. Produce the reverse diff for every excluded path, `git diff origin/hosted-main-integration origin/main -- <paths>`, apply it with `git apply --index`, and commit as `chore(transport): hold hosted runtime, live, commands, and wiring for later slices`. Do not use `git checkout <ref> -- <path>`; the guard refuses it.
4. Apply the follower line and commit it as named above.
5. Add the handoff documents and the runner with `git show` as in the foundation spec, and restrict `scripts/ledger-acceptance.json` to A5, C13, and A15.
6. Prove: `bun install --frozen-lockfile`, `bash scripts/build.sh --packages-only`, `bun run --cwd packages/cli typecheck`, `bun scripts/verify-ledger.ts --phase 2`, `bun test packages/cli/test/bridge`, `bun test packages/cli/test/remote`, `bun test packages/cli/test/serve`, `bun run --cwd packages/studio typecheck`. Every one green with no test changed.
7. Submit in the standard block, including `git diff --stat origin/main`.

## Ordering with the fixes

C13 and A15 must be closed on `hosted-main-integration` before step 2, or the slice inherits the peer-handshake regression and the remote guidance regression. The reviewer's dry run against the current tip showed exactly those failures and no others: six in `peer-standby.test.ts` and one in `remote/loop-hold.test.ts`.

## Rebase after the foundation merge

The foundation slice was squash-merged, so any branch that carried its two commits must be rebased onto `main` before it is diffed. This slice cuts from `main` directly and needs no rebase. Later slices cut from `slice/transport` will need it after this one merges.

## What the reviewer checks

- Commit 1 equals the remote `packages/cli` diff byte for byte; commit 2 equals the reverse diff for exactly the excluded paths; commit 3 is the one follower line.
- Every proof command reproduces.
- No file outside `packages/cli`, the handoff documents, and the two scripts is present.
