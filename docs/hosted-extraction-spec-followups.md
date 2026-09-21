# Extraction specification: transport and host follow-ups

Written 2026-09-21 after the host slice merged as `main` `40d1cd35`. Same method as `docs/hosted-extraction-spec-host.md`; read that first. This document states the boundary and the differences only.

## What the slice is

The fixes that closed after the transport and host slices were cut, applied onto a branch from `main`: C1 (a reconnecting page restores its RTDB, presence, and event-stream observations), C2 (a subscription is pinned to the attached consumer), C4 (an errored relayed subscription closes under its logical session), C7 (a synchronous worker forwarding failure becomes a failed result addressed to the request), C8 (a peer reply without a usable id is discarded alone, with a payload-free diagnostic), C12 (a reset re-deploys the active RTDB rules), and the contract text for the shared 24 MiB socket backlog (ledger D3).

It is a two-argument tree difference, `git diff origin/main origin/hosted-main-integration -- <paths>`, for:

```
packages/cli/src/
packages/cli/test/serve/
packages/cli/test/bridge/
docs/hosted-persistence-contract.md
```

At shared tip `5ae77538` against `main` `40d1cd35` that is 8 source files (`bridge/server/{bridge,logger,peer,standalone}.ts`, `serve/worker/client/{core,websocket-connection}.ts`, `serve/worker/host/{rules,studio}.ts`), 3 added ledger tests, 3 modified tests, and the contract page. `packages/cli/test/cli/` and `packages/cli/test/remote/` have no difference and need no path.

## Excluded, with where each goes

| Path | Destination |
| --- | --- |
| `packages/pyric/` (the bounded engine event log, I16) | Its own slice, `slice/event-log-bound`, cut and proven by the reviewer. Do not include it here. |
| `packages/cli/test/e2e/` and `packages/cli/test/manual/` | Acceptance slice, phase 4. This holds the browser acceptances for C1, ledger D3, I16, and I17, so those four cannot run on this slice. |
| `packages/cli/scripts/check-browser-boundaries*` | Evidence slice. |
| Everything outside `packages/cli` other than the contract page | As in the host spec's exclusion table. |

## Acceptance map

Take the shared branch's `scripts/ledger-acceptance.json` and keep only the entries whose test files exist on the slice. Expect to drop C1, D3, I16, I16-core, I17, and `hosted-runtime-contract`; list exactly what you dropped in the submission. C1's fix is still covered on the slice at unit level by `test/serve/worker/disconnect.test.ts`; its browser proof stays on the shared branch until phase 4.

## Steps

1. `git fetch origin main hosted-main-integration`, then `git checkout -b slice/followups origin/main`. Confirm `origin/main` is `40d1cd35` or later by reading it, not by assuming.
2. Write the tree difference for the four paths to a file, apply it with `git apply --index`, and commit as `fix(serve): restore observations after reconnect, isolate consumers, and contain malformed peer replies`.
3. Add the handoff documents and the runner with `git show` (ledger, release plan, the extraction specs, `scripts/verify-ledger.ts`, the restricted map). Commit as `docs(hosted): handoff for the follow-up slice`.
4. Prove, running every command to the end and reporting all failures together: `bun install --frozen-lockfile`; `bash scripts/build.sh --packages-only`; `bun run --cwd packages/cli typecheck`; `bun run --cwd packages/studio typecheck`; `bun scripts/verify-ledger.ts --all`; `bun test --cwd packages/cli`; `bun run tool:parity:check`; `bash scripts/ci/conformance-coupling-gate.sh` (expect no engine change); `bash scripts/ci/conformance-gates.sh`; `bun run test:ci:libraries:core`; `bun run --cwd packages/cli test:app-conformance` and `bun run --cwd packages/cli test:identity-conformance` (the same CI job runs both; the first version of this list named only the first, and the popup sign-in spec that later hung on `main` lives in the second).
5. Submit in the standard block with `git diff --stat origin/main`, the byte-equality check of commit 1 against the tree difference, and the list of dropped map entries. Mark the push and pull request `Needs: owner`.

## Standing rule added after this slice's delay

Before acting on any instruction that names a pull request's state ("hold until it merges", "cut after it merges"), read the state with `gh pr view <number> --json state,mergedAt`. The reviewer issued a hold on pull request 656 about a day after it had merged, and neither agent checked.
